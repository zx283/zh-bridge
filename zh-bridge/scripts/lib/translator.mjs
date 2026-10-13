// Translation via any OpenAI-compatible chat API (DeepSeek by default).
// Code, inline code, XML-ish tags and Claude Code placeholders are masked
// before sending, so they can never be altered by the translation model.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CACHE_PATH, HOME_DIR } from './config.mjs';

const CJK = /[㐀-䶿一-鿿豈-﫿]/g;

export function hasCJK(text) {
  CJK.lastIndex = 0;
  return typeof text === 'string' && CJK.test(text);
}

/** Share of non-whitespace characters that are CJK (0..1). */
export function cjkRatio(text) {
  const chars = (text || '').replace(/\s+/g, '');
  if (!chars.length) return 0;
  const n = (chars.match(CJK) || []).length;
  return n / chars.length;
}

// ---------- prompts ----------

// Default prompts live in ./prompts/*.txt. If config.prompts.input/output is
// "custom", ~/.zh-bridge/prompts/<same name>.txt is used instead (edit it with /zh).
// {lang} is replaced by the reply language. A fixed rule about placeholders is
// always appended, so a custom prompt can't break code protection.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXED_RULES = `

Non-negotiable: output ONLY the translation. Copy every placeholder like ⟦0⟧ exactly, in the matching position; never translate, drop or renumber them.`;

function loadPrompt(name, cfg) {
  const mode = cfg.prompts?.[name === 'input' ? 'input' : 'output'];
  if (mode === 'custom') {
    try {
      const custom = fs.readFileSync(path.join(HOME_DIR, 'prompts', `${name}.txt`), 'utf8');
      if (custom.trim()) return custom.trim();
    } catch { /* fall back to default */ }
  }
  return fs.readFileSync(path.join(HERE, 'prompts', `${name}.txt`), 'utf8').trim();
}

const systemPrompt = (direction, cfg) =>
  loadPrompt(direction === 'in' ? 'input' : 'output', cfg).replaceAll('{lang}', cfg.target_lang) + FIXED_RULES;

// ---------- masking ----------

const MASKS = [
  /```[\s\S]*?```/g,                      // fenced code
  /~~~[\s\S]*?~~~/g,
  /`[^`\n]+`/g,                           // inline code
  /<\/?[A-Za-z_][\w:-]*(?:\s[^<>\n]*)?\/?>/g, // xml-ish tags (<pasted_content id=...>, <system-reminder>, ...)
  /\[(?:Image|Pasted text|Pasted image)[^\]\n]*\]/g, // Claude Code placeholders
  /https?:\/\/[^\s)>\]]+/g,               // URLs
];

function mask(text) {
  const saved = [];
  let t = text;
  for (const re of MASKS) {
    t = t.replace(re, (m) => { saved.push(m); return `⟦${saved.length - 1}⟧`; });
  }
  return { t, saved };
}

function unmask(t, saved) {
  for (let i = 0; i < saved.length; i++) {
    if (!t.includes(`⟦${i}⟧`)) throw new Error(`translator dropped placeholder ${i}`);
  }
  // Restore in reverse so nested masks (a URL inside a tag) resolve correctly.
  for (let i = saved.length - 1; i >= 0; i--) t = t.split(`⟦${i}⟧`).join(saved[i]);
  return t;
}

// Split masked text into chunks at blank lines (code is already masked, so this never cuts code).
function chunk(t, max) {
  if (t.length <= max) return [t];
  const parts = t.split(/(\n\s*\n)/);
  const out = [];
  let cur = '';
  for (const p of parts) {
    if (cur.length + p.length > max && cur.trim()) { out.push(cur); cur = ''; }
    cur += p;
  }
  if (cur) out.push(cur);
  return out;
}

// ---------- persistent cache ----------
// Same text -> same translation, every time. This keeps the conversation history
// byte-identical across turns, so Anthropic prompt caching keeps working.

const mem = new Map();
let loaded = false;

function loadCache() {
  if (loaded) return;
  loaded = true;
  try {
    for (const line of fs.readFileSync(CACHE_PATH, 'utf8').split('\n')) {
      if (!line) continue;
      try { const { k, v } = JSON.parse(line); mem.set(k, v); } catch { /* skip */ }
    }
  } catch { /* first run */ }
}

export const keyOf = (ns, text) => ns + ':' + crypto.createHash('sha256').update(text).digest('hex').slice(0, 40);

export function cacheGet(k) { loadCache(); return mem.get(k); }

export function cacheSet(k, v) {
  loadCache();
  if (mem.get(k) === v) return;
  mem.set(k, v);
  try {
    fs.mkdirSync(HOME_DIR, { recursive: true });
    fs.appendFileSync(CACHE_PATH, JSON.stringify({ k, v, t: Date.now() }) + '\n');
  } catch { /* cache is best-effort */ }
}

// ---------- API call ----------

async function callModel(system, text, tcfg) {
  if (!tcfg.api_key) throw new Error('no translator api_key configured (~/.zh-bridge/config.json)');
  const url = tcfg.base_url.replace(/\/+$/, '') + '/chat/completions';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), tcfg.timeout_ms || 45000);
  try {
    const r = await fetch(url, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tcfg.api_key}` },
      body: JSON.stringify({
        model: tcfg.model,
        temperature: 0,
        max_tokens: 8192,
        stream: false,
        messages: [{ role: 'system', content: system }, { role: 'user', content: text }],
      }),
    });
    if (!r.ok) throw new Error(`translator HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
    const j = await r.json();
    const choice = j.choices?.[0];
    if (choice?.finish_reason === 'length') throw new Error('translator output truncated');
    const out = choice?.message?.content;
    if (typeof out !== 'string' || !out.trim()) throw new Error('translator returned empty text');
    return out;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Translate `text`. direction: 'in' (-> English) or 'out' (-> cfg.target_lang).
 * Throws on failure; callers fall back to the original text.
 */
export async function translate(text, direction, cfg) {
  const tcfg = cfg.translator;
  const system = systemPrompt(direction, cfg);
  const { t, saved } = mask(text);
  // Nothing translatable left (e.g. all code)? Return as-is.
  if (direction === 'in' && !hasCJK(t)) return text;
  if (direction === 'out' && !/[A-Za-z]/.test(t)) return text;
  const pieces = chunk(t, tcfg.chunk_chars || 3000);
  const done = await Promise.all(pieces.map(async (p) => {
    if (!p.trim()) return p;
    const lead = p.match(/^\s*/)[0];
    const tail = p.match(/\s*$/)[0];
    const out = await callModel(system, p.trim(), tcfg);
    return lead + out.trim() + tail;
  }));
  return unmask(done.join(''), saved);
}
