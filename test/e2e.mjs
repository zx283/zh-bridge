// End-to-end test with a mock Anthropic API and a mock translator.
// Run: npm i @anthropic-ai/sdk (in test/) && node test/e2e.mjs
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import Anthropic from '@anthropic-ai/sdk';

const here = path.dirname(fileURLToPath(import.meta.url));
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zhb-'));
const P = { proxy: 18787, up: 19001, tr: 19002 };

fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
  port: P.proxy, upstream: `http://127.0.0.1:${P.up}`,
  translator: { base_url: `http://127.0.0.1:${P.tr}`, model: 'mock', api_key: 'k' },
}));

// ---- mock translator: fake but deterministic
const trCalls = [];
http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => {
    const j = JSON.parse(b);
    const text = j.messages[1].content;
    const toEn = j.messages[0].content.includes('into natural, precise English');
    trCalls.push({ toEn, text, system: j.messages[0].content });
    if (text.includes('FAIL')) { res.writeHead(500); res.end('boom'); return; }
    const out = toEn
      ? text.replace('请帮我修复', 'Please help me fix ').replace('这个函数', 'this function').replace('谢谢', 'thanks')
      : text.replace('Done.', '完成。').replace('I fixed', '我修复了');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: out } }] }));
  });
}).listen(P.tr);

// ---- mock Anthropic upstream
const upReqs = [];
function sseMsg(blocks, stop) {
  let s = `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: 'm1', type: 'message', role: 'assistant', model: 'x', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } })}\n\n`;
  s += `event: ping\ndata: {"type":"ping"}\n\n`;
  blocks.forEach((b, i) => {
    if (b.type === 'text') {
      s += `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: i, content_block: { type: 'text', text: '' } })}\n\n`;
      for (const piece of b.text.match(/.{1,7}/gs)) s += `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: piece } })}\n\n`;
    } else {
      s += `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: 'tu1', name: 'Read', input: {} } })}\n\n`;
      s += `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: '{"file_path":"/a.py"}' } })}\n\n`;
    }
    s += `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: i })}\n\n`;
  });
  s += `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 5 } })}\n\n`;
  s += `event: message_stop\ndata: {"type":"message_stop"}\n\n`;
  return s;
}
let nextResponse = null;
http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => {
    upReqs.push({ url: req.url, headers: req.headers, body: JSON.parse(b || '{}') });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const s = nextResponse;
    // stream slowly in two halves to exercise chunk boundaries
    res.write(s.slice(0, 123)); setTimeout(() => res.end(s.slice(123)), 30);
  });
}).listen(P.up);

const proxy = spawn(process.execPath, [path.join(here, '../zh-bridge/scripts/proxy.mjs')], { env: { ...process.env, ZH_BRIDGE_HOME: home, ZH_BRIDGE_DEBUG: '1' }, stdio: ['ignore', 'inherit', 'inherit'] });
process.on('exit', () => proxy.kill());
await new Promise((r) => setTimeout(r, 500));

const client = new Anthropic({ apiKey: 'sk-test', baseURL: `http://127.0.0.1:${P.proxy}` });
const tools = [{ name: 'Read', description: 'read', input_schema: { type: 'object', properties: {} } }];
const reminder = { type: 'text', text: '<system-reminder>项目说明：不要翻译我</system-reminder>' };
const prompt = { type: 'text', text: '请帮我修复这个函数 `foo_bar()`，谢谢' };

// ---- Turn 1a: Claude makes a tool call -> must pass through untouched
nextResponse = sseMsg([{ type: 'text', text: 'Let me look.' }, { type: 'tool_use' }], 'tool_use');
let msg = await client.messages.stream({ model: 'x', max_tokens: 100, tools, messages: [{ role: 'user', content: [reminder, prompt] }] }).finalMessage();
let sent = upReqs.at(-1).body.messages[0].content;
assert.equal(sent[0].text, reminder.text, 'system-reminder untouched');
assert.equal(sent[1].text, 'Please help me fix this function `foo_bar()`，thanks', 'prompt translated, code kept');
assert.equal(msg.content[0].text, 'Let me look.', 'intermediate narration not translated');
assert.equal(msg.content[1].type, 'tool_use');
assert.deepEqual(msg.content[1].input, { file_path: '/a.py' });
assert.equal(upReqs.at(-1).headers['x-api-key'], 'sk-test', 'auth header forwarded');
console.log('ok  1a tool-call turn passes through, prompt translated');

// ---- Turn 1b: final reply -> translated
nextResponse = sseMsg([{ type: 'text', text: 'Done. I fixed `foo_bar()` in a.py.' }], 'end_turn');
const history = [
  { role: 'user', content: [reminder, prompt] },
  { role: 'assistant', content: msg.content },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'def foo_bar(): pass' }] },
];
msg = await client.messages.stream({ model: 'x', max_tokens: 100, tools, messages: history }).finalMessage();
assert.equal(msg.content[0].text, '完成。 我修复了 `foo_bar()` in a.py.', 'final reply translated, code kept');
assert.equal(msg.stop_reason, 'end_turn');
const trBefore = trCalls.filter((c) => c.toEn).length;
console.log('ok  1b final reply translated:', msg.content[0].text);

// ---- Turn 2: history contains the Chinese reply -> restored to English; prompt from cache
nextResponse = sseMsg([{ type: 'text', text: 'Sure.' }], 'end_turn');
history.push({ role: 'assistant', content: msg.content }, { role: 'user', content: 'thanks, now run tests' });
msg = await client.messages.stream({ model: 'x', max_tokens: 100, tools, messages: history }).finalMessage();
const b2 = upReqs.at(-1).body.messages;
assert.equal(b2[3].content[0].text, 'Done. I fixed `foo_bar()` in a.py.', 'assistant reply restored to original English');
assert.equal(b2[0].content[1].text, 'Please help me fix this function `foo_bar()`，thanks', 'old prompt identical (cache)');
assert.equal(trCalls.filter((c) => c.toEn).length, trBefore, 'no re-translation of old prompt');
assert.equal(msg.content[0].text, 'Sure.', 'English prompt -> English reply (auto mode)');
console.log('ok  2  history restored to English, cache hit, English prompt not translated');

// ---- Translator down -> originals pass through, nothing breaks
nextResponse = sseMsg([{ type: 'text', text: 'Done. FAIL' }], 'end_turn');
msg = await client.messages.stream({ model: 'x', max_tokens: 100, tools, messages: [{ role: 'user', content: '坏掉 FAIL' }] }).finalMessage();
assert.equal(upReqs.at(-1).body.messages[0].content, '坏掉 FAIL', 'input falls back to original');
assert.equal(msg.content[0].text, 'Done. FAIL', 'output falls back to English');
console.log('ok  3  translator failure falls back to original text');

// ---- Side request without tools (Claude Code's session-title call): untouched both ways
const titleAsk = '<session>\n这个文件夹在说什么？\n</session>\n\nWrite the title in the predominant language of the session.';
nextResponse = sseMsg([{ type: 'text', text: '{"title":"文件夹说明"}' }], 'end_turn');
msg = await client.messages.stream({ model: 'x', max_tokens: 100, messages: [{ role: 'user', content: titleAsk }] }).finalMessage();
assert.equal(upReqs.at(-1).body.messages[0].content, titleAsk, 'side request input untouched');
assert.equal(msg.content[0].text, '{"title":"文件夹说明"}', 'side request output untouched');
console.log('ok  4  side request (session title) untouched both ways');

// ---- Config changes (what /zh writes) apply live, no restart
const cfgPath = path.join(home, 'config.json');
fs.writeFileSync(cfgPath, JSON.stringify({ ...JSON.parse(fs.readFileSync(cfgPath, 'utf8')), output: 'off' }));
nextResponse = sseMsg([{ type: 'text', text: 'Done.' }], 'end_turn');
msg = await client.messages.stream({ model: 'x', max_tokens: 100, tools, messages: [{ role: 'user', content: '请帮我修复' }] }).finalMessage();
assert.equal(msg.content[0].text, 'Done.', 'output off respected live, no restart');
console.log('ok  5  config changes apply live');
// ---- Custom prompt (what /zh "Custom" switches on) is used, with the fixed safety rule appended
fs.mkdirSync(path.join(home, 'prompts'), { recursive: true });
fs.writeFileSync(path.join(home, 'prompts', 'input.txt'), 'CUSTOMMARK: translate into natural, precise English, keep 术语 in brackets.');
fs.writeFileSync(cfgPath, JSON.stringify({ ...JSON.parse(fs.readFileSync(cfgPath, 'utf8')), prompts: { input: 'custom' } }));
nextResponse = sseMsg([{ type: 'text', text: 'Done.' }], 'end_turn');
await client.messages.stream({ model: 'x', max_tokens: 100, tools, messages: [{ role: 'user', content: '谢谢你 新的' }] }).finalMessage();
const sys = trCalls.at(-1).system;
assert.ok(sys.startsWith('CUSTOMMARK'), 'custom prompt used');
assert.ok(sys.includes('Copy every placeholder'), 'fixed placeholder rule appended');
console.log('ok  6  custom prompt used, safety rule kept');

// ---- /loop and other commands with text: only the person's text is translated
fs.writeFileSync(cfgPath, JSON.stringify({ ...JSON.parse(fs.readFileSync(cfgPath, 'utf8')), output: 'auto', prompts: {} }));
const before = trCalls.length;
const instructions = '# /loop — schedule a recurring prompt\n\nParse the input below.\n\nInput: 1m 请帮我修复';
nextResponse = sseMsg([{ type: 'text', text: 'Done.' }], 'end_turn');
await client.messages.stream({ model: 'x', max_tokens: 100, tools, messages: [{ role: 'user', content: [
  { type: 'text', text: '<command-message>loop</command-message>\n<command-name>/loop</command-name>\n<command-args>1m 请帮我修复</command-args>' },
  { type: 'text', text: instructions },
] }] }).finalMessage();
const sentBlocks = upReqs.at(-1).body.messages[0].content;
assert.equal(sentBlocks[0].text.includes('<command-args>1m Please help me fix</command-args>'), true, 'args translated in place');
assert.equal(sentBlocks[1].text, instructions.replace('1m 请帮我修复', '1m Please help me fix'), 'instructions untouched apart from the args');
assert.equal(trCalls.slice(before).filter((c) => c.toEn).every((c) => !c.text.includes('/loop')), true, 'instructions never sent to the translator');
console.log('ok  8  /loop: only the typed text is translated, the command instructions are not');

// ---- A scheduled run re-sends the prompt Claude wrote: reply in the language the person typed in
nextResponse = sseMsg([{ type: 'text', text: 'Done.' }], 'end_turn');
msg = await client.messages.stream({ model: 'x', max_tokens: 100, tools, messages: [
  { role: 'user', content: '请帮我修复' },
  { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'CronCreate', input: { cron: '*/5 * * * *', prompt: 'Check for new files and report them.' } }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'Scheduled' }] },
  { role: 'assistant', content: [{ type: 'text', text: 'Done. Scheduled.' }] },
  { role: 'user', content: 'Check for new files and report them.' },
] }).finalMessage();
assert.equal(msg.content[0].text.startsWith('完成。'), true, 'scheduled run reply translated');
console.log('ok  9  scheduled /loop run: reply translated like the conversation');

// ---- "Always": replies to what the person typed are translated, even in English;
//      Claude Code's own requests (compacting) and helper agents never are.
fs.writeFileSync(cfgPath, JSON.stringify({ ...JSON.parse(fs.readFileSync(cfgPath, 'utf8')), output: 'always' }));
fs.writeFileSync(path.join(home, 'typed.json'), JSON.stringify(['what files are here?']));
nextResponse = sseMsg([{ type: 'text', text: 'Done.' }], 'end_turn');
msg = await client.messages.stream({ model: 'x', max_tokens: 100, tools, messages: [{ role: 'user', content: 'what files are here?' }] }).finalMessage();
assert.equal(msg.content[0].text, '完成。', 'typed English prompt: reply translated');
nextResponse = sseMsg([{ type: 'text', text: 'Done.' }], 'end_turn');
msg = await client.messages.stream({ model: 'x', max_tokens: 100, tools, messages: [
  { role: 'user', content: 'what files are here?' },
  { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
  { role: 'user', content: 'CRITICAL: Respond with TEXT ONLY. Summarize the conversation.' },
] }).finalMessage();
assert.equal(msg.content[0].text, 'Done.', 'compacting summary not translated');
nextResponse = sseMsg([{ type: 'text', text: 'Done.' }], 'end_turn');
msg = await client.messages.stream({ model: 'x', max_tokens: 100, tools,
  system: [{ type: 'text', text: 'You are an agent for Claude Code, Anthropic\'s official CLI for Claude.' }],
  messages: [{ role: 'user', content: 'what files are here?' }] }).finalMessage();
assert.equal(msg.content[0].text, 'Done.', 'helper agent reply not translated');
console.log('ok 10  "Always": typed English translated; compacting and helper agents untouched');
fs.writeFileSync(cfgPath, JSON.stringify({ ...JSON.parse(fs.readFileSync(cfgPath, 'utf8')), output: 'auto' }));

// ---- /__zh/lookup: what /zh show asks for, both directions, from the cache
const lk = await fetch(`http://127.0.0.1:${P.proxy}/__zh/lookup`, { method: 'POST', body: JSON.stringify({
  in: [prompt.text, '从没翻译过'], out: ['完成。 我修复了 `foo_bar()` in a.py.'],
}) }).then((r) => r.json());
assert.deepEqual(lk.in, ['Please help me fix this function `foo_bar()`，thanks', null]);
assert.deepEqual(lk.out, ['Done. I fixed `foo_bar()` in a.py.']);
assert.equal(fs.existsSync(path.join(home, 'history.json')), false, 'no shared history file any more');
console.log('ok  7  /__zh/lookup returns both sides of each translation; no history.json');

// ---- the running proxy reports its version, which must match the plugin's
const health = await fetch(`http://127.0.0.1:${P.proxy}/__zh/health`).then((r) => r.json());
const pluginVersion = JSON.parse(fs.readFileSync(path.join(here, '../zh-bridge/.claude-plugin/plugin.json'), 'utf8')).version;
assert.equal(health.version, pluginVersion, 'scripts/lib/config.mjs VERSION must equal plugin.json version');
console.log('ok 11  proxy version ' + health.version + ' matches plugin.json');
proxy.kill();
console.log('\nALL TESTS PASSED');
process.exit(0);
