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
