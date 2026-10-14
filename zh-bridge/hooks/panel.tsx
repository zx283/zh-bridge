// /zh: zh-bridge settings at the bottom of the screen, like /model.
// Where it can draw depends on Claude Code's layout (/tui):
//   default layout  → a panel above the prompt that takes the keyboard at once:
//                     Tab rows · ↑↓ choose · Enter set · Esc close (exactly like /model)
//   fullscreen      → the band above the prompt. A plugin can't move the keyboard
//                     there, so 1–9 change a row directly, Ctrl+X Tab enters it, 0 closes.
// /zh show uses the same places. Runs locally; nothing is sent to Claude.
// Settings live in ~/.zh-bridge/config.json, which the proxy re-reads on every request.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ZhEntry, ZhField, ZhHealth, ZhSettings } from '../types'

// Sites: the band above the prompt (fullscreen) and two panes (default layout).
// The band's id is the engine's; we learn it whenever the band renders.
let BAND = 'above-prompt'
const PANE = 'zh-bridge'
const SHOW = 'zh-show'
// The site the settings are drawn in right now, for moving focus after a change.
let activeSite = PANE

const settings = atom({ plugin: 'zh-bridge', key: 'settings' } as const, null)
const health = atom({ plugin: 'zh-bridge', key: 'health' } as const, 'unknown')
const notice = atom({ plugin: 'zh-bridge', key: 'notice' } as const, null)
const view = atom({ plugin: 'zh-bridge', key: 'view' } as const, 'none')
const history = atom({ plugin: 'zh-bridge', key: 'history' } as const, [])
const showIndex = atom({ plugin: 'zh-bridge', key: 'showIndex' } as const, 0)

type RowKey = 'enabled' | 'input' | 'output' | 'lang' | ZhField | 'prompt_input' | 'prompt_output'

// Row order = number keys 1–9 = Tab order.
const ROWS: RowKey[] = ['enabled', 'input', 'output', 'lang', 'model', 'base_url', 'api_key', 'prompt_input', 'prompt_output']
const ROW_LABEL: Record<RowKey, string> = {
  enabled: 'Translation',
  input: 'Translate my input',
  output: 'Translate output',
  lang: 'Reply language',
  model: 'Model',
  base_url: 'API URL',
  api_key: 'API key',
  prompt_input: 'Input prompt',
  prompt_output: 'Output prompt',
}

const LANGS = ['Simplified Chinese', 'Traditional Chinese', 'Japanese', 'Korean']
const LANG_LABEL: Record<string, string> = {
  'Simplified Chinese': '简体中文',
  'Traditional Chinese': '繁體中文',
  Japanese: '日本語',
  Korean: '한국어',
}

const FIELD_LABEL: Record<ZhField, string> = {
  model: 'Model',
  base_url: 'API URL',
  api_key: 'API key',
}

const PRESETS: Record<ZhField, string[]> = {
  model: ['deepseek-flash', 'deepseek-v4-pro'],
  base_url: ['https://api.deepseek.com', 'https://dashscope.aliyuncs.com/compatible-mode/v1'],
  api_key: [],
}

// Bumped after a dialog so the "Change…" pickers snap back to the current value.
let editNonce = 0

const OUTPUT_LABEL: Record<ZhSettings['output'], string> = {
  auto: 'On (when I write Chinese)',
  always: 'Always',
  off: 'Off',
}

const ON_OFF = [
  { value: 'on', label: 'On' },
  { value: 'off', label: 'Off' },
]

function pad(s: string): string {
  return s.padEnd(20, ' ')
}

type Raw = {
  enabled?: boolean
  input?: boolean
  output?: string
  target_lang?: string
  port?: number
  prompts?: { input?: string; output?: string }
  translator?: { model?: string; base_url?: string; api_key?: string; [k: string]: unknown }
  [k: string]: unknown
}

// ---------------------------------------------------------------- config file

async function zhHome($: EngineInterface): Promise<string> {
  const custom = await $.env.get('ZH_BRIDGE_HOME')
  if (custom) return custom
  const home = await $.env.get('HOME')
  return `${home ?? ''}/.zh-bridge`
}

async function readRaw($: EngineInterface): Promise<Raw> {
  const dir = await zhHome($)
  try {
    return JSON.parse(await $.fs.read(`${dir}/config.json`)) as Raw
  } catch {
    return {}
  }
}

function maskKey(key: string | undefined): string {
  if (!key) return ''
  return key.length <= 8 ? '••••' : `${key.slice(0, 3)}…${key.slice(-4)}`
}

function toSettings(raw: Raw): ZhSettings {
  return {
    enabled: raw.enabled !== false,
    input: raw.input !== false,
    output: raw.output === 'off' ? 'off' : raw.output === 'always' ? 'always' : 'auto',
    target_lang: typeof raw.target_lang === 'string' ? raw.target_lang : 'Simplified Chinese',
    port: typeof raw.port === 'number' ? raw.port : 8787,
    model: raw.translator?.model ?? 'deepseek-flash',
    base_url: raw.translator?.base_url ?? 'https://api.deepseek.com',
    key_hint: maskKey(raw.translator?.api_key),
    prompt_input: raw.prompts?.input === 'custom' ? 'custom' : 'default',
    prompt_output: raw.prompts?.output === 'custom' ? 'custom' : 'default',
  }
}

async function refresh($: EngineInterface): Promise<ZhSettings> {
  const s = toSettings(await readRaw($))
  await update($, settings, () => s)
  let state: ZhHealth = 'down'
  try {
    const r = await $.process.run(['curl', '-s', '-m', '1', `http://127.0.0.1:${s.port}/__zh/health`], { timeoutMs: 3000 })
    if (r.exitCode === 0 && r.stdout.includes('"ok":true')) state = 'running'
  } catch {
    state = 'unknown'
  }
  await update($, health, () => state)
  return s
}

// Merge a change into config.json; everything not named is kept.
async function save($: EngineInterface, patch: Raw, nested?: { translator?: Record<string, string>; prompts?: Record<string, string> }): Promise<void> {
  const dir = await zhHome($)
  const raw = await readRaw($)
  const next: Raw = { ...raw, ...patch }
  if (nested?.translator) next.translator = { ...(raw.translator ?? {}), ...nested.translator }
  if (nested?.prompts) next.prompts = { ...(raw.prompts ?? {}), ...nested.prompts }
  try {
    await $.fs.write(`${dir}/config.json`, JSON.stringify(next, null, 2) + '\n')
    await update($, notice, () => null)
  } catch (err) {
    await update($, notice, () => `Could not write ${dir}/config.json: ${String(err)}`)
  }
  await update($, settings, () => toSettings(next))
}

// ---------------------------------------------------------------- dialogs

async function refocus($: EngineInterface, key: string): Promise<void> {
  await $.ui.focus({ requestId: activeSite, key }).catch(() => undefined)
}

// Model / API URL / API key: Claude Code's own question dialog (like /model):
// pick a preset with ↑↓ Enter, or type your own under "Type something".
async function askField($: EngineInterface, field: ZhField): Promise<void> {
  const s = await read($, settings)
  if (!s) return
  const current = field === 'model' ? s.model : field === 'base_url' ? s.base_url : s.key_hint
  const keep = `Keep current${current ? ` (${current})` : ''}`
  const presets = PRESETS[field].filter(p => p !== current)
  const options = field === 'api_key' ? [keep, 'Cancel'] : [keep, ...presets].slice(0, 4)
  const question = field === 'api_key'
    ? 'Paste your translator API key under "Type something", then Enter.'
    : `${FIELD_LABEL[field]}: pick one, or type your own under "Type something".`
  let answer: string
  try {
    answer = (await $.ui.ask(question, { options, header: FIELD_LABEL[field] })).trim()
  } catch {
    answer = '' // dismissed with Esc
  }
  editNonce += 1
  const isNoChange = !answer || answer === keep || answer === 'Cancel' || /^chat about this$/i.test(answer)
  if (!isNoChange) {
    await save($, {}, { translator: { [field]: field === 'base_url' ? answer.replace(/\/+$/, '') : answer } })
    await update($, notice, () => `${FIELD_LABEL[field]} saved.`)
  } else {
    await update($, settings, s0 => (s0 ? { ...s0 } : s0)) // redraw so the picker resets
  }
  await refocus($, field)
}

async function askPrompt($: EngineInterface, name: 'input' | 'output'): Promise<void> {
  const label = name === 'input' ? 'Input prompt' : 'Output prompt'
  let answer = ''
  try {
    answer = await $.ui.ask(`${label}: use the default, or your own (opens it in your editor)?`, {
      options: ['Default', 'Custom: edit in my editor'],
      header: label,
    })
  } catch { /* dismissed */ }
  editNonce += 1
  if (answer === 'Default') await useDefaultPrompt($, name)
  else if (answer.startsWith('Custom')) await editPrompt($, name)
  else await update($, settings, s0 => (s0 ? { ...s0 } : s0))
}

// What a number key (or Enter on a plain row) does to a row.
async function quick($: EngineInterface, row: RowKey): Promise<void> {
  const s = await read($, settings)
  if (!s) return
  switch (row) {
    case 'enabled': return save($, { enabled: !s.enabled })
    case 'input': return save($, { input: !s.input })
    case 'output': return save($, { output: s.output === 'auto' ? 'always' : s.output === 'always' ? 'off' : 'auto' })
    case 'lang': {
      const i = Math.max(0, LANGS.indexOf(s.target_lang))
      return save($, { target_lang: LANGS[(i + 1) % LANGS.length] })
    }
    case 'model': case 'base_url': case 'api_key': return askField($, row)
    case 'prompt_input': return askPrompt($, 'input')
    case 'prompt_output': return askPrompt($, 'output')
  }
}

function valueText(s: ZhSettings, row: RowKey): string {
  switch (row) {
    case 'enabled': return s.enabled ? 'On' : 'Off'
    case 'input': return s.input ? 'On' : 'Off'
    case 'output': return OUTPUT_LABEL[s.output]
    case 'lang': return LANG_LABEL[s.target_lang] ?? s.target_lang
    case 'model': return s.model
    case 'base_url': return s.base_url
    case 'api_key': return s.key_hint || 'not set'
    case 'prompt_input': return s.prompt_input === 'custom' ? 'Custom' : 'Default'
    case 'prompt_output': return s.prompt_output === 'custom' ? 'Custom' : 'Default'
  }
}

// ---------------------------------------------------------------- prompts

// Switch a prompt to custom: seed ~/.zh-bridge/prompts/<name>.txt from the default
// (first time only), then open it in the person's text editor.
async function editPrompt($: EngineInterface, name: 'input' | 'output'): Promise<void> {
  const dir = await zhHome($)
  const file = `${dir}/prompts/${name}.txt`
  if (!(await $.fs.exists(file))) {
    const seed = await $.fs.read(`${$.plugin.root}/scripts/lib/prompts/${name}.txt`)
    await $.fs.write(file, seed)
  }
  await save($, {}, { prompts: { [name]: 'custom' } })
  const home = (await $.env.get('HOME')) ?? ''
  const shown = home && file.startsWith(home) ? '~' + file.slice(home.length) : file
  let opened = false
  for (const argv of [['open', '-t', file], ['xdg-open', file]]) {
    try {
      const r = await $.process.run(argv, { timeoutMs: 5000 })
      if (r.exitCode === 0) { opened = true; break }
    } catch { /* try the next opener */ }
  }
  await update($, notice, () => opened
    ? `Opened ${shown}. Save it; used from your next message.`
    : `Edit ${shown}; used from your next message.`)
  await refocus($, `prompt_${name}`)
}

async function useDefaultPrompt($: EngineInterface, name: 'input' | 'output'): Promise<void> {
  await save($, {}, { prompts: { [name]: 'default' } })
  await update($, notice, () => `${name === 'input' ? 'Input' : 'Output'} prompt: back to default (your custom file is kept).`)
  await refocus($, `prompt_${name}`)
}

// ---------------------------------------------------------------- text commands

// ---------------------------------------------------------------- /zh show data

// Built from the current conversation only, the same messages Claude sees, so
// --resume brings a session's translations back, a /branch shares the ones from
// before the branch point, and other sessions never show up.
// The conversation holds your original prompts and the translated replies you
// were shown; the proxy's cache holds the other side of each (/__zh/lookup).
const SKIP_BLOCK = /^\s*<(system-reminder|local-command-stdout|local-command-stderr|local-command-caveat|bash-stdout|bash-stderr|task-notification)\b/
const CJK = /[㐀-䶿一-鿿豈-﫿]/
const COMMAND_ARGS = /<command-args>([\s\S]*?)<\/command-args>/
const COMMAND_ECHO = /^\s*<command-(name|message|args)>/

type Turn = { shown: string; keys: string[]; reply: string[] }

const blockText = (b: { type: string; [k: string]: unknown }): string | null =>
  b.type === 'text' && typeof b.text === 'string' && b.text.trim() ? b.text : null

async function lookup($: EngineInterface, port: number, q: { in: string[]; out: string[] }): Promise<{ in: (string | null)[]; out: (string | null)[] }> {
  const none = { in: q.in.map(() => null), out: q.out.map(() => null) }
  if (!q.in.length && !q.out.length) return none
  try {
    const r = await $.process.run(
      ['curl', '-s', '-m', '5', '-X', 'POST', '-H', 'content-type: application/json', '--data-binary', '@-', `http://127.0.0.1:${port}/__zh/lookup`],
      { stdin: JSON.stringify(q), timeoutMs: 8000 },
    )
    const j = JSON.parse(r.stdout)
    return { in: Array.isArray(j.in) ? j.in : none.in, out: Array.isArray(j.out) ? j.out : none.out }
  } catch {
    return none
  }
}

async function sessionTranslations($: EngineInterface): Promise<ZhEntry[]> {
  const messages = await $.session.messages({ as: 'api' })
  const turns: Turn[] = []
  for (const m of messages) {
    if (m.role === 'user') {
      if (m.content.some(b => b.type === 'tool_result')) continue // mid-turn
      const texts = m.content.map(blockText).filter((t): t is string => t !== null && !SKIP_BLOCK.test(t))
      if (!texts.length) continue
      const args = texts.map(t => t.match(COMMAND_ARGS)?.[1].trim()).find(a => a)
      // what you typed: a command's arguments, or the text that isn't a command echo (/branch, /clear…)
      const typed = texts.filter(t => !COMMAND_ECHO.test(t))
      const keys = args ? [args] : typed.filter(t => CJK.test(t))
      turns.push({ shown: args ?? (keys.length ? keys : typed).join('\n'), keys, reply: [] })
    } else if (turns.length) {
      // the turn's final reply: the text blocks of its last assistant message with text
      const texts = m.content.map(blockText).filter((t): t is string => t !== null)
      if (texts.length) turns[turns.length - 1].reply = texts
    }
  }
  const s = await read($, settings)
  const port = s?.port ?? toSettings(await readRaw($)).port
  const ins = turns.flatMap(t => t.keys)
  const outs = turns.flatMap(t => t.reply.filter(r => CJK.test(r)))
  const found = await lookup($, port, { in: ins, out: outs })
  const enIn = new Map(ins.map((t, i) => [t, found.in[i]]))
  const enOut = new Map(outs.map((t, i) => [t, found.out[i]]))

  const entries: ZhEntry[] = []
  for (const t of turns) {
    const inEn = t.keys.map(k => enIn.get(k)).filter((x): x is string => !!x)
    const outPairs = t.reply.filter(r => CJK.test(r)).map(r => [r, enOut.get(r)] as const).filter(([, en]) => !!en)
    if (!inEn.length && !outPairs.length) continue
    entries.push({
      ...(inEn.length ? { input_original: t.shown, input_sent_to_claude: inEn.join('\n\n') } : {}),
      ...(outPairs.length ? { output_shown_to_you: outPairs.map(([zh]) => zh).join('\n\n'), output_from_claude: outPairs.map(([, en]) => en).join('\n\n') } : {}),
    })
  }
  return entries
}

function statusText(s: ZhSettings, proxy: ZhHealth): string {
  const onOff = (b: boolean) => (b ? 'on' : 'off')
  return [
    `zh-bridge  ${proxy === 'running' ? `● proxy running on 127.0.0.1:${s.port}` : '○ proxy NOT running'}`,
    `  ${pad('Translation')}${onOff(s.enabled)}`,
    `  ${pad('Translate my input')}${onOff(s.input)}`,
    `  ${pad('Translate output')}${OUTPUT_LABEL[s.output]}`,
    `  ${pad('Reply language')}${LANG_LABEL[s.target_lang] ?? s.target_lang}`,
    `  ${pad('Model')}${s.model}`,
    `  ${pad('API URL')}${s.base_url}`,
    `  ${pad('API key')}${s.key_hint || 'not set'}`,
    `  ${pad('Input prompt')}${s.prompt_input}`,
    `  ${pad('Output prompt')}${s.prompt_output}`,
  ].join('\n')
}

// ---------------------------------------------------------------- typed prompts

// The proxy's "Always" mode translates a reply only when it answers something
// the person typed. Claude Code tells the plugin where each prompt came from,
// so remember the last few typed ones in ~/.zh-bridge/typed.json.
async function rememberTyped($: EngineInterface, text: string): Promise<void> {
  const t = text.trim()
  if (!t) return
  const file = `${await zhHome($)}/typed.json`
  let list: string[] = []
  try {
    const old = JSON.parse(await $.fs.read(file))
    if (Array.isArray(old)) list = old.filter((x): x is string => typeof x === 'string')
  } catch { /* first time */ }
  list = [...list.filter(x => x !== t), t].slice(-30)
  await $.fs.write(file, JSON.stringify(list)).catch(() => undefined)
}

// ---------------------------------------------------------------- drawing

type Els = ReturnType<EngineInterface['ui']['resolve']>

// The settings list: the same rows in the band and in the pane.
function drawSettings($: EngineInterface, els: Els, s: ZhSettings, proxy: ZhHealth, note: string | null, inPane: boolean, close: () => void) {
  const { Box, Text, Button } = els
  const proxyText = proxy === 'running' ? '● proxy running' : '○ proxy not running: restart Claude Code or run install.sh'

  const picker = (row: RowKey) => {
    if (!('Select' in els)) return <Text>{valueText(s, row)}</Text>
    const { Select } = els
    const onOff = (isOn: boolean, set: (value: boolean) => Promise<void>) => (
      <Select key={row} autoFocus={row === 'enabled' ? true : undefined} value={isOn ? 'on' : 'off'} options={ON_OFF}
        onSelect={(v: string) => void set(v === 'on')} />
    )
    switch (row) {
      case 'enabled': return onOff(s.enabled, isOn => save($, { enabled: isOn }))
      case 'input': return onOff(s.input, isOn => save($, { input: isOn }))
      case 'output':
        return (
          <Select key={row} value={s.output}
            options={(['auto', 'always', 'off'] as const).map(v => ({ value: v, label: OUTPUT_LABEL[v] }))}
            onSelect={(v: string) => void save($, { output: v })} />
        )
      case 'lang': {
        const langs = LANGS.includes(s.target_lang) ? LANGS : [...LANGS, s.target_lang]
        return (
          <Select key={row} value={s.target_lang} options={langs.map(l => ({ value: l, label: LANG_LABEL[l] ?? l }))}
            onSelect={(v: string) => void save($, { target_lang: v })} />
        )
      }
      case 'model': case 'base_url': case 'api_key':
        return (
          <Select key={row} value={`current-${editNonce}`}
            options={[{ value: `current-${editNonce}`, label: valueText(s, row) }, { value: 'change', label: row === 'api_key' ? 'Enter a new key…' : 'Change…' }]}
            onSelect={(v: string) => { if (v === 'change') void askField($, row) }} />
        )
      case 'prompt_input': case 'prompt_output': {
        const name = row === 'prompt_input' ? 'input' : 'output'
        const mode = row === 'prompt_input' ? s.prompt_input : s.prompt_output
        return (
          <Select key={row} value={mode === 'custom' ? `custom-${editNonce}` : 'default'}
            options={mode === 'custom'
              ? [{ value: 'default', label: 'Default' }, { value: `custom-${editNonce}`, label: 'Custom' }, { value: 'edit', label: 'Edit in editor…' }]
              : [{ value: 'default', label: 'Default' }, { value: 'edit', label: 'Custom (opens your editor)' }]}
            onSelect={(v: string) => {
              if (v === 'default') void useDefaultPrompt($, name)
              else if (v === 'edit') void editPrompt($, name)
            }} />
        )
      }
    }
  }

  const help = inPane
    ? 'Tab next row · ↑↓ choose · Enter set · 1–9 jump · Esc close'
    : '1–9 change a row · 0 close · Ctrl+X Tab to use Tab / ↑↓ / Enter · tip: after /tui default, /zh opens ready to use like /model'

  return (
    <Box flexDirection="column">
      <Text>
        <Text bold color="cyan">Chinese ⇄ English translation</Text>
        <Text dimColor>{`  ${proxyText} · translator: ${s.model}`}</Text>
      </Text>
      {ROWS.map((row, i) => (
        <Box key={`row-${row}`} flexDirection="row">
          <Button key={`n-${row}`} plain hotkey={String(i + 1)} label={pad(ROW_LABEL[row])} onPress={() => void quick($, row)} />
          <Text> </Text>
          {picker(row)}
          {row === 'api_key' && !s.key_hint && <Text color="red">  ← press 7 to add your key</Text>}
        </Box>
      ))}
      <Button key="close" plain hotkey="0" label="Close" onPress={close} />
      {note && <Text color={note.startsWith('Could not') ? 'red' : 'green'}>{note}</Text>}
      <Text dimColor>{help}</Text>
    </Box>
  )
}

// /zh show: original and English side by side, ◀ ▶ through history.
function drawShow($: EngineInterface, els: Els, list: ZhEntry[], idx: number, inPane: boolean, close: () => void) {
  const { Box, Text, Button, Markdown } = els
  const entry = list[idx]
  if (!entry) return <Text dimColor>No translations in this conversation yet.</Text>
  const go = (to: number) => update($, showIndex, () => Math.min(Math.max(to, 0), list.length - 1))

  // Drawn as Markdown, the way Claude Code draws a reply.
  const column = (title: string, text: string | undefined, isEnglish: boolean) => (
    <Box flexDirection="column" width="50%" borderStyle="round" borderColor="gray" paddingX={1}>
      <Text bold color={isEnglish ? 'cyan' : 'yellow'}>{title}</Text>
      <Markdown text={text?.trim() || '—'} />
    </Box>
  )
  const hasInput = !!entry.input_original
  const hasOutput = !!entry.output_from_claude
  const help = inPane
    ? '1 older · 2 newer · wheel / PgUp / PgDn scroll · Esc close'
    : '1 older · 2 newer · 0 close · mouse wheel scrolls'

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" gap={2}>
        <Text bold color="cyan">Translations</Text>
        <Button key="older" plain hotkey="1" autoFocus dimColor={idx === 0} label="◀ Older" onPress={() => void go(idx - 1)} />
        <Text bold>{idx + 1} / {list.length}</Text>
        <Button key="newer" plain hotkey="2" dimColor={idx === list.length - 1} label="Newer ▶" onPress={() => void go(idx + 1)} />
        <Button key="close" plain hotkey="0" label="Close" onPress={close} />
        <Text dimColor>{idx === list.length - 1 ? 'latest · this conversation' : 'this conversation'}</Text>
      </Box>
      <Text dimColor>{help}</Text>
      {hasInput && (
        <Box flexDirection="row">
          {column('You typed', entry.input_original, false)}
          {column('Claude saw', entry.input_sent_to_claude, true)}
        </Box>
      )}
      {hasOutput && (
        <Box flexDirection="row">
          {column('Shown to you', entry.output_shown_to_you, false)}
          {column('Claude wrote', entry.output_from_claude, true)}
        </Box>
      )}
      {!hasOutput && <Text dimColor>(the reply to this message was not translated)</Text>}
    </Box>
  )
}

// ---------------------------------------------------------------- hooks

export const register: Register = on => {
  let lastFocused = ''

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'zh',
      description: 'Chinese ⇄ English translation settings · /zh show: translations side by side',
    })
    return next(e)
  })

  on('command.run', { command: 'zh' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    // Default layout: a pane sits above the prompt and can take the keyboard.
    // Fullscreen docks panes at the side, so there we draw in the band instead.
    const isFullscreen = e.presentation?.isFullscreen !== false
    if (arg === 'show') {
      const h = await sessionTranslations($)
      if (!h.length) {
        return { text: 'No translations in this conversation yet. Write a message in Chinese, then run /zh show.' }
      }
      await update($, history, () => h)
      await update($, showIndex, () => h.length - 1)
      if (isFullscreen) {
        await update($, view, () => 'show')
      } else {
        await $.ui.open({ id: SHOW, title: 'zh-bridge · translations', focus: true, closeOnEscape: true, rows: 30 })
      }
      return {}
    }
    if (arg === 'on' || arg === 'off') {
      await save($, { enabled: arg === 'on' })
      return { text: `zh-bridge: translation ${arg}` }
    }
    if (arg === 'status') {
      const s = await refresh($)
      return { text: statusText(s, await read($, health)) }
    }
    if (arg !== '') {
      return { text: 'Usage: /zh (settings) · /zh show (translations side by side) · /zh on · /zh off · /zh status' }
    }
    lastFocused = ''
    await update($, notice, () => null)
    await refresh($)
    if (isFullscreen) {
      activeSite = BAND
      await update($, view, () => 'settings')
    } else {
      activeSite = PANE
      await $.ui.open({ id: PANE, title: 'zh-bridge', focus: true, closeOnEscape: true, rows: 16 })
    }
    return {}
  })

  // Sending a message closes whatever /zh shows in the band, and is remembered
  // as typed by the person (for "Always").
  on('prompt.submit', async ($, e, next) => {
    if ((await read($, view)) !== 'none') await update($, view, () => 'none')
    if (e.origin.kind === 'composer' || e.origin.kind === 'bridge') await rememberTyped($, e.text)
    return next(e)
  })

  // The text after a command (/btw …, /loop …, a skill) is typed by the person too.
  on('command.run', async ($, e, next) => {
    if ((e.origin.kind === 'composer' || e.origin.kind === 'bridge') && e.command !== 'zh' && e.args.trim()) {
      await rememberTyped($, e.args)
    }
    return next(e)
  })

  // In the settings list: Tab skips the row numbers and lands on the pickers,
  // and wraps around instead of leaving the list.
  on('ui.focus', async ($, e, next) => {
    const isSettings = e.component === 'Pane'
      ? e.requestId === PANE
      : (await read($, view)) === 'settings'
    if (!isSettings || e.origin.kind !== 'person') return next(e)
    activeSite = e.requestId
    const order = [...ROWS, 'close'] as string[]
    if (e.element?.startsWith('n-')) {
      const row = e.element.slice(2)
      const i = order.indexOf(row)
      const isBack = lastFocused === row
      const target = isBack ? order[(i - 1 + order.length) % order.length] : row
      lastFocused = target
      void refocus($, target)
      return {}
    }
    if (e.element) {
      if (order.includes(e.element)) lastFocused = e.element
      return next(e)
    }
    if (!lastFocused) return next(e)
    const target = lastFocused === order[0] ? order[order.length - 1] : order[0]
    lastFocused = target
    void refocus($, target)
    return {}
  })

  // Fullscreen: the band above the prompt.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    BAND = e.requestId
    const v = await read($, view)
    if (v === 'none' || e.props.hasSurvey) return next(e)
    const els = $.ui.resolve(e)
    const close = () => void update($, view, () => 'none')
    if (v === 'show') {
      const list = await read($, history)
      const idx = Math.min(Math.max(await read($, showIndex), 0), Math.max(list.length - 1, 0))
      return drawShow($, els, list, idx, false, close)
    }
    const s = await read($, settings)
    if (!s) return next(e)
    return drawSettings($, els, s, await read($, health), await read($, notice), false, close)
  })

  // Default layout: panes above the prompt, keyboard inside, Esc closes.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const s = await read($, settings)
    if (!s) {
      const { Text } = els
      return <Text dimColor>Loading…</Text>
    }
    return drawSettings($, els, s, await read($, health), await read($, notice), true, () => void $.ui.close({ id: PANE }))
  })

  on('ui.render', { component: 'Pane', requestId: SHOW }, async ($, e) => {
    const els = $.ui.resolve(e)
    const list = await read($, history)
    const idx = Math.min(Math.max(await read($, showIndex), 0), Math.max(list.length - 1, 0))
    return drawShow($, els, list, idx, true, () => void $.ui.close({ id: SHOW }))
  })
}
