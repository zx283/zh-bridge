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
  on('process.run', async (_$: any, e: any) => ({
    value: e.argv[0] === 'curl' && proxyUp ? { exitCode: 0, stdout: '{"ok":true}', stderr: '' } : { exitCode: 1, stdout: '', stderr: '' },
  }))
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

const BAND = { hasSurvey: false, isWorking: false, maxRows: 30, bodyColumns: 120, scroll: { offset: 0, bodyRows: 30 }, view: {} }
const mountBand = ($: any, surface: string) =>
  $.ui.mount({ plugin: 'zh-bridge', surface, component: 'AbovePrompt', props: BAND as any, requestId: 'above-prompt' } as any)

for (const surface of SURFACES) {
  test(`/zh opens a numbered list at the bottom; numbers and pickers save (${surface})`, async ($, on) => {
    const files: Record<string, string> = {
      [CONFIG]: JSON.stringify({ translator: { api_key: 'sk-secret-abcd', model: 'deepseek-chat' } }),
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
  test(`/zh show: side by side, newest first, older/newer (${surface})`, async ($, on) => {
    const files: Record<string, string> = {
      [CONFIG]: '{}',
      '/h/.zh-bridge/history.json': JSON.stringify([
        { at: '2026-01-01T00:00:00Z', input_original: '旧的消息', input_sent_to_claude: 'old message' },
        { at: '2026-01-02T00:00:00Z', input_original: '你好', input_sent_to_claude: 'Hello', output_from_claude: 'Hi there', output_shown_to_you: '你好呀' },
      ]),
    }
    fakeHost(on, files)
    const ui = await mountBand($, surface)
    await $.command.run({ command: 'zh', args: 'show' })
    expect(await ui.find({ text: /2 \/ 2/ })).toBeDefined()
    for (const t of ['You typed', 'Claude saw', 'Shown to you', 'Claude wrote', '你好呀', 'Hi there', 'Hello']) {
      expect(await ui.find({ text: t })).toBeDefined()
    }
    await ui.press({ key: 'older' })
    expect(await ui.find({ text: /1 \/ 2/ })).toBeDefined()
    expect(await ui.find({ text: 'old message' })).toBeDefined()
    expect(await ui.find({ text: /not translated/ })).toBeDefined()
    await ui.press({ key: 'older' }) // already oldest: stays
    expect(await ui.find({ text: /1 \/ 2/ })).toBeDefined()
    await ui.press({ key: 'newer' })
    expect(await ui.find({ text: /2 \/ 2/ })).toBeDefined()
    await ui.press({ key: 'close' }) // 0 closes
    expect(await ui.find({ text: /Translations/ })).toBeUndefined()
  })
}

test('/zh show with nothing yet, /zh off and /zh status answer as text', async ($, on) => {
  const files: Record<string, string> = { [CONFIG]: '{}' }
  fakeHost(on, files, false)
  const shown = await $.command.run({ command: 'zh', args: 'show' })
  expect(shown.text).toContain('Nothing translated yet')
  const off = await $.command.run({ command: 'zh', args: 'off' })
  expect(off.text).toContain('off')
  expect(cfg(files).enabled).toBe(false)
  const st = await $.command.run({ command: 'zh', args: 'status' })
  expect(st.text).toContain('NOT running')
  expect(st.text).toContain('not set')
})
