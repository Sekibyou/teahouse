import { createContext, useContext } from "react"
import type { TabKey } from "@/components/SettingsDialogComps/types"

/** SettingsDialog 向各 Panel 暴露当前 section，Panel 可在被切到时重新拉取数据 */
export interface SettingsDialogContextValue {
  activeSection: TabKey
}

export const SettingsDialogContext = createContext<SettingsDialogContextValue>({
  activeSection: "general",
})

export function useSettingsDialogContext(): SettingsDialogContextValue {
  return useContext(SettingsDialogContext)
}
