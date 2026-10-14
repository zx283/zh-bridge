// Shared config + paths for zh-bridge (proxy, hooks, CLI).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const HOME_DIR = process.env.ZH_BRIDGE_HOME || path.join(os.homedir(), '.zh-bridge');
export const CONFIG_PATH = path.join(HOME_DIR, 'config.json');
export const CACHE_PATH = path.join(HOME_DIR, 'cache.jsonl');
export const TYPED_PATH = path.join(HOME_DIR, 'typed.json');     // what the person last typed (written by /zh's plugin)
export const LOG_PATH = path.join(HOME_DIR, 'proxy.log');

export const DEFAULTS = {
  enabled: true,              // master switch; false = pure passthrough
  input: true,                // translate Chinese prompts -> English before Claude sees them
  output: 'auto',             // 'auto': translate the final reply when you wrote Chinese · 'always' · 'off'
  target_lang: 'Simplified Chinese',
  port: 8787,
  upstream: 'https://api.anthropic.com',
  max_input_chars: 12000,     // longer pasted blocks are passed through untranslated
  translator: {
    base_url: 'https://api.deepseek.com', // any OpenAI-compatible endpoint
    model: 'deepseek-flash',
    api_key: '',
    timeout_ms: 45000,
    chunk_chars: 3000,
  },
};

function deepMerge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && typeof base[k] === 'object'
      ? deepMerge(base[k], v) : v;
  }
  return out;
}

let cached = null;
let cachedMtime = -1;

export function loadConfig() {
  let mtime = 0;
  try { mtime = fs.statSync(CONFIG_PATH).mtimeMs; } catch { /* no file yet */ }
  if (cached && mtime === cachedMtime) return cached;
  let user = {};
  if (mtime) {
    try { user = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }
    catch (e) { if (cached) return cached; }
  }
  const cfg = deepMerge(DEFAULTS, user);
  const envKey = process.env.ZH_BRIDGE_API_KEY || process.env.DEEPSEEK_API_KEY;
  if (!cfg.translator.api_key && envKey) cfg.translator.api_key = envKey;
  if (process.env.ZH_BRIDGE_PORT) cfg.port = Number(process.env.ZH_BRIDGE_PORT);
  cached = cfg;
  cachedMtime = mtime;
  return cfg;
}
