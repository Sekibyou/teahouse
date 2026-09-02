export type ConfigFieldType = "text" | "password" | "number" | "select" | "switch" | "textarea"

export interface ConfigField {
  key: string
  type: ConfigFieldType
  label: string
  default?: string | number | boolean
  help?: string
  min?: number
  max?: number
  options?: { value: string; label: string }[]  // 仅 select
}

export interface Plugin {
  id: string
  name: string
  version: string
  description: string
  enabled: boolean
  permissions: string[]
  has_backend: boolean
  has_frontend: boolean
  /** Source git url for git-imported plugins; "" for zip-imported (custom). */
  git_url: string
  config: ConfigField[]
  /**
   * 插件声明的多语言字典：{ locale: { key: 文案 } }。
   * config 里 label/help/description/options[].label 若以 `key:` 前缀开头，
   * 前端按当前 locale 到此处取文案；取不到回退 key 字面量。
   */
  i18n?: Record<string, Record<string, string>>
}

export interface PluginData {
  [key: string]: string
}

export interface NetworkRule {
  id: string
  scheme: string
  host: string
  port: number | null
  source: "declare" | "user"
  enabled: boolean
}

export interface PluginPreview {
  preview_id: string
  available: boolean
  manifest: {
    id: string
    name: string
    version: string
    description: string
    permissions: string[]
    tools: { name: string; description: string; parameters: Record<string, unknown> }[]
    i18n?: Record<string, Record<string, string>>
  }
  conflicts: string[]
  network_allowlist: { scheme: string; host: string; port: number | null }[]
  has_backend: boolean
  has_frontend: boolean
  /** Source git url ("" for zip). Present so the update flow can reuse it. */
  git_url?: string
  /** True when a plugin with the same id is already installed (update, not install). */
  installed?: boolean
  installed_version?: string
}
