# zh-bridge

**Write to Claude Code in Chinese, read its replies in Chinese, while Claude itself only ever sees English.**

用中文和 Claude Code 对话：你输入中文，看到中文回复，而 Claude 看到的始终是英文。翻译用的是便宜的模型（默认 DeepSeek，也可以换成任何兼容 OpenAI 接口的服务）。

```
you (中文) ──► Claude Code ──► [proxy: 中文 → English] ──► Anthropic API
you (中文) ◄── Claude Code ◄── [proxy: English → 中文] ◄── Anthropic API
                                       │
                         DeepSeek (or any OpenAI-compatible API)
```

- **Your prompt:** any prompt containing Chinese is translated to English before Claude sees it. Code, `inline code`, paths, URLs and Claude Code's `[Image #1]` / `[Pasted text]` markers are masked, so the translator can't touch them. Ambiguous terms keep the original in brackets: `gradient checkpointing (梯度检查点)`.
- **Claude's reply:** only the final reply of a turn is translated. Tool calls and intermediate steps pass through unchanged. Technical terms keep their English: `依赖注入（dependency injection）`.
- **Claude's context stays English:** on the next turn the Chinese reply is swapped back to Claude's original English. Translations are cached, so the history is identical every turn and prompt caching keeps working.
- **Automatic:** replies are translated only when your prompt had Chinese in it. Write English and you get English.
- **Fails open:** if the translator is down or returns something broken, the original text goes through. Nothing is blocked.
- **Claude Code's own background requests** (session titles, summaries) are never touched.

## Requirements

- Claude Code **2.1.296 or newer** (the `/zh` panel uses Claude Code's early-access "mods" plugin feature)
- Node.js 18+
- macOS (on Linux the installer works, but the proxy isn't started at login; the plugin starts it at the beginning of each session). Windows isn't supported.
- An API key for DeepSeek, or any other OpenAI-compatible provider
- Doesn't work with Claude through Amazon Bedrock or Google Vertex

## Install

```bash
git clone https://github.com/zx283/zh-bridge.git
cd zh-bridge
./install.sh        # asks for your DeepSeek API key
```

Restart Claude Code, then type `/zh`.

The installer:
1. writes `~/.zh-bridge/config.json` (readable only by you)
2. copies the proxy to `~/.zh-bridge/app` and runs it at login (macOS launchd)
3. adds `env.ANTHROPIC_BASE_URL=http://127.0.0.1:8787` to `~/.claude/settings.json` (the old file is backed up)
4. installs the plugin from this folder

Works with a claude.ai subscription login: your login and usage limits stay as they are. Claude Code turns off Remote Control while `ANTHROPIC_BASE_URL` points somewhere other than api.anthropic.com.

If you already route Claude Code through your own gateway, the installer warns you; put that address in `"upstream"` in the config.

Uninstall: `./uninstall.sh` (add `--purge` to also delete `~/.zh-bridge`).

## `/zh` settings

```
Chinese ⇄ English translation  ● proxy running · translator: deepseek-chat
1: Translation          On ▾
2: Translate my input   On ▾
3: Translate output     On ▾
4: Reply language       简体中文 ▾
5: Model                deepseek-chat ▾
6: API URL              https://api.deepseek.com ▾
7: API key              sk-…abcd ▾
8: Input prompt         Default ▾
9: Output prompt        Default ▾
0: Close
```

How it opens depends on Claude Code's layout (switch with `/tui`):

- **`/tui default` (recommended):** opens at the bottom, ready to use, like `/model`. Tab moves between rows, ↑↓ chooses, Enter sets, Esc closes.
- **`/tui fullscreen`:** a plugin can't move the keyboard into the list here. Press a number to change a row, 0 to close, or Ctrl+X Tab first to use Tab / ↑↓ / Enter. Sending a message also closes it.

Rows:
- **1–4** switch translation on/off, set each direction, and pick the reply language (简体中文, 繁體中文, 日本語, 한국어).
- **5–7** open Claude Code's question dialog: pick a preset, or type your own under "Type something". The key is only ever shown masked.
- **8–9** switch between the default prompt and your own. "Custom" copies the default to `~/.zh-bridge/prompts/input.txt` (or `output.txt`) and opens it in your text editor; save it and it's used from your next message. In the output prompt, `{lang}` stands for the reply language. A fixed rule protecting code and placeholders is always added.

Changes apply from your next message, with no restart.

| command | |
|---|---|
| `/zh show` | your recent translations side by side: your language on the left, English on the right, for your message and Claude's reply. 1 = older, 2 = newer (last 50), Esc or 0 closes, mouse wheel scrolls |
| `/zh on` / `/zh off` | switch translation on or off |
| `/zh status` | all settings as text |

## Config

Everything `/zh` changes lives in `~/.zh-bridge/config.json`:

```json
{
  "enabled": true,
  "input": true,
  "output": "auto",
  "target_lang": "Simplified Chinese",
  "port": 8787,
  "upstream": "https://api.anthropic.com",
  "max_input_chars": 12000,
  "translator": {
    "base_url": "https://api.deepseek.com",
    "model": "deepseek-chat",
    "api_key": "sk-...",
    "timeout_ms": 45000,
    "chunk_chars": 3000
  }
}
```

Any OpenAI-compatible endpoint works: Qwen (DashScope), Kimi, OpenRouter, or a local Ollama (`http://127.0.0.1:11434/v1`). Edits apply immediately.

## Good to know

- **Privacy:** your prompts and Claude's final replies are sent to the translation provider you configure. Your API key, translation history (`history.json`, last 50), cache and log stay in `~/.zh-bridge` on your machine.
- **The final reply doesn't stream.** It has to be complete before it can be translated, so it appears all at once, about 1–3 seconds after Claude finishes. Long replies are translated in parallel chunks.
- **Commands with text after them** (`/btw …`, `/loop …`, your own skills) work: only the words you typed are translated, never the command's own instructions. Each scheduled `/loop` run replies in the language you were writing in.
- **Auto mode:** because requests go through a local proxy, Claude Code bills auto mode's safety-check requests the old way and shows a notice about it once. Everything still works.
- **Only what you type is translated.** File contents, tool results and text Claude Code adds itself (CLAUDE.md, reminders) are left as they are. Pasted blocks longer than `max_input_chars` pass through untranslated.
- **If the proxy stops** and isn't restarted, Claude Code can't reach the API. Restart Claude Code (the plugin restarts the proxy), or run `./uninstall.sh`.
- **Side panel too wide or too narrow?** If you ever dragged a Claude Code side panel, Claude Code remembers that width for every plugin panel. To reset it, quit Claude Code and remove `pluginPanes.dockColumns` from `~/.claude.json`.

## How it works

A Claude Code hook can't rewrite your prompt; it can only block it or add text next to it. So the translation happens in a small local proxy (`zh-bridge/scripts/proxy.mjs`, Node, no dependencies) that Claude Code talks to through `ANTHROPIC_BASE_URL`. The plugin adds the `/zh` panel and a SessionStart hook that starts the proxy if it isn't running.

```
.claude-plugin/marketplace.json       marketplace entry for this repo
zh-bridge/.claude-plugin/plugin.json  plugin manifest
zh-bridge/hooks/hooks.json            SessionStart hook + the /zh module
zh-bridge/hooks/panel.tsx             /zh and /zh show
zh-bridge/scripts/proxy.mjs           the translating proxy
zh-bridge/scripts/ensure-proxy.mjs    starts the proxy if needed
zh-bridge/scripts/lib/translator.mjs  masking, chunking, cache, API call
zh-bridge/scripts/lib/prompts/        default translation prompts
zh-bridge/scripts/lib/config.mjs      config and file locations
install.sh / uninstall.sh
test/e2e.mjs                          proxy test against a mock API and mock translator
```

Tests:

```bash
claude plugin test zh-bridge                         # /zh panel
cd test && npm i @anthropic-ai/sdk && node e2e.mjs   # proxy
```

## License

MIT
