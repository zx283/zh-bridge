#!/usr/bin/env bash
# Removes the launchd agent and the ANTHROPIC_BASE_URL override.
# Keeps ~/.zh-bridge (config, cache, log) unless you pass --purge.
set -uo pipefail
ZH_HOME="${ZH_BRIDGE_HOME:-$HOME/.zh-bridge}"
LABEL="com.zhbridge.proxy"

if [ "$(uname)" = "Darwin" ]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null
  rm -f "$HOME/Library/LaunchAgents/$LABEL.plist"
fi
pkill -f "$ZH_HOME/app/proxy.mjs" 2>/dev/null

node -e '
  const fs = require("fs"); const f = process.argv[1];
  try {
    const s = JSON.parse(fs.readFileSync(f, "utf8"));
    if (s.env && /127\.0\.0\.1|localhost/.test(s.env.ANTHROPIC_BASE_URL || "")) {
      delete s.env.ANTHROPIC_BASE_URL;
      if (!Object.keys(s.env).length) delete s.env;
      fs.writeFileSync(f, JSON.stringify(s, null, 2) + "\n");
    }
  } catch {}
' "$HOME/.claude/settings.json"

if command -v claude >/dev/null; then
  claude plugin uninstall zh-bridge@zh-bridge >/dev/null 2>&1
  claude plugin marketplace remove zh-bridge >/dev/null 2>&1
fi
[ "${1:-}" = "--purge" ] && rm -rf "$ZH_HOME"
echo "zh-bridge removed. Restart Claude Code."
