#!/usr/bin/env bash
# zh-bridge installer (macOS / Linux).
#  1. writes ~/.zh-bridge/config.json (asks for your DeepSeek API key)
#  2. copies the proxy to ~/.zh-bridge/app and runs it at login (launchd on macOS)
#  3. points Claude Code at the proxy: env.ANTHROPIC_BASE_URL in ~/.claude/settings.json
#  4. registers this folder as a plugin marketplace and installs the zh-bridge plugin
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ZH_HOME="${ZH_BRIDGE_HOME:-$HOME/.zh-bridge}"
PORT="${ZH_BRIDGE_PORT:-8787}"
LABEL="com.zhbridge.proxy"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

NODE="$(command -v node || true)"
[ -n "$NODE" ] || { echo "Node.js 18+ is required (brew install node)"; exit 1; }
"$NODE" -e 'process.exit(+process.versions.node.split(".")[0] >= 18 ? 0 : 1)' || { echo "Node.js 18+ is required"; exit 1; }

mkdir -p "$ZH_HOME"

# ---- 1. config
if [ ! -f "$ZH_HOME/config.json" ]; then
  KEY="${DEEPSEEK_API_KEY:-}"
  if [ -z "$KEY" ]; then
    read -r -s -p "DeepSeek API key (sk-..., input hidden): " KEY; echo
  fi
  ZH_KEY="$KEY" ZH_PORT="$PORT" "$NODE" -e '
    const fs = require("fs");
    const cfg = { port: +process.env.ZH_PORT, input: true, output: "auto", target_lang: "Simplified Chinese",
      translator: { base_url: "https://api.deepseek.com", model: "deepseek-chat", api_key: process.env.ZH_KEY } };
    fs.writeFileSync(process.argv[1], JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  ' "$ZH_HOME/config.json"
  echo "✓ wrote $ZH_HOME/config.json"
else
  echo "✓ keeping existing $ZH_HOME/config.json"
fi

# ---- 2. proxy as a login service (copied to ~/.zh-bridge/app: macOS blocks background agents from Desktop/Documents)
rm -rf "$ZH_HOME/app" && mkdir -p "$ZH_HOME/app"
cp -R "$REPO/zh-bridge/scripts/." "$ZH_HOME/app/"
if [ "$(uname)" = "Darwin" ]; then
  mkdir -p "$(dirname "$PLIST")"
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>$ZH_HOME/app/proxy.mjs</string></array>
  <key>EnvironmentVariables</key><dict><key>ZH_BRIDGE_HOME</key><string>$ZH_HOME</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$ZH_HOME/proxy.log</string>
  <key>StandardErrorPath</key><string>$ZH_HOME/proxy.log</string>
</dict></plist>
EOF
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
  echo "✓ proxy running as launchd agent ($LABEL)"
else
  nohup "$NODE" "$ZH_HOME/app/proxy.mjs" >>"$ZH_HOME/proxy.log" 2>&1 &
  echo "✓ proxy started (Linux: the plugin's SessionStart hook restarts it when needed)"
fi

for _ in 1 2 3 4 5 6 7 8 9 10; do
  curl -fsS "http://127.0.0.1:$PORT/__zh/health" >/dev/null 2>&1 && break; sleep 0.3
done
curl -fsS "http://127.0.0.1:$PORT/__zh/health" && echo || { echo "✗ proxy did not start, see $ZH_HOME/proxy.log"; exit 1; }

# ---- 3. route Claude Code through the proxy
SETTINGS="$HOME/.claude/settings.json"
mkdir -p "$HOME/.claude"
[ -f "$SETTINGS" ] && cp "$SETTINGS" "$SETTINGS.bak-zh-bridge"
"$NODE" -e '
  const fs = require("fs"); const f = process.argv[1];
  let s = {}; try { s = JSON.parse(fs.readFileSync(f, "utf8")); } catch {}
  s.env = s.env || {};
  if (s.env.ANTHROPIC_BASE_URL && !/127\.0\.0\.1|localhost/.test(s.env.ANTHROPIC_BASE_URL))
    console.log("! you had ANTHROPIC_BASE_URL=" + s.env.ANTHROPIC_BASE_URL + " — set it as \"upstream\" in ~/.zh-bridge/config.json");
  s.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:" + process.argv[2];
  fs.writeFileSync(f, JSON.stringify(s, null, 2) + "\n");
' "$SETTINGS" "$PORT"
echo "✓ ~/.claude/settings.json: env.ANTHROPIC_BASE_URL=http://127.0.0.1:$PORT (backup: settings.json.bak-zh-bridge)"

# ---- 4. plugin (/zh settings panel + auto-restart hook)
if command -v claude >/dev/null 2>&1; then
  # earlier versions registered this folder as "zh-bridge-dev"
  claude plugin uninstall zh-bridge@zh-bridge-dev >/dev/null 2>&1 || true
  claude plugin marketplace remove zh-bridge-dev >/dev/null 2>&1 || true
  claude plugin marketplace add "$REPO" >/dev/null 2>&1 || true
  if claude plugin install zh-bridge@zh-bridge >/dev/null 2>&1; then
    echo "✓ plugin zh-bridge installed"
  else
    echo "! install the plugin from inside Claude Code:"
    echo "    /plugin marketplace add $REPO"
    echo "    /plugin install zh-bridge@zh-bridge"
  fi
fi

echo
echo "Done. Restart Claude Code, then type /zh to open the settings. Write in Chinese as usual."
