import { getAuthToken, clearAuth } from "@/stores/authStore"
import type { Prototype, Instance, FileTreeNode, ActiveSession, LLMConfig, LLMProvider, LLMModel, ModelProfile, SlotBindings, SlotBinding, DirectorPromptPreset, AvailableModel, AppSettings, GitStatus, GitCommitResult, GitBranchResult, GitLogEntry, GitFileStatus } from "./types"
import type { Plugin, PluginData } from "./pluginTypes"

export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || "http://127.0.0.1:8000"
const REQUEST_TIMEOUT = 15000

interface RequestResult<T> {
  ok: boolean
  data?: T
  error?: string
}

async function request<T>(
  endpoint: string,
  options: RequestInit = {},
  skipAuth = false
): Promise<RequestResult<T>> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT)

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string>),
  }

  if (!skipAuth) {
    const token = getAuthToken()
    if (token) {
      headers["Authorization"] = `Bearer ${token}`
    }
  }

  try {
    const response = await fetch(`${API_BASE_URL}${endpoint}`, {
      ...options,
      signal: controller.signal,
      headers,
    })
    clearTimeout(timeoutId)

    if (response.status === 401) {
      clearAuth()
      return { ok: false, error: "认证已过期，请重新登录" }
    }

    // 204 No Content
    if (response.status === 204) {
      return { ok: true, data: undefined as T }
    }

    const json = await response.json()

    if (!response.ok) {
      return { ok: false, error: json.detail || `请求失败 (${response.status})` }
    }

    return { ok: true, data: json as T }
  } catch (error) {
    clearTimeout(timeoutId)
    if (error instanceof Error) {
      if (error.name === "AbortError") {
        return { ok: false, error: "请求超时" }
      }
      return { ok: false, error: error.message }
    }
    return { ok: false, error: "未知错误" }
  }
}

async function get<T>(endpoint: string): Promise<RequestResult<T>> {
  return request<T>(endpoint, { method: "GET" })
}

async function post<T>(endpoint: string, body?: unknown): Promise<RequestResult<T>> {
  return request<T>(endpoint, { method: "POST", body: body ? JSON.stringify(body) : undefined })
}

async function put<T>(endpoint: string, body?: unknown): Promise<RequestResult<T>> {
  return request<T>(endpoint, { method: "PUT", body: body ? JSON.stringify(body) : undefined })
}

async function patch<T>(endpoint: string, body?: unknown): Promise<RequestResult<T>> {
  return request<T>(endpoint, { method: "PATCH", body: body ? JSON.stringify(body) : undefined })
}

async function del<T>(endpoint: string): Promise<RequestResult<T>> {
  return request<T>(endpoint, { method: "DELETE" })
}

// Auth API
export const authApi = {
  login: async (username: string, password: string) => {
    return post<{ user: { user_id: string; username: string; display_name: string }; token: string }>(
      "/api/auth/login",
      { username, password }
    )
  },

  register: async (username: string, password: string, displayName?: string) => {
    return post<{ user: { user_id: string; username: string; display_name: string }; token: string }>(
      "/api/auth/register",
      { username, password, display_name: displayName }
    )
  },

  me: async () => {
    return get<{ user: { user_id: string; username: string; display_name: string } }>("/api/auth/me")
  },
}

// Prototypes API
export const prototypesApi = {
  list: async () => {
    return get<Prototype[]>("/api/prototypes")
  },

  create: async (instanceId: string, sourceSubpath: string, name: string, description: string, author: string, version: string) => {
    return post<Prototype>("/api/prototypes", {
      instance_id: instanceId,
      source_subpath: sourceSubpath,
      name,
      description,
      author,
      version,
    })
  },

  delete: async (id: string) => {
    return del<{ status: string }>(`/api/prototypes/${id}`)
  },

  downloadUrl: (id: string) => {
    const token = getAuthToken()
    return `${API_BASE_URL}/api/prototypes/${id}/download?token=${encodeURIComponent(token || "")}`
  },

  getReadme: async (id: string) => {
    return get<{ metadata: Record<string, unknown>; readme: string }>(`/api/prototypes/${id}/readme`)
  },

  import: async (file: File) => {
    const token = getAuthToken()
    const form = new FormData()
    form.append("file", file)
    const headers: Record<string, string> = {}
    if (token) headers["Authorization"] = `Bearer ${token}`
    const res = await fetch(`${API_BASE_URL}/api/prototypes/import`, {
      method: "POST",
      headers,
      body: form,
    })
    if (res.status === 401) {
      clearAuth()
      return { ok: false as const, error: "认证已过期，请重新登录" }
    }
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: "导入失败" }))
      return { ok: false as const, error: err.detail || `请求失败 (${res.status})` }
    }
    return { ok: true as const, data: await res.json() as { duplicate: boolean; prototype: Prototype; detail?: string } }
  },
}

// Instances API
export const instancesApi = {
  list: async () => {
    return get<Instance[]>("/api/instances")
  },

  create: async (prototypeId: string, name: string) => {
    return post<Instance>("/api/instances", { prototype_id: prototypeId, name })
  },

  delete: async (id: string) => {
    return del<{ status: string }>(`/api/instances/${id}`)
  },

  // File operations
  listFiles: async (instanceId: string) => {
    return get<FileTreeNode[]>(`/api/instances/${instanceId}/files`)
  },

  readFile: async (instanceId: string, path: string) => {
    return get<{ path: string; content: string }>(`/api/instances/${instanceId}/files/content?path=${encodeURIComponent(path)}`)
  },

  writeFile: async (instanceId: string, path: string, content: string) => {
    return put<{ path: string; status: string }>(`/api/instances/${instanceId}/files/content?path=${encodeURIComponent(path)}`, { content })
  },

  createEntry: async (instanceId: string, path: string, type: "file" | "directory") => {
    return post<{ path: string; status: string }>(`/api/instances/${instanceId}/files`, { path, type })
  },

  deleteEntry: async (instanceId: string, path: string) => {
    return del<{ path: string; status: string }>(`/api/instances/${instanceId}/files?path=${encodeURIComponent(path)}`)
  },

  // Director session memory (.sessions/)
  getSessionMemory: async (instanceId: string, opts?: { limit?: number; offset?: number }) => {
    const params = new URLSearchParams()
    if (opts?.limit) params.set("limit", String(opts.limit))
    if (opts?.offset) params.set("offset", String(opts.offset))
    const qs = params.toString()
    return get<{ records: Record<string, unknown>[]; total: number }>(`/api/instances/${instanceId}/session${qs ? `?${qs}` : ""}`)
  },

  clearSessionMemory: async (instanceId: string) => {
    return del<{ status: string }>(`/api/instances/${instanceId}/session`)
  },
}

// Session API
export const sessionApi = {
  getActive: async () => {
    return get<ActiveSession>("/api/session/active")
  },

  setActive: async (instanceId: string) => {
    return put<{ status: string; instance_id: string }>("/api/session/active", { instance_id: instanceId })
  },
}

// LLM Configs API (deprecated — use the new llmProvidersApi / llmModelsApi / modelProfilesApi / llmSlotsApi instead)
export const llmConfigsApi = {
  list: async () => {
    return get<{ configs: LLMConfig[] }>("/api/llm-configs/")
  },

  create: async (data: {
    label: string; api_url: string; api_key: string; model_name: string
    api_format?: string; max_tokens?: number; temperature?: number; is_default?: boolean
  }) => {
    return post<{ config: LLMConfig }>("/api/llm-configs/", data)
  },

  update: async (id: string, data: Record<string, unknown>) => {
    return put<{ config: LLMConfig }>(`/api/llm-configs/${id}`, data)
  },

  delete: async (id: string) => {
    return del<{ status: string }>(`/api/llm-configs/${id}`)
  },
}

// Chat API
export const chatApi = {
  send: async (messages: { role: string; content: string }[]) => {
    return post<{ status: string; full_text: string }>("/v1/chat", {
      messages,
      stream: false,
    })
  },

  /** Streaming chat: returns a ReadableStream of SSE events.
   *  Each chunk has the shape { type: "reasoning" | "text", text: string }.
   *  The stream ends with event: done.
   *  slot_id: "director" | "writer" — which model slot to use. */
  sendStream: async (messages: { role: string; content: string }[], signal?: AbortSignal, slotId?: string) => {
    const token = getAuthToken()
    const response = await fetch(`${API_BASE_URL}/v1/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      signal,
      body: JSON.stringify({ messages, stream: true, ...(slotId ? { slot_id: slotId } : {}) }),
    })
    if (!response.ok) {
      const err = await response.json().catch(() => ({ detail: "请求失败" }))
      throw new Error(err.detail || `HTTP ${response.status}`)
    }
    return response.body!
  },

  /** Streaming chat with tool use: like sendStream but with tools + instance_id.
   *  Events can include tool_call, tool_result, text, reasoning. */
  sendToolStream: async (messages: { role: string; content: string }[], instanceId: string, signal?: AbortSignal) => {
    const token = getAuthToken()
    const response = await fetch(`${API_BASE_URL}/v1/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      signal,
      body: JSON.stringify({ messages, stream: true, tools: true, instance_id: instanceId }),
    })
    if (!response.ok) {
      const err = await response.json().catch(() => ({ detail: "请求失败" }))
      throw new Error(err.detail || `HTTP ${response.status}`)
    }
    return response.body!
  },
}

// Git API
export const gitApi = {
  getStatus: async (instanceId: string) => {
    return get<GitStatus>(`/api/instances/${instanceId}/git/status`)
  },

  refresh: async (instanceId: string) => {
    return get<{ git: GitStatus; file_statuses: GitFileStatus[] }>(`/api/instances/${instanceId}/refresh`)
  },

  commit: async (instanceId: string, params: { type: string; number?: number; start?: number; end?: number; message: string }) => {
    return post<GitCommitResult>(`/api/instances/${instanceId}/git/commit`, params)
  },

  branch: async (instanceId: string, action: string, name?: string, startPoint?: string) => {
    return post<GitBranchResult>(`/api/instances/${instanceId}/git/branch`, { action, name, start_point: startPoint })
  },

  log: async (instanceId: string, limit: number = 10) => {
    return get<{ commits: GitLogEntry[] }>(`/api/instances/${instanceId}/git/log?limit=${limit}`)
  },

  fileStatus: async (instanceId: string) => {
    return get<{ files: GitFileStatus[] }>(`/api/instances/${instanceId}/git/file-status`)
  },

  reset: async (instanceId: string, targetHash: string) => {
    return post<{ status: string; branch: string; message: string }>(
      `/api/instances/${instanceId}/git/reset`, { target_hash: targetHash }
    )
  },

  renameBranch: async (instanceId: string, oldName: string, newName: string) => {
    return post<{ status: string; branch: string; message: string }>(
      `/api/instances/${instanceId}/git/rename-branch`, { old_name: oldName, new_name: newName }
    )
  },

  deleteBranch: async (instanceId: string, name: string) => {
    return post<{ status: string; message: string }>(
      `/api/instances/${instanceId}/git/delete-branch`, { action: "delete", name }
    )
  },

  deleteNode: async (instanceId: string, targetHash: string, branchName: string) => {
    return post<{ status: string; branch: string; message: string }>(
      `/api/instances/${instanceId}/git/delete-node`, { target_hash: targetHash, branch_name: branchName }
    )
  },

  discard: async (instanceId: string, path?: string) => {
    return post<{ status: string; message: string }>(
      `/api/instances/${instanceId}/git/discard`, { path }
    )
  },

  showFile: async (instanceId: string, filePath: string) => {
    return get<{ content: string | null }>(
      `/api/instances/${instanceId}/git/show-file?path=${encodeURIComponent(filePath)}`
    )
  },

  approveTool: async (instanceId: string, toolCallId: string, args: Record<string, unknown>) => {
    return post<{ status: string }>(`/api/instances/${instanceId}/tool-approve`, { tool_call_id: toolCallId, args })
  },
  rejectTool: async (instanceId: string, toolCallId: string, reason?: string) => {
    return post<{ status: string }>(`/api/instances/${instanceId}/tool-reject`, { tool_call_id: toolCallId, reason })
  },
}

// Text style rules API
export const textStyleRulesApi = {
  get: async (instanceId: string) => {
    return get<{ rules: import("@/lib/types").TextStyleRule[] }>(
      `/api/instances/${instanceId}/text-style-rules`
    )
  },
}

// Sandbox source API — reads .teahouse/output/sandbox/ (file-system driven)
export const sandboxSrcApi = {
  get: async (instanceId: string) => {
    return get<{ files: Record<string, string> }>(
      `/api/instances/${instanceId}/sandbox-src`
    )
  },
}

// Floors API — sorted floor listing from .teahouse/output/floors/
export interface FloorEntry {
  num: number
  path: string
  draft: boolean
}

export const floorsApi = {
  list: async (instanceId: string) => {
    return get<{ floors: FloorEntry[] }>(`/api/instances/${instanceId}/floors`)
  },
}

// Sandbox vars API — instance variable state persisted to .teahouse/runtime_vars.jsonl
export interface SandboxVarEntry {
  name: string
  value: unknown
  note?: string
  change_log?: unknown[]
}

export interface SandboxVarsUpdate {
  updates?: Record<string, unknown>
  note?: Record<string, string>
  change_log?: Record<string, unknown>
  delete?: string[]
}

export const sandboxVarsApi = {
  get: async (instanceId: string, names: string[]) => {
    const params = names.length
      ? `?${names.map((n) => `names=${encodeURIComponent(n)}`).join("&")}`
      : ""
    return get<{ vars: SandboxVarEntry[] }>(`/api/instances/${instanceId}/runtime-vars${params}`)
  },
  set: async (instanceId: string, payload: SandboxVarsUpdate) => {
    return patch<{ status: string; vars: SandboxVarEntry[] }>(
      `/api/instances/${instanceId}/runtime-vars`,
      payload
    )
  },
}

// LLM Providers API
export const llmProvidersApi = {
  list: () => get<{ providers: LLMProvider[] }>("/api/llm/providers/"),
  create: (data: { name: string; api_url: string; api_key: string; api_format?: string }) =>
    post<{ provider: LLMProvider }>("/api/llm/providers/", data),
  update: (id: string, data: Record<string, unknown>) =>
    put<{ provider: LLMProvider }>(`/api/llm/providers/${id}`, data),
  delete: (id: string) => del<{ status: string }>(`/api/llm/providers/${id}`),
  availableModels: (id: string, fetchUrl?: string) =>
    get<{ models: AvailableModel[] }>(`/api/llm/providers/${id}/available-models${fetchUrl ? `?url=${encodeURIComponent(fetchUrl)}` : ""}`),
  importModels: (providerId: string, modelProfiles: Record<string, string>) =>
    post<{ created: LLMModel[]; skipped: string[] }>(`/api/llm/providers/${providerId}/import-models`, {
      model_profiles: modelProfiles,
    }),
}

// LLM Models API
export const llmModelsApi = {
  list: () => get<{ models: LLMModel[] }>("/api/llm/models/"),
  listEnabled: () => get<{ models: LLMModel[] }>("/api/llm/models/enabled"),
  create: (data: { name: string; provider_id: string; model_name: string; profile_id?: string }) =>
    post<{ model: LLMModel }>("/api/llm/models/", data),
  update: (id: string, data: Record<string, unknown>) =>
    put<{ model: LLMModel }>(`/api/llm/models/${id}`, data),
  delete: (id: string) => del<{ status: string }>(`/api/llm/models/${id}`),
  deleteBatch: (modelIds: string[]) =>
    request<{ deleted: string[]; not_found: string[] }>("/api/llm/models/", {
      method: "DELETE",
      body: JSON.stringify({ model_ids: modelIds }),
    }),
  batchBind: (bindings: Record<string, string>) =>
    request<{ updated: string[]; models: LLMModel[] }>("/api/llm/models/batch-bind-profile", {
      method: "PATCH",
      body: JSON.stringify({ bindings }),
    }),
  batchToggle: (modelIds: string[], isEnabled: boolean) =>
    request<{ updated: string[] }>("/api/llm/models/batch-toggle", {
      method: "PATCH",
      body: JSON.stringify({ model_ids: modelIds, is_enabled: isEnabled }),
    }),
  ping: (id: string) =>
    post<{ success: boolean; latency?: number; error?: string }>(`/api/llm/models/${id}/ping`),
}

// Model Profiles API
export const modelProfilesApi = {
  list: () => get<{ profiles: ModelProfile[] }>("/api/llm/profiles/"),
  create: (data: Partial<ModelProfile> & { name: string }) =>
    post<{ profile: ModelProfile }>("/api/llm/profiles/", data),
  update: (id: string, data: Record<string, unknown>) =>
    put<{ profile: ModelProfile }>(`/api/llm/profiles/${id}`, data),
  delete: (id: string) => del<{ status: string }>(`/api/llm/profiles/${id}`),
  match: (modelName: string) =>
    get<{ matches: ModelProfile[] }>(`/api/llm/profiles/match?model_name=${encodeURIComponent(modelName)}`),
}

// LLM Slots API
export const llmSlotsApi = {
  getAll: () => get<{ slots: SlotBindings }>("/api/llm/slots/"),
  setAll: (bindings: SlotBindings) =>
    put<{ slots: SlotBindings }>("/api/llm/slots/", bindings),
  setSlot: (slotId: string, data: { model_id?: string | null; profile_id?: string | null; prompt_preset_id?: string | null }) =>
    put<{ slot_id: string; model_id: string | null; profile_id: string | null; prompt_preset_id: string | null }>(`/api/llm/slots/${slotId}`, data),
  clearSlot: (slotId: string) => del<{ status: string }>(`/api/llm/slots/${slotId}`),
}

// Director Prompt Presets API
export const directorPromptPresetsApi = {
  list: () => get<{ presets: DirectorPromptPreset[] }>("/api/llm/prompt-presets/"),
  create: (data: { name: string; template_yaml: string }) =>
    post<{ preset: DirectorPromptPreset }>("/api/llm/prompt-presets/", data),
  update: (id: string, data: { name?: string; template_yaml?: string }) =>
    put<{ preset: DirectorPromptPreset }>(`/api/llm/prompt-presets/${id}`, data),
  delete: (id: string) => del<{ status: string }>(`/api/llm/prompt-presets/${id}`),
}

// App Settings API
export const appSettingsApi = {
  get: () => get<AppSettings>("/api/settings"),
  update: (data: Partial<AppSettings>) => put<AppSettings>("/api/settings", data),
}

// Plugins API
export const pluginsApi = {
  list: () => get<{ plugins: Plugin[] }>("/api/plugins"),
  get: (id: string) => get<Plugin>(`/api/plugins/${id}`),
  enable: (id: string) => post<{ status: string; plugin_id: string; enabled: boolean }>(`/api/plugins/${id}/enable`),
  disable: (id: string) => post<{ status: string; plugin_id: string; enabled: boolean }>(`/api/plugins/${id}/disable`),
  uninstall: (id: string) => del<{ status: string; plugin_id: string; message: string }>(`/api/plugins/${id}`),
  importZip: (form: FormData) => {
    const token = getAuthToken()
    const headers: Record<string, string> = {}
    // Don't set Content-Type — browser sets it with boundary for multipart
    if (token) headers["Authorization"] = `Bearer ${token}`
    return fetch(`${API_BASE_URL}/api/plugins/import`, {
      method: "POST",
      headers,
      body: form,
    }).then(r => r.ok ? { ok: true as const, data: r.json() } : { ok: false as const, error: "导入失败" })
  },
  getData: (id: string) => get<{ plugin_id: string; data: PluginData }>(`/api/plugins/${id}/data`),
  setData: (id: string, data: PluginData) => put<{ status: string; plugin_id: string }>(`/api/plugins/${id}/data`, { data }),
  deleteData: (id: string, key: string) => del<{ status: string }>(`/api/plugins/${id}/data/${key}`),
}
