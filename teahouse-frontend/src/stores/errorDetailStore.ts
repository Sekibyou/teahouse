import { create } from "zustand"

/** 一条要展示在错误详情弹窗里的完整错误。 */
export interface ErrorDetail {
  /** 完整错误文本（可能很长、多行、含上游原始 JSON） */
  detail: string
  /** 来源标识（后端给的文件/角色名，或前端调用点自报的组件名），仅用于标题 */
  source?: string
}

interface ErrorDetailState {
  error: ErrorDetail | null
  showError: (error: ErrorDetail) => void
  closeError: () => void
}

/**
 * 错误详情弹窗的状态。弹窗本体 `<ErrorDetailDialog />` 挂在 MainLayout 里（全局唯一），
 * 任何地方经 `notifyError()` 触发——长错误在 toast 里会被截断且无法复制，这里给出全文。
 */
export const useErrorDetailStore = create<ErrorDetailState>()((set) => ({
  error: null,
  showError: (error) => set({ error }),
  closeError: () => set({ error: null }),
}))
