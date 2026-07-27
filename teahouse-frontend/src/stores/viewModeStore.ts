import { create } from "zustand"

type ViewMode = "play" | "backstage"

interface ViewModeState {
  mode: ViewMode
  setMode: (mode: ViewMode) => void
  toggleMode: () => void
}

export const useViewModeStore = create<ViewModeState>()((set) => ({
  mode: "backstage",
  setMode: (mode) => set({ mode }),
  toggleMode: () =>
    set((state) => ({ mode: state.mode === "play" ? "backstage" : "play" })),
}))
