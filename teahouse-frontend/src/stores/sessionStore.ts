import { create } from "zustand"
import { persist } from "zustand/middleware"

interface ActiveInstance {
  id: string
  name: string
}

interface SessionState {
  activeInstance: ActiveInstance | null
  setActiveInstance: (inst: ActiveInstance | null) => void
}

export const useSessionStore = create<SessionState>()(
  persist(
    (set) => ({
      activeInstance: null,
      setActiveInstance: (inst) => set({ activeInstance: inst }),
    }),
    {
      name: "teahouse-session",
      partialize: (state) => ({
        activeInstance: state.activeInstance,
      }),
    }
  )
)

export function getActiveInstance(): ActiveInstance | null {
  return useSessionStore.getState().activeInstance
}
