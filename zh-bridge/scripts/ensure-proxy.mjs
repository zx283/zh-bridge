#!/usr/bin/env node
// SessionStart hook: make sure the proxy is up, and up to date.
// - not running (no launchd agent, or it crashed): start it detached
// - running an older version (the plugin was updated, the installed copy in
//   ~/.zh-bridge/app wasn't): refresh that copy and restart it
// Silent either way.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig, HOME_DIR, LOG_PATH, VERSION } from './lib/config.mjs';

const cfg = loadConfig();
const here = path.dirname(fileURLToPath(import.meta.url));
const app = path.join(HOME_DIR, 'app');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const health = () => new Promise((resolve) => {
  const req = http.get({ host: '127.0.0.1', port: cfg.port, path: '/__zh/health', timeout: 600 }, (r) => {
    let b = ''; r.on('data', (c) => { b += c; });
    r.on('end', () => { try { resolve(r.statusCode === 200 ? JSON.parse(b) : null); } catch { resolve(null); } });
  });
  req.on('error', () => resolve(null));
  req.on('timeout', () => { req.destroy(); resolve(null); });
});

const waitFor = async (ok, ms) => {
  for (let t = 0; t < ms; t += 100) { if (ok(await health())) return true; await sleep(100); }
  return false;
};

function start() {
  fs.mkdirSync(HOME_DIR, { recursive: true });
  const out = fs.openSync(LOG_PATH, 'a');
  const script = fs.existsSync(path.join(app, 'proxy.mjs')) ? path.join(app, 'proxy.mjs') : path.join(here, 'proxy.mjs');
  spawn(process.execPath, [script], { detached: true, stdio: ['ignore', out, out], env: { ...process.env, ZH_BRIDGE_HOME: HOME_DIR } }).unref();
}

const running = await health();
if (running && running.version !== VERSION) {
  // An older proxy: update the installed copy, then stop it. launchd starts the
  // new copy again by itself; without launchd we start it.
  if (fs.existsSync(path.join(app, 'proxy.mjs')) && path.resolve(here) !== path.resolve(app)) {
    fs.cpSync(here, app, { recursive: true });
  }
  try { process.kill(running.pid); } catch { /* already gone */ }
  if (!(await waitFor((h) => h?.version === VERSION, 3000))) {
    if (!(await health())) { start(); await waitFor((h) => !!h, 1500); }
  }
} else if (!running) {
  start();
  await waitFor((h) => !!h, 1500);
}
process.exit(0);
