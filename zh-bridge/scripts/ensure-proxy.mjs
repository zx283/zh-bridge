#!/usr/bin/env node
// SessionStart hook: make sure the proxy is up. If it is not (e.g. no launchd
// agent, or it crashed), start it detached. Silent on success.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig, HOME_DIR, LOG_PATH } from './lib/config.mjs';

const cfg = loadConfig();
const here = path.dirname(fileURLToPath(import.meta.url));

const alive = () => new Promise((resolve) => {
  const req = http.get({ host: '127.0.0.1', port: cfg.port, path: '/__zh/health', timeout: 600 }, (r) => { r.resume(); resolve(r.statusCode === 200); });
  req.on('error', () => resolve(false));
  req.on('timeout', () => { req.destroy(); resolve(false); });
});

if (!(await alive())) {
  fs.mkdirSync(HOME_DIR, { recursive: true });
  const out = fs.openSync(LOG_PATH, 'a');
  const child = spawn(process.execPath, [path.join(here, 'proxy.mjs')], { detached: true, stdio: ['ignore', out, out] });
  child.unref();
  for (let i = 0; i < 15 && !(await alive()); i++) await new Promise((r) => setTimeout(r, 100));
}
process.exit(0);
