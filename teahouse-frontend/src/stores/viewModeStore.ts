import { create } from "zustand"

type ViewMode = "play" | "backstage"

interface ViewModeState {
  mode: ViewMode
  setMode: (mode: ViewMode) => void
  toggleMode: () => void
  chatCollapsed: boolean
  setChatCollapsed: (collapsed: boolean) => void
  toggleChatCollapsed: () => void
  chatWidth: number
  setChatWidth: (width: number) => void
}

export const useViewModeStore = create<ViewModeState>()((set) => ({
  mode: "backstage",
  setMode: (mode) => set({ mode }),
  toggleMode: () =>
    set((state) => ({ mode: state.mode === "play" ? "backstage" : "play" })),
  chatCollapsed: false,
  setChatCollapsed: (collapsed) => set({ chatCollapsed: collapsed }),
  toggleChatCollapsed: () =>
    set((state) => ({ chatCollapsed: !state.chatCollapsed })),
  chatWidth: 35,
  setChatWidth: (width) => set({ chatWidth: width }),
}))
