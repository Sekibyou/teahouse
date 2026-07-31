import { create } from "zustand"

/**
 * 全局生成状态存储（不持久化）。
 *
 * 为什么需要全局级别：
 * - 刷新页面后 phase 自动回到 "idle"，避免 localStorage 中残留的
 *   pending/streaming 消息显示虚假的"等待中..."等指示器。
 * - 所有指示器基于同一个 store 判断，不会出现不一致。
 *
 * abortReason 用于停止后在下一次 AI 请求时注入中断上下文。
 * 读取后自动清除（消费一次）。
 */

export type GenerationPhase = "idle" | "generating" | "waiting_approval"
export type AbortReason = "user_interrupted"

export interface ApprovalData {
  id: string
  name: string
  args: Record<string, unknown>
}

export interface GenerationState {
  phase: GenerationPhase
  approvalData: ApprovalData | null

  /** 中断原因（消费后清除） */
  abortReason: AbortReason | null

  startGenerating: () => void
  waitForApproval: (data: ApprovalData) => void
  resolveApproval: (backToGenerating: boolean) => void
  finishGenerating: () => void
  abort: (reason?: AbortReason) => void
  consumeAbortReason: () => AbortReason | null
}

export const useGenerationStore = create<GenerationState>()((set) => ({
  phase: "idle",
  approvalData: null,
  abortReason: null,

  startGenerating: () => set({ phase: "generating", approvalData: null, abortReason: null }),

  waitForApproval: (data) => set({ phase: "waiting_approval", approvalData: data }),

  resolveApproval: (backToGenerating) =>
    set({
      phase: backToGenerating ? "generating" : "idle",
      approvalData: null,
    }),

  finishGenerating: () => set({ phase: "idle", approvalData: null }),

  abort: (reason = "user_interrupted") =>
    set({ phase: "idle", approvalData: null, abortReason: reason }),

  consumeAbortReason: () => {
    const reason = useGenerationStore.getState().abortReason
    if (reason) set({ abortReason: null })
    return reason
  },
}))

export function getGenerationPhase(): GenerationPhase {
  return useGenerationStore.getState().phase
}

export function isGenerating(): boolean {
  const phase = useGenerationStore.getState().phase
  return phase === "generating" || phase === "waiting_approval"
}
