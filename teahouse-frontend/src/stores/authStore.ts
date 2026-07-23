import { create } from "zustand"
import { persist } from "zustand/middleware"

export interface User {
  user_id: string
  username: string
  display_name: string
}

interface AuthState {
  user: User | null
  token: string | null
  isAuthenticated: boolean
  isLoading: boolean
}

interface AuthActions {
  setAuth: (user: User, token: string) => void
  clearAuth: () => void
  setLoading: (loading: boolean) => void
}

export const useAuthStore = create<AuthState & AuthActions>()(
  persist(
    (set) => ({
      user: null,
      token: null,
      isAuthenticated: false,
      isLoading: true,

      setAuth: (user, token) => {
        set({ user, token, isAuthenticated: true, isLoading: false })
      },

      clearAuth: () => {
        set({ user: null, token: null, isAuthenticated: false, isLoading: false })
      },

      setLoading: (loading) => {
        set({ isLoading: loading })
      },
    }),
    {
      name: "teahouse-auth",
      partialize: (state) => ({
        user: state.user,
        token: state.token,
        isAuthenticated: state.isAuthenticated,
      }),
      onRehydrateStorage: () => (state) => {
        if (state) {
          state.setLoading(false)
        }
      },
    }
  )
)

// Convenience hooks
export function useAuth() {
  const user = useAuthStore((s) => s.user)
  const token = useAuthStore((s) => s.token)
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated)
  const isLoading = useAuthStore((s) => s.isLoading)
  return { user, token, isAuthenticated, isLoading }
}

export function useAuthActions() {
  const setAuth = useAuthStore((s) => s.setAuth)
  const clearAuth = useAuthStore((s) => s.clearAuth)
  return { setAuth, clearAuth }
}

// Plain functions for use outside React components
export function getAuthToken(): string | null {
  return useAuthStore.getState().token
}

export function clearAuth(): void {
  useAuthStore.getState().clearAuth()
}
