import { expect, mock, test } from 'claude-code/testing'

const SURFACES = ['terminal', 'desktop'] as const
const CONFIG = '/h/.zh-bridge/config.json'

// A fake disk + a fake proxy beneath the plugin.
function fakeHost(on: any, files: Record<string, string>, proxyUp = true) {
  mock.env(on, { HOME: '/h' })
  on('fs.read', async (_$: any, e: any) => {
    if (e.path.endsWith('/scripts/lib/prompts/input.txt') && !(e.path in files)) return { value: 'DEFAULT INPUT PROMPT' }
    if (!(e.path in files)) return { deny: 'ENOENT' }
    return { value: files[e.path] }
  })
  on('fs.write', async (_$: any, e: any) => {
    files[e.path] = e.text
    return { value: undefined }
  })
  // the proxy: health check, and /__zh/lookup answering from a fake translation cache
  on('process.run', async (_$: any, e: any) => {
    if (e.argv[0] !== 'curl' || !proxyUp) return { value: { exitCode: 7, stdout: '', stderr: '' } }
    if (e.argv.some((a: string) => a.includes('/__zh/lookup'))) {
      const q = JSON.parse(e.init?.stdin ?? '{}')
      const look = (list: string[]) => (list ?? []).map(t => CACHE[t] ?? null)
      return { value: { exitCode: 0, stdout: JSON.stringify({ in: look(q.in), out: look(q.out) }), stderr: '' } }
    }
    return { value: { exitCode: 0, stdout: '{"ok":true}', stderr: '' } }
  })
  on('fs.exists', async (_$: any, e: any) => ({ value: e.path in files }))
  on('command.register', async () => ({ value: { command: 'zh' } }))
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  on('ui.focus', async () => ({}))
  // What the engine draws in the band when no plugin claims it: nothing.
  on('ui.render', { component: 'AbovePrompt' }, async ($: any, e: any) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
}

const cfg = (files: Record<string, string>) => JSON.parse(files[CONFIG])

// The proxy's translation cache: original → the other side.
const CACHE: Record<string, string> = {
  旧的消息: 'old message',
  你好: 'Hello',
  你好呀: 'Hi there',
  分支里的问题: 'a question in the branch',
}
const text = (t: string) => ({ type: 'text', text: t })
// A conversation as $.session.messages({ as: 'api' }) returns it.
const CONVERSATION = [
  { role: 'user', content: [text('<system-reminder>project notes</system-reminder>'), text('旧的消息')] },
  { role: 'assistant', content: [text('ok, English reply that was not translated')] },
  { role: 'user', content: [text('你好')] },
  { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'file' }] },
  { role: 'assistant', content: [text('你好呀')] },
  // after /branch: the command echo and the next prompt arrive as one message
  { role: 'user', content: [text('<command-name>/branch</command-name>\n<command-message>branch</command-message>\n<command-args></command-args>'), text('分支里的问题')] },
  { role: 'assistant', content: [text('English, not translated')] },
  { role: 'user', content: [text('只在别的会话里出现')] }, // not in the cache: no entry
]

const BAND = { hasSurvey: false, isWorking: false, maxRows: 30, bodyColumns: 120, scroll: { offset: 0, bodyRows: 30 }, view: {} }
const mountBand = ($: any, surface: string) =>
  $.ui.mount({ plugin: 'zh-bridge', surface, component: 'AbovePrompt', props: BAND as any, requestId: 'above-prompt' } as any)

for (const surface of SURFACES) {
  test(`/zh opens a numbered list at the bottom; numbers and pickers save (${surface})`, async ($, on) => {
    const files: Record<string, string> = {
      [CONFIG]: JSON.stringify({ translator: { api_key: 'sk-secret-abcd', model: 'deepseek-flash' } }),
    }
    fakeHost(on, files)
    const ui = await mountBand($, surface)
    expect(await ui.findAll({ type: 'Select' })).toHaveLength(0) // closed until /zh

    await $.command.run({ command: 'zh', args: '' })
    expect(await ui.findAll({ type: 'Select' })).toHaveLength(9)
    expect(await ui.find({ key: 'n-enabled' })).toBeDefined()
    expect(await ui.find({ text: /secret/ })).toBeUndefined() // key never shown in full

    // number keys (row buttons) change a row straight away
    await ui.press({ key: 'n-output' }) // On → Always → Off → On
    expect(cfg(files).output).toBe('always')
    await ui.press({ key: 'n-output' })
    expect(cfg(files).output).toBe('off')
    await ui.press({ key: 'n-output' })
    expect(cfg(files).output).toBe('auto')
    await ui.press({ key: 'n-lang' })
    expect(cfg(files).target_lang).toBe('Traditional Chinese')
    await ui.press({ key: 'n-enabled' })
    expect(cfg(files).enabled).toBe(false)

    // pickers (after Ctrl+X Tab): ↑↓ + Enter
    const pick = (key: string, value: string) => $.ui.select({ plugin: 'zh-bridge', key, value, surface })
    await pick('input', 'off')
    expect(cfg(files).input).toBe(false)
    await pick('output', 'always')
    expect(cfg(files).output).toBe('always')
    await pick('lang', 'Japanese')
    expect(cfg(files).target_lang).toBe('Japanese')

    // 0 closes
    await ui.press({ key: 'close' })
    expect(await ui.findAll({ type: 'Select' })).toHaveLength(0)
  })
}

test('sending a message closes the list and is remembered as typed', async ($, on) => {
  const files: Record<string, string> = { [CONFIG]: '{}' }
  fakeHost(on, files)
  on('prompt.submit', async (_$: any, e: any) => ({ text: e.text }))
  const ui = await mountBand($, 'terminal')
  await $.command.run({ command: 'zh', args: '' })
  expect(await ui.findAll({ type: 'Select' })).toHaveLength(9)
  await $.prompt.submit({ text: 'hello', origin: { kind: 'composer' } } as any).catch(() => undefined)
  expect(await ui.findAll({ type: 'Select' })).toHaveLength(0)
  // typed prompts are remembered for "Always"
  expect(JSON.parse(files['/h/.zh-bridge/typed.json'] ?? '[]')).toContain('hello')
})

test('missing key is flagged', async ($, on) => {
  const files: Record<string, string> = { [CONFIG]: '{}' }
  fakeHost(on, files, false)
  await $.command.run({ command: 'zh', args: '' })
  const ui = await mountBand($, 'terminal')
  expect(await ui.find({ text: /press 7 to add your key/ })).toBeDefined()
  expect(await ui.find({ text: /proxy not running/ })).toBeDefined()
})

for (const surface of SURFACES) {
  test(`/zh show: this conversation only, side by side, older/newer (${surface})`, async ($, on) => {
    const files: Record<string, string> = { [CONFIG]: '{}' }
    fakeHost(on, files)
    on('session.messages', async () => ({ value: CONVERSATION }))
    const ui = await mountBand($, surface)
    await $.command.run({ command: 'zh', args: 'show' })
    expect(await ui.find({ text: /3 \/ 3/ })).toBeDefined() // 旧的消息, 你好, 分支里的问题
    expect(await ui.find({ text: '分支里的问题' })).toBeDefined()
    expect(await ui.find({ text: /command-name/ })).toBeUndefined() // the /branch echo isn't "You typed"
    await ui.press({ key: 'older' })
    for (const t of ['You typed', 'Claude saw', 'Shown to you', 'Claude wrote', '你好', 'Hello', '你好呀', 'Hi there']) {
      expect(await ui.find({ text: t })).toBeDefined()
    }
    await ui.press({ key: 'older' })
    expect(await ui.find({ text: /1 \/ 3/ })).toBeDefined()
    expect(await ui.find({ text: 'old message' })).toBeDefined()
    expect(await ui.find({ text: /not translated/ })).toBeDefined()
    expect(await ui.find({ text: /system-reminder/ })).toBeUndefined()
    await ui.press({ key: 'older' }) // already oldest: stays
    expect(await ui.find({ text: /1 \/ 3/ })).toBeDefined()
    await ui.press({ key: 'newer' })
    expect(await ui.find({ text: /2 \/ 3/ })).toBeDefined()
    await ui.press({ key: 'close' }) // 0 closes
    expect(await ui.find({ text: /Translations/ })).toBeUndefined()
  })
}

test('/zh show with nothing in this conversation, /zh off and /zh status answer as text', async ($, on) => {
  const files: Record<string, string> = { [CONFIG]: '{}' }
  fakeHost(on, files, false)
  on('session.messages', async () => ({ value: [{ role: 'user', content: [text('你好')] }] }))
  const shown = await $.command.run({ command: 'zh', args: 'show' })
  expect(shown.text).toContain('No translations in this conversation yet')
  const off = await $.command.run({ command: 'zh', args: 'off' })
  expect(off.text).toContain('off')
  expect(cfg(files).enabled).toBe(false)
  const st = await $.command.run({ command: 'zh', args: 'status' })
  expect(st.text).toContain('NOT running')
  expect(st.text).toContain('not set')
})
