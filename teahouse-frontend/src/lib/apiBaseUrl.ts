const DEFAULT = import.meta.env.VITE_API_BASE_URL || "http://127.0.0.1:8000"
const STORAGE_KEY = "apiBaseUrl"

export function getApiBaseUrl(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) || DEFAULT
  } catch {
    return DEFAULT
  }
}

export function setApiBaseUrl(url: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, url)
  } catch {
    // ignore storage failures
  }
}
