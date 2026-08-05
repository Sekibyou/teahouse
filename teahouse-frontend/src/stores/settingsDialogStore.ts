import { create } from "zustand"

interface SettingsDialogState {
  open: boolean
  defaultTab?: string
  openSettings: (defaultTab?: string) => void
  closeSettings: () => void
}

export const useSettingsDialogStore = create<SettingsDialogState>()((set) => ({
  open: false,
  defaultTab: undefined,
  openSettings: (defaultTab) => set({ open: true, defaultTab }),
  closeSettings: () => set({ open: false }),
}))
