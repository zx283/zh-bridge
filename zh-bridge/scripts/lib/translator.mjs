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

// The request a reply answers, given to the output translator as context, so it can
// tell a draft meant to stay in English (an email answering an English email) from
// the explanation around it. Long requests are cut to their start and end.
function contextNote(context) {
  let c = (context || '').trim();
  if (!c) return '';
  if (c.length > 2000) c = c.slice(0, 1500) + '\n[…]\n' + c.slice(-500);
  return `\n\nContext only, never translate or output it. The user's request that this reply answers:\n<<<\n${c}\n>>>`;
}

const systemPrompt = (direction, cfg, context) =>
  loadPrompt(direction === 'in' ? 'input' : 'output', cfg).replaceAll('{lang}', cfg.target_lang)
  + (direction === 'out' ? contextNote(context) : '') + FIXED_RULES;

// ---------- masking ----------

const MASKS = [
  /```[\s\S]*?```/g,                      // fenced code
  /~~~[\s\S]*?~~~/g,
  /`[^`\n]+`/g,                           // inline code
  /<\/?[A-Za-z_][\w:-]*(?:\s[^<>\n]*)?\/?>/g, // xml-ish tags (<system-reminder>, <command-args>, ...)
  /\[(?:Image|Pasted text|Pasted image)[^\]\n]*\]/g, // Claude Code placeholders
  /https?:\/\/[^\s)>\]]+/g,               // URLs
];

// Text pasted into the prompt, as Claude Code wraps it.
const PASTE = /<pasted_content(?: id="([^"]*)")?>([\s\S]*?)<\/pasted_content(?: id="\1")?>/g;

function mask(text, direction, cfg) {
  const saved = [];
  const keep = (m) => { saved.push(m); return `⟦${saved.length - 1}⟧`; };
  let t = text;
  if (direction === 'in') {
    // A long paste goes to Claude as it is: Claude reads Chinese fine, and only what
    // the person typed needs translating. A short one is translated with the rest.
    const max = cfg.paste_translate_max_chars ?? 300;
    t = t.replace(PASTE, (m, _id, body) => (!hasCJK(body) || body.trim().length > max ? keep(m) : m));
  }
  for (const re of MASKS) t = t.replace(re, keep);
  if (direction === 'in') t = maskNonChinese(t, keep);
  return { t, saved };
}

// Prompt -> English: lines with no Chinese in them (English already, a quoted email,
// a log) are kept exactly as they are, so only the Chinese is translated.
function maskNonChinese(t, keep) {
  const lines = t.split('\n');
  const out = [];
  let run = [];
  const flush = () => {
    if (!run.length) return;
    let a = 0, b = run.length;
    while (a < b && !run[a].trim()) out.push(run[a++]);           // leading blank lines stay
    const tail = [];
    while (b > a && !run[b - 1].trim()) tail.unshift(run[--b]);   // trailing ones too
    const body = run.slice(a, b);
    if (body.length) {
      const joined = body.join('\n');
      // Keep the line's own indentation outside, so the layout around it survives.
      const lead = joined.match(/^[ \t]*/)[0];
      out.push(/[A-Za-z0-9]/.test(joined) ? lead + keep(joined.slice(lead.length)) : joined);
    }
    out.push(...tail);
    run = [];
  };
  for (const line of lines) {
    if (hasCJK(line)) { flush(); out.push(line); } else run.push(line);
  }
  flush();
  return out.join('\n');
}

function unmask(t, saved) {
  // Newest first: a later mask can hold earlier placeholders (a line kept as it is
  // that has inline code in it), which only appear once it's put back.
  for (let i = saved.length - 1; i >= 0; i--) {
    const ph = `⟦${i}⟧`;
    if (!t.includes(ph)) throw new Error(`translator dropped placeholder ${i}`);
    t = t.split(ph).join(saved[i]);
  }
  return t;
}

/** The part of a prompt that would actually be sent to the translator. */
export function translatablePart(text, cfg) {
  return mask(text, 'in', cfg).t.replace(/⟦\d+⟧/g, '');
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
  const timer = setTimeout(() => ctrl.abort(), tcfg.timeout_ms || 180000);
  try {
    const r = await fetch(url, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tcfg.api_key}` },
      body: JSON.stringify({
        model: tcfg.model,
        temperature: 0,
        // DeepSeek thinks before answering (on by default); leave it room to.
        max_tokens: tcfg.max_tokens || 65536,
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
 * context: for 'out', the request the reply answers (helps keep English drafts English).
 * Throws on failure; callers fall back to the original text.
 */
export async function translate(text, direction, cfg, context = '') {
  const tcfg = cfg.translator;
  const system = systemPrompt(direction, cfg, context);
  const { t, saved } = mask(text, direction, cfg);
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
