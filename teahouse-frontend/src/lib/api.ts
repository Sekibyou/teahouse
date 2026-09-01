import { getAuthToken, clearAuth } from "@/stores/authStore"
import { getApiBaseUrl } from "@/lib/apiBaseUrl"
import type { Prototype, Instance, FileTreeNode, ActiveSession, LLMConfig, LLMProvider, LLMModel, ModelProfile, SlotBindings, DirectorPromptPreset, AvailableModel, AppSettings, GitStatus, GitCommitResult, GitBranchResult, GitLogEntry, GitFileStatus, CoverResponse, FloorsStats, ContextUsage } from "./types"
import type { Plugin, PluginData, NetworkRule, PluginPreview } from "./pluginTypes"

const REQUEST_TIMEOUT = 15000

/**
 * The frontend represents the instance root as "root". Every file path it
 * exposes to the UI is "root/<rel>" (e.g. "root/teahouse.md"). The backend
 * uses bare instance-relative paths, so this module is the single boundary:
 * it strips the prefix on the way out (toBackendPath) and adds it on the way
 * in from listFiles (see instancesApi.listFiles).
 */
export const ROOT = "root"
export const toBackendPath = (p: string): string =>
  p === ROOT ? "" : p.startsWith(ROOT + "/") ? p.slice(ROOT.length + 1) : p
export const toFrontendPath = (p: string): string =>
  p === "" ? ROOT : p.startsWith(ROOT + "/") ? p : `${ROOT}/${p}`
const addRootToTree = <T extends FileTreeNode>(nodes: T[]): T[] =>
  nodes.map((n) => ({
    ...n,
    path: toFrontendPath(n.path),
    children: n.children ? addRootToTree(n.children) : n.children,
  }))


interface RequestResult<T> {
  ok: boolean
  data?: T
  error?: string
  status?: number
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
    const response = await fetch(`${getApiBaseUrl()}${endpoint}`, {
      ...options,
      signal: controller.signal,
      headers,
    })
    clearTimeout(timeoutId)

    if (response.status === 401 && !skipAuth) {
      clearAuth()
      return { ok: false, error: "认证已过期，请重新登录" }
    }

    // 204 No Content
    if (response.status === 204) {
      return { ok: true, data: undefined as T }
    }

    const json = await response.json()

    if (!response.ok) {
      return { ok: false, status: response.status, error: json.detail || `请求失败 (${response.status})` }
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
export interface AuthUser {
  user_id: string
  username: string
  display_name: string
  role: "super" | "admin" | "user"
}

export const authApi = {
  login: async (username: string, password: string) => {
    return request<{ user: AuthUser; token: string }>(
      "/api/auth/login",
      { method: "POST", body: JSON.stringify({ username, password }) },
      true // public endpoint — never treat a 401 here as "token expired"
    )
  },

  register: async (username: string, password: string, displayName?: string, inviteKey?: string) => {
    return request<{ user: AuthUser; token: string }>(
      "/api/auth/register",
      { method: "POST", body: JSON.stringify({ username, password, display_name: displayName, invite_key: inviteKey }) },
      true // public endpoint — 401/403 surface their real detail
    )
  },

  me: async () => {
    return get<AuthUser>("/api/auth/me")
  },

  registrationStatus: async () => {
    return get<{ mode: "disabled" | "open" | "invite"; allow_registration: boolean }>("/api/auth/registration")
  },
}

// Invite-key management API (admin / super admin)
export interface InviteKey {
  id: string
  key: string
  issued_by: string
  issued_by_username?: string | null
  created_at: number
}

export const inviteKeysApi = {
  list: async () => {
    return get<InviteKey[]>("/api/invite-keys")
  },
  create: async () => {
    return post<InviteKey>("/api/invite-keys", {})
  },
  revoke: async (id: string) => {
    return del<{ status: string }>(`/api/invite-keys/${id}`)
  },
}

// User management API (admin / super admin)
export interface ManagedUser {
  id: string
  username: string
  display_name: string
  role: "super" | "admin" | "user"
  is_active: boolean
  created_at: number
}

export const usersApi = {
  list: async () => {
    return get<ManagedUser[]>("/api/users")
  },
  create: async (body: { username: string; password: string; display_name?: string; role?: string }) => {
    return post<ManagedUser>("/api/users", body)
  },
  update: async (id: string, body: { display_name?: string; password?: string; role?: string; old_password?: string }) => {
    return patch<ManagedUser>(`/api/users/${id}`, body)
  },
  delete: async (id: string) => {
    return del<{ status: string }>(`/api/users/${id}`)
  },
}

// Prototypes API
export const prototypesApi = {
  list: async () => {
    return get<Prototype[]>("/api/prototypes")
  },

  create: async (instanceId: string, name: string, description: string, author: string, version: string) => {
    return post<Prototype>("/api/prototypes", {
      instance_id: instanceId,
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
    return `${getApiBaseUrl()}/api/prototypes/${id}/download?token=${encodeURIComponent(token || "")}`
  },

  getReadme: async (id: string) => {
    return get<{ metadata: Record<string, unknown>; readme: string }>(`/api/prototypes/${id}/readme`)
  },

  getCover: async (id: string) => {
    return get<CoverResponse>(`/api/prototypes/${id}/cover`)
  },

  import: async (file: File) => {
    const token = getAuthToken()
    const form = new FormData()
    form.append("file", file)
    const headers: Record<string, string> = {}
    if (token) headers["Authorization"] = `Bearer ${token}`
    const res = await fetch(`${getApiBaseUrl()}/api/prototypes/import`, {
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
export interface ToolsRunStep {
  tool: string
  args?: Record<string, unknown>
}

export interface ToolsRunResult {
  ok: boolean
  /** 即发即返：请求只确认已受理，不返回每步结果；实际产出由 SSE (file_changed) 推送刷新 */
  accepted: boolean
  steps: number
  /** 本批 run_uuid，供沙盒在生成中途调用 cancelRunTools 打断 */
  run_uuid?: string
}

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

  copy: async (id: string, name: string) => {
    return post<Instance>(`/api/instances/${id}/copy`, { name })
  },

  rename: async (id: string, name: string) => {
    return patch<Instance>(`/api/instances/${id}`, { name })
  },

  // File operations — every path is "root/..." on the frontend; converted to
  // the backend's bare relative path at this boundary (and back for listFiles).
  listFiles: async (instanceId: string) => {
    const res = await get<FileTreeNode[]>(`/api/instances/${instanceId}/files`)
    if (res.ok && res.data) res.data = addRootToTree(res.data)
    return res
  },

  readText: async (instanceId: string, path: string) => {
    return get<{ path: string; content: string }>(`/api/instances/${instanceId}/files/content?path=${encodeURIComponent(toBackendPath(path))}`)
  },

  readAsset: async (instanceId: string, path: string) => {
    return get<{ path: string; mime: string; data: string; size: readonly [number, number] | null }>(`/api/instances/${instanceId}/files/asset?path=${encodeURIComponent(toBackendPath(path))}`)
  },

  getCover: async (instanceId: string) => {
    return get<CoverResponse>(`/api/instances/${instanceId}/cover`)
  },

  writeFile: async (instanceId: string, path: string, content: string) => {
    return put<{ path: string; status: string }>(`/api/instances/${instanceId}/files/content?path=${encodeURIComponent(toBackendPath(path))}`, { content })
  },

  uploadFile: async (instanceId: string, path: string, file: File) => {
    const token = getAuthToken()
    const form = new FormData()
    form.append("file", file)
    const headers: Record<string, string> = {}
    if (token) headers["Authorization"] = `Bearer ${token}`
    const res = await fetch(`${getApiBaseUrl()}/api/instances/${instanceId}/files/upload?path=${encodeURIComponent(toBackendPath(path))}`, {
      method: "POST",
      headers,
      body: form,
    })
    if (res.status === 401) {
      clearAuth()
      return { ok: false as const, error: "认证已过期，请重新登录" }
    }
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: "上传失败" }))
      return { ok: false as const, error: err.detail || `请求失败 (${res.status})` }
    }
    return { ok: true as const, data: await res.json() as { path: string; size: number; status: string } }
  },

  createEntry: async (instanceId: string, path: string, type: "file" | "directory") => {
    return post<{ path: string; status: string }>(`/api/instances/${instanceId}/files`, { path: toBackendPath(path), type })
  },

  deleteEntry: async (instanceId: string, path: string) => {
    return del<{ path: string; status: string }>(`/api/instances/${instanceId}/files?path=${encodeURIComponent(toBackendPath(path))}`)
  },

  renameEntry: async (instanceId: string, path: string, newName: string) => {
    return patch<{ path: string; status: string }>(
      `/api/instances/${instanceId}/files/rename?path=${encodeURIComponent(toBackendPath(path))}`,
      { new_name: newName },
    )
  },

  moveEntry: async (instanceId: string, path: string, destParent: string) => {
    return patch<{ path: string; status: string }>(
      `/api/instances/${instanceId}/files/move?path=${encodeURIComponent(toBackendPath(path))}`,
      { dest_parent: toBackendPath(destParent) },
    )
  },

  // Director session memory (.sessions/) — unified for all sessions
  getSessionMemory: async (instanceId: string, sessionId: string = "main", opts?: { limit?: number; offset?: number }) => {
    const params = new URLSearchParams()
    if (opts?.limit) params.set("limit", String(opts.limit))
    if (opts?.offset) params.set("offset", String(opts.offset))
    const qs = params.toString()
    return get<{ records: Record<string, unknown>[]; total: number; next_offset: number }>(
      `/api/instances/${instanceId}/sessions/${sessionId}${qs ? `?${qs}` : ""}`,
    )
  },

  clearSessionMemory: async (instanceId: string, sessionId: string = "main") => {
    return del<{ status: string; session_id: string }>(
      `/api/instances/${instanceId}/sessions/${sessionId}`,
    )
  },

  // Session lifecycle (multi-session director tasks)
  createSession: async (instanceId: string, enabledTools?: string[], reasoningEffort?: string) => {
    return post<{ session_id: string; enabled_tools: string[]; reasoning_effort?: string }>(
      `/api/instances/${instanceId}/sessions`,
      { enabled_tools: enabledTools, reasoning_effort: reasoningEffort },
    )
  },

  setSessionReasoning: async (instanceId: string, sessionId: string, effort: string) => {
    return post<{ session_id: string; reasoning_effort: string | null; scope: string }>(
      `/api/instances/${instanceId}/sessions/${sessionId}/reasoning`,
      { effort },
    )
  },

  setSessionPermissions: async (instanceId: string, sessionId: string, action: "add" | "remove", tools: string[]) => {
    return post<{ session_id: string; enabled_tools: string[] }>(
      `/api/instances/${instanceId}/sessions/${sessionId}/permissions`,
      { action, tools },
    )
  },

  getSessionReasoning: async (instanceId: string, sessionId: string) => {
    return get<{ session_id: string; reasoning_effort: string | null; scope: string }>(
      `/api/instances/${instanceId}/sessions/${sessionId}/reasoning`,
    )
  },

  listSessions: async (instanceId: string) => {
    return get<{ sessions: { session_id: string; record_count: number }[] }>(
      `/api/instances/${instanceId}/sessions`,
    )
  },

  getSessionsStatus: async (instanceId: string) => {
    return get<{ sessions: Record<string, boolean>; stats: Record<string, { elapsed: number; token_count: number }> }>(`/api/instances/${instanceId}/sessions/status`)
  },

  contextUsage: async (instanceId: string, sessionId = "main") => {
    return get<ContextUsage>(`/api/instances/${instanceId}/context-usage?session_id=${encodeURIComponent(sessionId)}`)
  },

  destroySession: async (instanceId: string, sessionId: string, abort = false) => {
    return del<{ status: string; session_id: string }>(
      `/api/instances/${instanceId}/sessions/${sessionId}${abort ? "?abort=true" : ""}`,
    )
  },

  interruptSession: async (instanceId: string, sessionId: string) => {
    return post<{ status: string; session_id: string }>(
      `/api/instances/${instanceId}/sessions/${sessionId}/interrupt`,
    )
  },

  runTools: async (instanceId: string, steps: ToolsRunStep[]) => {
    return post<ToolsRunResult>(`/api/instances/${instanceId}/tools/run`, { steps })
  },

  cancelRunTools: async (instanceId: string, runUuid: string) => {
    return post<{ status: string; run_uuid: string; cancelled: boolean }>(
      `/api/instances/${instanceId}/tools/run/${runUuid}/cancel`,
    )
  },
}

// Tools API — builtin tool list with short descriptions (for permission autocomplete)
export const toolsApi = {
  listTools: async () => {
    return get<{ tools: { name: string; short: string }[] }>("/api/tools")
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
  sendStream: async (messages: Record<string, unknown>[], signal?: AbortSignal, slotId?: string) => {
    const token = getAuthToken()
    const response = await fetch(`${getApiBaseUrl()}/v1/chat`, {
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

  /** Send a director message: POSTs to /v1/chat which enqueues the message
   *  into the backend session loop. The backend persists it and streams results
   *  via session_event SSE broadcast. */
  sendDirectorMessage: async (messages: { role: string; content: string | { manual: string; pastes: { id: number; content: string }[] } }[], instanceId: string, sessionId?: string) => {
    const token = getAuthToken()
    const response = await fetch(`${getApiBaseUrl()}/v1/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        messages,
        stream: true,
        tools: true,
        instance_id: instanceId,
        session_id: sessionId || "main",
      }),
    })
    if (!response.ok) {
      const err = await response.json().catch(() => ({ detail: "请求失败" }))
      throw new Error(err.detail || `HTTP ${response.status}`)
    }
    const data = await response.json()
    return data as { queued: boolean; session_id: string; count?: number }
  },
}

// Git API
export const gitApi = {
  getStatus: async (instanceId: string) => {
    return get<GitStatus>(`/api/instances/${instanceId}/git/status`)
  },

  refresh: async (instanceId: string) => {
    return get<{ git: GitStatus; file_statuses: GitFileStatus[]; floors: FloorsStats | null }>(`/api/instances/${instanceId}/refresh`)
  },

  commit: async (instanceId: string, params: { type: string; number?: number; start?: number; end?: number; message: string; paths?: string[] }) => {
    const body = { ...params, paths: params.paths?.map(toBackendPath) }
    return post<GitCommitResult>(`/api/instances/${instanceId}/git/commit`, body)
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
      `/api/instances/${instanceId}/git/discard`, { path: path ? toBackendPath(path) : undefined }
    )
  },

  showFile: async (instanceId: string, filePath: string) => {
    return get<{ content: string | null }>(
      `/api/instances/${instanceId}/git/show-file?path=${encodeURIComponent(toBackendPath(filePath))}`
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

// Sandbox source API — engine built-in bootstrap + instance UI files
export const sandboxSrcApi = {
  get: async (instanceId: string) => {
    return get<{ bootstrap: string[]; files: Record<string, string> }>(
      `/api/instances/${instanceId}/sandbox-src`
    )
  },
}

// Floors API — sorted floor listing from runtime/floors/
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

// Sandbox vars API — instance variable state persisted to runtime/runtime_vars.jsonl
export interface SandboxVarEntry {
  name: string
  value: unknown
  type?: "number" | "string" | "boolean" | "array"
  min?: number
  max?: number
  note?: string
  change_log?: unknown[]
}

export interface SandboxVarMeta {
  type?: "number" | "string" | "boolean" | "array"
  min?: number
  max?: number
}

export interface SandboxVarsUpdate {
  updates?: Record<string, unknown>
  note?: Record<string, string>
  change_log?: Record<string, unknown>
  meta?: Record<string, SandboxVarMeta>
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
  create: (data: { name: string; template_yaml: string; match_pattern?: string | null }) =>
    post<{ preset: DirectorPromptPreset }>("/api/llm/prompt-presets/", data),
  update: (id: string, data: { name?: string; template_yaml?: string; match_pattern?: string | null }) =>
    put<{ preset: DirectorPromptPreset }>(`/api/llm/prompt-presets/${id}`, data),
  delete: (id: string) => del<{ status: string }>(`/api/llm/prompt-presets/${id}`),
}

// App Settings API
export const appSettingsApi = {
  get: () => get<AppSettings>("/api/settings"),
  update: (data: Partial<AppSettings>) => put<AppSettings>("/api/settings", data),
}

// Version / status API（后端 pyproject.toml 权威版本，开放端点）
export const versionApi = {
  get: () => get<{ status: string; version: string }>("/v1/status"),
}

// Dice roll API — 复用后端 placeholder 的骰子语法（单一事实源）
export const rollApi = {
  roll: (expr: string) => post<{ result: number; expr: string }>("/v1/roll", { expr }),
}

// Plugins API
export const pluginsApi = {
  list: () => get<{ plugins: Plugin[] }>("/api/plugins"),
  get: (id: string) => get<Plugin>(`/api/plugins/${id}`),
  enable: (id: string) => post<{ status: string; plugin_id: string; enabled: boolean }>(`/api/plugins/${id}/enable`),
  disable: (id: string) => post<{ status: string; plugin_id: string; enabled: boolean }>(`/api/plugins/${id}/disable`),
  uninstall: (id: string) => del<{ status: string; plugin_id: string; message: string }>(`/api/plugins/${id}`),
  // Two-phase install: preview (no persistence) → confirm (persist).
  preview: (form: FormData) => {
    const token = getAuthToken()
    const headers: Record<string, string> = {}
    if (token) headers["Authorization"] = `Bearer ${token}`
    return fetch(`${getApiBaseUrl()}/api/plugins/preview`, {
      method: "POST",
      headers,
      body: form,
    }).then(async r => {
      if (r.ok) return { ok: true as const, data: await r.json() as PluginPreview }
      const detail = (await r.json().catch(() => null))?.detail
      return { ok: false as const, error: typeof detail === "string" ? detail : "插件预检失败" }
    })
  },
  confirmInstall: (previewId: string) =>
    post<{ status: string; plugin_id: string; message: string }>("/api/plugins/import/confirm", { preview_id: previewId }),
  // Network allowlist
  getNetworkRules: (id: string) => get<{ plugin_id: string; rules: NetworkRule[] }>(`/api/plugins/${id}/network-rules`),
  addNetworkRule: (id: string, rule: { scheme: string; host: string; port: number | null }) =>
    post<{ status: string; rule: NetworkRule }>(`/api/plugins/${id}/network-rules`, rule),
  updateNetworkRule: (id: string, ruleId: string, rule: { scheme: string; host: string; port: number | null }) =>
    put<{ status: string; rule: NetworkRule }>(`/api/plugins/${id}/network-rules/${ruleId}`, rule),
  enableNetworkRule: (id: string, ruleId: string) =>
    post(`/api/plugins/${id}/network-rules/${ruleId}/enable`),
  disableNetworkRule: (id: string, ruleId: string) =>
    post(`/api/plugins/${id}/network-rules/${ruleId}/disable`),
  deleteNetworkRule: (id: string, ruleId: string) =>
    del(`/api/plugins/${id}/network-rules/${ruleId}`),
  getData: (id: string) => get<{ plugin_id: string; data: PluginData }>(`/api/plugins/${id}/data`),
  setData: (id: string, data: PluginData) => put<{ status: string; plugin_id: string }>(`/api/plugins/${id}/data`, { data }),
  deleteData: (id: string, key: string) => del<{ status: string }>(`/api/plugins/${id}/data/${key}`),
}

// ── Types for the skill library ──
export interface MySkill {
  name: string
  has_skill: boolean
  has_examples: boolean
  file_count: number
  size: number
  updated_at: number
}

export interface SkillPreview {
  preview_id: string
  available: boolean
  name: string
  preview: { name: string; has_skill: boolean; has_examples: boolean; file_count: number }
}

export interface InstanceSkill {
  name: string
  source: "system" | "instance"
  has_skill: boolean
  has_examples: boolean
}

// ── Types for the prompt-package library ──
export interface MyPackage {
  name: string
  has_readme: boolean
  file_count: number
  size: number
  updated_at: number
}

export interface PackagePreview {
  preview_id: string
  available: boolean
  name: string
  preview: { name: string; has_readme: boolean; file_count: number }
}

export interface InstancePackage {
  name: string
  has_readme: boolean
  file_count: number
  size: number
  updated_at: number
}

// Skills API — user-level skill library + instance enable/export
export const skillsApi = {
  // User library
  listMy: () => get<{ skills: MySkill[] }>("/api/my-skills"),
  preview: (form: FormData) => {
    const token = getAuthToken()
    const headers: Record<string, string> = {}
    if (token) headers["Authorization"] = `Bearer ${token}`
    return fetch(`${getApiBaseUrl()}/api/my-skills/preview`, {
      method: "POST",
      headers,
      body: form,
    }).then(async r => {
      if (r.ok) return { ok: true as const, data: await r.json() as SkillPreview }
      const detail = (await r.json().catch(() => null))?.detail
      return { ok: false as const, error: typeof detail === "string" ? detail : "skill 预检失败" }
    })
  },
  confirmInstall: (previewId: string) =>
    post<{ status: string; name: string; message: string }>("/api/my-skills/import/confirm", { preview_id: previewId }),
  deleteMy: (name: string) => del<{ status: string; name: string; message: string }>(`/api/my-skills/${encodeURIComponent(name)}`),
  downloadUrl: (name: string) => {
    const token = getAuthToken()
    return `${getApiBaseUrl()}/api/my-skills/${encodeURIComponent(name)}/download?token=${encodeURIComponent(token || "")}`
  },
  // Instance skills
  listForInstance: (instanceId: string) =>
    get<InstanceSkill[]>(`/api/instances/${instanceId}/skills`),
  enableFromLibrary: (instanceId: string, name: string) =>
    post<{ name: string; status: string; message: string }>(`/api/instances/${instanceId}/skills/${encodeURIComponent(name)}/enable-from-library`),
  exportToLibrary: (instanceId: string, name: string, overwrite = false) =>
    post<{ name: string; status: string; message: string }>(`/api/instances/${instanceId}/skills/${encodeURIComponent(name)}/export-to-library`, { overwrite }),
  removeFromInstance: (instanceId: string, name: string) =>
    del<{ name: string; status: string }>(`/api/instances/${instanceId}/skills/${encodeURIComponent(name)}`),
}

// Prompt packages API — user-level package library + instance enable/remove
export const packagesApi = {
  // User library
  listMy: () => get<{ packages: MyPackage[] }>("/api/my-packages"),
  preview: (form: FormData) => {
    const token = getAuthToken()
    const headers: Record<string, string> = {}
    if (token) headers["Authorization"] = `Bearer ${token}`
    return fetch(`${getApiBaseUrl()}/api/my-packages/preview`, {
      method: "POST",
      headers,
      body: form,
    }).then(async r => {
      if (r.ok) return { ok: true as const, data: await r.json() as PackagePreview }
      const detail = (await r.json().catch(() => null))?.detail
      return { ok: false as const, error: typeof detail === "string" ? detail : "提示词包预检失败" }
    })
  },
  confirmInstall: (previewId: string) =>
    post<{ status: string; name: string; message: string }>("/api/my-packages/import/confirm", { preview_id: previewId }),
  deleteMy: (name: string) => del<{ status: string; name: string; message: string }>(`/api/my-packages/${encodeURIComponent(name)}`),
  downloadUrl: (name: string) => {
    const token = getAuthToken()
    return `${getApiBaseUrl()}/api/my-packages/${encodeURIComponent(name)}/download?token=${encodeURIComponent(token || "")}`
  },
  // Instance packages
  listInInstance: (instanceId: string) =>
    get<{ packages: InstancePackage[] }>(`/api/instances/${instanceId}/packages`),
  enableInInstance: (instanceId: string, name: string) =>
    post<{ name: string; status: string; message: string }>(`/api/instances/${instanceId}/packages/${encodeURIComponent(name)}/enable-from-library`),
  removeFromInstance: (instanceId: string, name: string) =>
    del<{ name: string; status: string; message: string }>(`/api/instances/${instanceId}/packages/${encodeURIComponent(name)}`),
  exportToLibrary: (instanceId: string, name: string, overwrite = false) =>
    post<{ name: string; status: string; message: string }>(`/api/instances/${instanceId}/packages/${encodeURIComponent(name)}/export-to-library`, { overwrite }),
}
