import { create } from "zustand"

const STORAGE_KEY = "teahouse_wizard_skipped"

/**
 * 欢迎向导里「推荐但有内置兜底」的步骤被点「跳过」后的记忆。
 * 跳过 = 完成度前进一格且不再阻塞新建实例，但不改变真实配置状态（没建就是没建）。
 *
 * 用全局 store 而非组件内 useState：useSetupStatus 会被多处独立调用
 * （SessionSelectPage 的 SetupGateEmpty + WelcomeWizard 自身），跳过必须让所有
 * 调用方同步翻绿，否则点了跳过、向导自己前进了、外层闸门却还认为没配完。
 */
interface WizardSkipState {
  skipped: Record<string, boolean>
  skipStep: (key: string) => void
}

function loadSkipped(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    const arr = raw ? JSON.parse(raw) : []
    return Array.isArray(arr) ? Object.fromEntries(arr.map((k: string) => [k, true])) : {}
  } catch {
    // 隐私模式 / 坏数据：退化成「没跳过任何步骤」
    return {}
  }
}

export const useWizardSkipStore = create<WizardSkipState>()((set, get) => ({
  skipped: loadSkipped(),
  skipStep: (key) => {
    if (get().skipped[key]) return
    const next = { ...get().skipped, [key]: true }
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.keys(next)))
    } catch {
      // 写不进去就只在本次会话生效，不影响流程
    }
    set({ skipped: next })
  },
}))
