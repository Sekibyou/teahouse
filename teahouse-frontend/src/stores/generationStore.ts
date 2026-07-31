import { create } from "zustand"

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
  abortReason: AbortReason | null

  /** 生成开始时间戳（ms），用于计算 elapsed */
  startedAt: number
  /** 已生成 token 估算数 */
  tokenCount: number
  /** 已运行秒数（由外部定时器更新） */
  elapsed: number

  startGenerating: () => void
  waitForApproval: (data: ApprovalData) => void
  resolveApproval: (backToGenerating: boolean) => void
  finishGenerating: () => void
  abort: (reason?: AbortReason) => void
  consumeAbortReason: () => AbortReason | null
  addTokens: (n: number) => void
  tickElapsed: () => void
}

export const useGenerationStore = create<GenerationState>()((set) => ({
  phase: "idle",
  approvalData: null,
  abortReason: null,
  startedAt: 0,
  tokenCount: 0,
  elapsed: 0,

  startGenerating: () =>
    set({
      phase: "generating",
      approvalData: null,
      abortReason: null,
      startedAt: Date.now(),
      tokenCount: 0,
      elapsed: 0,
    }),

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

  addTokens: (n) =>
    set((s) => ({ tokenCount: s.tokenCount + n })),

  tickElapsed: () =>
    set((s) => ({ elapsed: Math.floor((Date.now() - s.startedAt) / 1000) })),
}))

export function getGenerationPhase(): GenerationPhase {
  return useGenerationStore.getState().phase
}

export function isGenerating(): boolean {
  const phase = useGenerationStore.getState().phase
  return phase === "generating" || phase === "waiting_approval"
}
