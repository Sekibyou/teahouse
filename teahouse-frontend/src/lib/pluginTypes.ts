export interface Plugin {
  id: string
  name: string
  version: string
  description: string
  enabled: boolean
  permissions: string[]
  has_backend: boolean
  has_frontend: boolean
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
  }
  conflicts: string[]
  network_allowlist: { scheme: string; host: string; port: number | null }[]
  has_backend: boolean
  has_frontend: boolean
}
