import { getAuthToken, clearAuth } from "@/stores/authStore"
import type { Prototype, Instance, FileTreeNode, ActiveSession } from "./types"

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

  delete: async (id: string) => {
    return del<{ status: string }>(`/api/prototypes/${id}`)
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
