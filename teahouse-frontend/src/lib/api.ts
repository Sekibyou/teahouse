import { getAuthToken, clearAuth } from "@/stores/authStore"

export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || "http://127.0.0.1:8000"
const REQUEST_TIMEOUT = 10000

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

    const json = await response.json()

    // Backend returns errors with "detail" key
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

export async function get<T>(endpoint: string): Promise<RequestResult<T>> {
  return request<T>(endpoint, { method: "GET" })
}

export async function post<T>(endpoint: string, body: unknown): Promise<RequestResult<T>> {
  return request<T>(endpoint, { method: "POST", body: JSON.stringify(body) })
}

export async function put<T>(endpoint: string, body: unknown): Promise<RequestResult<T>> {
  return request<T>(endpoint, { method: "PUT", body: JSON.stringify(body) })
}

export async function del<T>(endpoint: string): Promise<RequestResult<T>> {
  return request<T>(endpoint, { method: "DELETE" })
}

// Auth-specific API calls
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
