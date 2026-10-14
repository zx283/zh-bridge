#!/usr/bin/env node
// zh-bridge proxy: sits between Claude Code and the Anthropic API.
//
//  you (中文) ──► Claude Code ──► [proxy: 中文 → English] ──► Anthropic API
//  you (中文) ◄── Claude Code ◄── [proxy: English → 中文] ◄── Anthropic API
//
// * Your Chinese prompts are replaced with English before Claude sees them.
// * Only the FINAL reply of a turn (stop_reason=end_turn, no tool calls) is
//   translated back. Tool calls, thinking and intermediate steps are untouched.
// * On the next turn, the translated reply that Claude Code sends back as history
//   is swapped back to Claude's original English, so Claude's context stays
//   100% English and byte-stable (prompt caching keeps working).
// * Any translation failure falls back to the original text. The proxy never
//   blocks a request because the translator is down.
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import { loadConfig, HOME_DIR, LOG_PATH, TYPED_PATH } from './lib/config.mjs';
import { translate, hasCJK, cjkRatio, keyOf, cacheGet, cacheSet } from './lib/translator.mjs';

fs.mkdirSync(HOME_DIR, { recursive: true });

function log(...a) {
  const line = `[${new Date().toISOString()}] ${a.join(' ')}\n`;
  try { fs.appendFileSync(LOG_PATH, line); } catch { /* ignore */ }
  if (process.env.ZH_BRIDGE_DEBUG) process.stderr.write(line);
}

const readBody = (req) => new Promise((resolve, reject) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => resolve(Buffer.concat(chunks)));
  req.on('error', reject);
});

// ---------------------------------------------------------------- request rewrite

// Blocks Claude Code injects itself (CLAUDE.md, reminders, ...) are not your prompt.
const SKIP_BLOCK = /^\s*<(system-reminder|local-command-stdout|local-command-stderr|local-command-caveat|bash-stdout|bash-stderr|task-notification)\b/;

const isPromptText = (t) => typeof t === 'string' && t.trim() && !SKIP_BLOCK.test(t);

// Strings Claude itself wrote into tool calls. A scheduled task or /loop run fires
// the prompt Claude stored with CronCreate / ScheduleWakeup, so such a "user"
// message is Claude's own (English) wording, not something the person typed.
function claudeWrittenStrings(messages) {
  const found = new Set();
  const walk = (v) => {
    if (typeof v === 'string') { if (v.trim().length >= 8) found.add(v.trim()); }
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  for (const m of messages) {
    if (m.role === 'assistant' && Array.isArray(m.content)) {
      for (const b of m.content) if (b.type === 'tool_use') walk(b.input);
    }
  }
  return found;
}

/**
 * Text of the most recent message the person actually typed: not tool results,
 * and not a scheduled run re-sending a prompt Claude wrote.
 */
function latestHumanPrompt(messages) {
  const automated = claudeWrittenStrings(messages);
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'user') continue;
    let text = null;
    if (typeof m.content === 'string') text = isPromptText(m.content) ? m.content : null;
    else if (Array.isArray(m.content)) {
      if (m.content.some((b) => b.type === 'tool_result')) continue; // mid-turn: keep looking back
      const texts = m.content.filter((b) => b.type === 'text' && isPromptText(b.text)).map((b) => b.text);
      if (texts.length) text = texts.join('\n');
    }
    if (text === null) continue;
    if (automated.has(text.trim())) continue; // a scheduled run: use the language of what was typed before
    return text;
  }
  return null;
}

// A slash command or skill with text after it (/loop 5m 检查…, /my-skill 帮我…)
// arrives as a <command-args> block plus the command's own instructions with
// that text pasted in. Only the person's text needs translating.
const COMMAND_ARGS = /<command-args>([\s\S]*?)<\/command-args>/;

// The prompts the person typed recently, as the plugin records them (typed.json).
// "Always" translates a reply only when it answers one of these, so Claude Code's
// own requests (compacting, prompt suggestions) are never translated.
function readTyped() {
  try {
    const t = JSON.parse(fs.readFileSync(TYPED_PATH, 'utf8'));
    return Array.isArray(t) ? t.filter((x) => typeof x === 'string' && x.trim()) : [];
  } catch {
    return [];
  }
}

const isTypedByPerson = (prompt) => {
  if (!prompt) return false;
  const p = prompt.trim();
  return readTyped().some((t) => p.includes(t.trim()));
};

// A helper agent (subagent) Claude started: its reply goes back to Claude, never translate it.
function isSubagent(payload) {
  const sys = typeof payload.system === 'string' ? payload.system
    : Array.isArray(payload.system) ? payload.system.map((b) => b?.text || '').join('\n') : '';
  return /You are an agent for Claude Code|built on Anthropic's Claude Agent SDK/.test(sys);
}

async function rewriteRequest(payload, cfg) {
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  // Decide output translation from the ORIGINAL prompt, before we translate it.
  const latest = latestHumanPrompt(messages);
  const latestIsChinese = !!latest && hasCJK(latest);
  const latestIsTyped = latestIsChinese || isTypedByPerson(latest);
  let changed = false;
  const jobs = [];

  // English for `text`, from the cache or the translator; null on failure.
  const english = async (text) => {
    const k = keyOf('in', text);
    const hit = cacheGet(k);
    if (hit !== undefined) return hit;
    try {
      const en = await translate(text, 'in', cfg);
      cacheSet(k, en);
      log('in  translated', text.length, '->', en.length, 'chars');
      return en;
    } catch (e) {
      log('in  FAILED (sent original):', e.message);
      return null;
    }
  };

  const inJob = (text, apply) => {
    if (!cfg.input || !isPromptText(text) || !hasCJK(text) || text.length > cfg.max_input_chars) return;
    jobs.push(english(text).then((en) => { if (en !== null) { apply(en); changed = true; } }));
  };

  // Translate just the command's arguments and swap them into every block of the message.
  const argsJob = (blocks, args) => {
    jobs.push(english(args).then((en) => {
      if (en === null) return;
      for (const b of blocks) {
        if (b.type === 'text' && b.text.includes(args)) { b.text = b.text.split(args).join(en); changed = true; }
      }
    }));
  };

  const restore = (text, apply) => {
    if (typeof text !== 'string' || !hasCJK(text)) return;
    const en = cacheGet(keyOf('out', text.trim()));
    if (en !== undefined) { apply(en); changed = true; }
  };

  for (const m of messages) {
    if (m.role === 'user') {
      if (typeof m.content === 'string') inJob(m.content, (v) => { m.content = v; });
      else if (Array.isArray(m.content)) {
        const argBlock = m.content.find((b) => b.type === 'text' && COMMAND_ARGS.test(b.text));
        const args = argBlock?.text.match(COMMAND_ARGS)[1].trim();
        const hasArgs = cfg.input && !!args && hasCJK(args) && args.length <= cfg.max_input_chars;
        if (hasArgs) argsJob(m.content, args);
        for (const b of m.content) {
          if (b.type !== 'text' || (hasArgs && b.text.includes(args))) continue;
          inJob(b.text, (v) => { b.text = v; });
        }
      }
    } else if (m.role === 'assistant') {
      if (typeof m.content === 'string') restore(m.content, (v) => { m.content = v; });
      else if (Array.isArray(m.content)) {
        for (const b of m.content) if (b.type === 'text') restore(b.text, (v) => { b.text = v; });
      }
    }
  }
  await Promise.all(jobs);
  return { changed, latestIsChinese, latestIsTyped };
}

// ---------------------------------------------------------------- upstream

function upstreamRequest(req, body, cfg, extraHeaders = {}) {
  const base = new URL(cfg.upstream);
  const target = new URL(req.url, base);
  if (base.pathname && base.pathname !== '/') target.pathname = base.pathname.replace(/\/+$/, '') + req.url.split('?')[0];
  const headers = { ...req.headers, ...extraHeaders };
  delete headers.host;
  delete headers.connection;
  delete headers['content-length'];
  delete headers['transfer-encoding'];
  if (body && body.length) headers['content-length'] = String(body.length);
  const mod = target.protocol === 'http:' ? http : https;
  return mod.request(target, { method: req.method, headers });
}

function forwardRaw(req, res, body, cfg) {
  const up = upstreamRequest(req, body, cfg);
  up.on('response', (ur) => {
    res.writeHead(ur.statusCode, ur.headers);
    ur.pipe(res);
  });
  up.on('error', (e) => fail(res, e));
  res.on('close', () => up.destroy());
  up.end(body);
}

function fail(res, e) {
  log('upstream error:', e.message);
  if (!res.headersSent) {
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: `zh-bridge proxy: ${e.message}` } }));
  } else res.destroy();
}

// ---------------------------------------------------------------- response rewrite

async function translateFinalText(blocks, cfg) {
  // blocks: [{ index, text }] of the final reply. Returns Map(index -> translated) or null.
  const all = blocks.map((b) => b.text).join('\n');
  if (!all.trim() || cjkRatio(all) > 0.3) return null; // already Chinese
  const out = new Map();
  await Promise.all(blocks.map(async (b) => {
    if (!b.text.trim()) return;
    const zh = await translate(b.text, 'out', cfg);
    out.set(b.index, zh);
    cacheSet(keyOf('out', zh.trim()), b.text); // so we can restore English next turn
  }));
  return out;
}

const sse = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

function forwardTranslated(req, res, body, cfg, stream) {
  const up = upstreamRequest(req, body, cfg, { 'accept-encoding': 'identity' });
  res.on('close', () => up.destroy());
  up.on('error', (e) => fail(res, e));
  up.on('response', (ur) => {
    if (ur.statusCode !== 200) { res.writeHead(ur.statusCode, ur.headers); ur.pipe(res); return; }
    const headers = { ...ur.headers };
    delete headers['content-length'];
    delete headers['content-encoding'];
    if (!stream) return handleJson(ur, res, headers, cfg);
    res.writeHead(200, headers);
    handleSse(ur, res, cfg);
  });
  up.end(body);
}

async function handleJson(ur, res, headers, cfg) {
  const raw = (await readBody(ur)).toString('utf8');
  let out = raw;
  try {
    const msg = JSON.parse(raw);
    const content = Array.isArray(msg.content) ? msg.content : [];
    const final = msg.stop_reason === 'end_turn' && !content.some((b) => b.type !== 'text' && b.type !== 'thinking' && b.type !== 'redacted_thinking');
    if (final) {
      const blocks = content.map((b, index) => ({ b, index })).filter(({ b }) => b.type === 'text').map(({ b, index }) => ({ index, text: b.text }));
      const map = await translateFinalText(blocks, cfg).catch((e) => { log('out FAILED (showing English):', e.message); return null; });
      if (map) { for (const [i, zh] of map) content[i].text = zh; out = JSON.stringify(msg); }
    }
  } catch (e) { log('json rewrite skipped:', e.message); }
  res.writeHead(200, headers);
  res.end(out);
}

/**
 * SSE state machine.
 *  live   : forward events as they arrive (message_start, thinking, pings)
 *  buffer : a text block started; hold events until we know whether this is the final reply
 *  pass   : a tool call appeared, so this is not the final reply; flush and stream through
 */
function handleSse(ur, res, cfg) {
  let mode = 'live';
  let pending = '';
  const held = []; // { raw, type, data }
  let keepalive = null;

  const startKeepalive = () => {
    if (!keepalive) keepalive = setInterval(() => res.write(sse('ping', { type: 'ping' })), 5000);
  };
  const stopKeepalive = () => { if (keepalive) clearInterval(keepalive); keepalive = null; };
  const flush = () => { for (const e of held) res.write(e.raw); held.length = 0; };

  const finalize = async () => {
    stopKeepalive();
    let stopReason = null;
    const texts = new Map();
    for (const e of held) {
      if (e.type === 'message_delta') stopReason = e.data?.delta?.stop_reason ?? stopReason;
      if (e.type === 'content_block_start' && e.data.content_block?.type === 'text') texts.set(e.data.index, e.data.content_block.text || '');
      if (e.type === 'content_block_delta' && e.data.delta?.type === 'text_delta' && texts.has(e.data.index)) {
        texts.set(e.data.index, texts.get(e.data.index) + e.data.delta.text);
      }
    }
    let map = null;
    if (stopReason === 'end_turn' && texts.size) {
      startKeepalive();
      map = await translateFinalText([...texts].map(([index, text]) => ({ index, text })), cfg)
        .catch((e) => { log('out FAILED (showing English):', e.message); return null; });
      stopKeepalive();
    }
    if (!map || !map.size) { flush(); res.end(); return; }
    log('out translated', map.size, 'block(s)');
    for (const e of held) {
      const idx = e.data?.index;
      if (map.has(idx)) {
        if (e.type === 'content_block_start') { res.write(sse('content_block_start', { ...e.data, content_block: { ...e.data.content_block, text: '' } })); continue; }
        if (e.type === 'content_block_delta' && e.data.delta?.type === 'text_delta') continue;
        if (e.type === 'content_block_stop') res.write(sse('content_block_delta', { type: 'content_block_delta', index: idx, delta: { type: 'text_delta', text: map.get(idx) } }));
      }
      res.write(e.raw);
    }
    held.length = 0;
    res.end();
  };

  const onEvent = (raw) => {
    let type = null; let data = null;
    for (const line of raw.split('\n')) {
      if (line.startsWith('event:')) type = line.slice(6).trim();
      else if (line.startsWith('data:')) { try { data = JSON.parse(line.slice(5).trim()); } catch { /* keep null */ } }
    }
    type = type || data?.type;
    const ev = { raw: raw + '\n\n', type, data };
    if (mode === 'pass') { res.write(ev.raw); return; }
    if (mode === 'live') {
      if (type === 'content_block_start' && data?.content_block?.type === 'text') { mode = 'buffer'; held.push(ev); startKeepalive(); return; }
      res.write(ev.raw);
      return;
    }
    // buffer
    if (type === 'ping') return; // our own keepalive covers this
    held.push(ev);
    const bt = data?.content_block?.type;
    if ((type === 'content_block_start' && bt && bt !== 'text' && bt !== 'thinking' && bt !== 'redacted_thinking') || type === 'error') {
      mode = 'pass'; stopKeepalive(); flush();
    }
  };

  ur.setEncoding('utf8');
  ur.on('data', (chunk) => {
    pending += chunk.replace(/\r\n/g, '\n');
    let i;
    while ((i = pending.indexOf('\n\n')) !== -1) {
      const raw = pending.slice(0, i);
      pending = pending.slice(i + 2);
      if (raw.trim()) onEvent(raw);
    }
  });
  ur.on('end', () => {
    if (pending.trim()) onEvent(pending);
    if (mode === 'buffer') finalize().catch((e) => { log('finalize error:', e.message); flush(); res.end(); });
    else { stopKeepalive(); res.end(); }
  });
  ur.on('error', (e) => { stopKeepalive(); flush(); res.destroy(e); });
}

// ---------------------------------------------------------------- server

const server = http.createServer(async (req, res) => {
  try {
    if (req.url.startsWith('/__zh/health')) {
      const cfg = loadConfig();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, pid: process.pid, enabled: cfg.enabled, input: cfg.input, output: cfg.output, model: cfg.translator.model, key: !!cfg.translator.api_key }));
      return;
    }
    const body = await readBody(req);
    // /zh show: the plugin sends the texts of the current conversation and gets
    // back the other side of each translation from the cache (local only).
    if (req.method === 'POST' && req.url.startsWith('/__zh/lookup')) {
      let q = {};
      try { q = JSON.parse(body.toString('utf8')); } catch { /* empty */ }
      const look = (ns, list, trim) => (Array.isArray(list) ? list : [])
        .map((t) => (typeof t === 'string' ? cacheGet(keyOf(ns, trim ? t.trim() : t)) ?? null : null));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ in: look('in', q.in, false), out: look('out', q.out, true) }));
      return;
    }
    const cfg = loadConfig();
    const pathOnly = req.url.split('?')[0];
    const isMessages = req.method === 'POST' && pathOnly.endsWith('/v1/messages');
    const isCount = req.method === 'POST' && pathOnly.endsWith('/v1/messages/count_tokens');
    if (!cfg.enabled || (!isMessages && !isCount)) return forwardRaw(req, res, body, cfg);

    let payload;
    try { payload = JSON.parse(body.toString('utf8')); } catch { return forwardRaw(req, res, body, cfg); }

    // Only the real conversation carries tools. Claude Code's own side requests
    // (session title, summaries, ...) have none: they wrap your prompt in their own
    // instructions, so they pass through completely untouched.
    const isConversation = Array.isArray(payload.tools) && payload.tools.length > 0;
    if (!isConversation) return forwardRaw(req, res, body, cfg);

    const { changed, latestIsChinese, latestIsTyped } = await rewriteRequest(payload, cfg);
    const outBody = changed ? Buffer.from(JSON.stringify(payload)) : body;
    const wantOut = isMessages && !isSubagent(payload) && (
      (cfg.output === 'auto' && latestIsChinese) ||
      (cfg.output === 'always' && latestIsTyped));
    if (!wantOut) return forwardRaw(req, res, outBody, cfg);
    return forwardTranslated(req, res, outBody, cfg, payload.stream === true);
  } catch (e) {
    fail(res, e);
  }
});

const cfg0 = loadConfig();
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') { log(`port ${cfg0.port} already in use; another zh-bridge is probably running. Exiting.`); process.exit(0); }
  log('server error:', e.message); process.exit(1);
});
server.listen(cfg0.port, '127.0.0.1', () => {
  log(`zh-bridge listening on http://127.0.0.1:${cfg0.port} -> ${cfg0.upstream} (translator: ${cfg0.translator.model}, key ${cfg0.translator.api_key ? 'set' : 'MISSING'})`);
});
