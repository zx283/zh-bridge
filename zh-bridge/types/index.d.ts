export type ZhSettings = {
  enabled: boolean
  input: boolean
  output: boolean
  target_lang: string
  port: number
  model: string
  base_url: string
  key_hint: string // masked, e.g. "sk-…3f2a"; "" when no key
  prompt_input: 'default' | 'custom'
  prompt_output: 'default' | 'custom'
}

export type ZhHealth = 'unknown' | 'running' | 'down'

export type ZhField = 'model' | 'base_url' | 'api_key'

export type ZhEntry = {
  at: string
  input_original?: string
  input_sent_to_claude?: string
  output_from_claude?: string
  output_shown_to_you?: string
}

declare module 'claude-code' {
  interface PluginState {
    'zh-bridge': {
      settings: ZhSettings | null
      health: ZhHealth
      notice: string | null
      view: 'none' | 'settings' | 'show'
      history: ZhEntry[]
      showIndex: number
    }
  }
}
