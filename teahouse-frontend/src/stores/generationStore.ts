import { create } from "zustand"

export type ApprovalData = {
  id: string
  name: string
  args: Record<string, unknown>
}

export type AbortReason = "user_interrupted"

export interface GenerationState {
  /** 等待审批的工具（跨会话全局） */
  approvalData: ApprovalData | null
  /** 中断原因（一次性消费） */
  abortReason: AbortReason | null

  waitForApproval: (data: ApprovalData) => void
  resolveApproval: () => void
  consumeAbortReason: () => AbortReason | null
}

/**
 * 简化的全局生成状态存储。
 *
 * running / elapsed / tokenCount 已移到后端管理（session_tracker），
 * 前端通过 SSE ``stats`` 字段和 ``GET /sessions/status`` API 获取，
 * 不再需要 phase / startedAt / tokenCount / elapsed 等本地计时。
 *
 * 仅保留：
 * - approvalData：等待 Git 提交审批（跨会话全局，不跨刷新）
 * - abortReason：中断原因（一次性消费）
 */
export const useGenerationStore = create<GenerationState>()((set) => ({
  approvalData: null,
  abortReason: null,

  waitForApproval: (data) => set({ approvalData: data }),

  resolveApproval: () => set({ approvalData: null }),

  consumeAbortReason: (): AbortReason | null => {
    const reason = useGenerationStore.getState().abortReason
    if (reason) set({ abortReason: null })
    return reason
  },
}))

export function getApprovalData(): ApprovalData | null {
  return useGenerationStore.getState().approvalData
}
