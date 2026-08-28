import { create } from "zustand"

const STORAGE_KEY = "teahouse_wizard_done"

/**
 * 欢迎向导「点确定、正式收尾」的持久化状态。
 *
 * 向导不再在清单全绿时直接移除——而是等用户点下「完成」按钮才放行。
 * 这个 store 记录「用户已经确认过」这一事实，让 F5 / 下次进页面时，
 * 只要模型体系仍配好（complete 仍 true），就无需再次点确定。
 *
 * 一旦 complete 回退为 false（比如用户删了供应商/模型），SetupGateEmpty 会
 * 调 resetDone 清掉它，下次再配好时仍要走一遍「点确定」。
 */
interface WizardDoneState {
  done: boolean
  markDone: () => void
  resetDone: () => void
}

function loadDone(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "1"
  } catch {
    return false
  }
}

export const useWizardDoneStore = create<WizardDoneState>()((set) => ({
  done: loadDone(),
  markDone: () => {
    try {
      localStorage.setItem(STORAGE_KEY, "1")
    } catch {
      // 写不进去就只在本次会话生效
    }
    set({ done: true })
  },
  resetDone: () => {
    try {
      localStorage.removeItem(STORAGE_KEY)
    } catch {
      // 清不干净就只在本次会话生效
    }
    set({ done: false })
  },
}))
