import { create } from "zustand"
import { persist } from "zustand/middleware"

interface ActiveInstance {
  id: string
  name: string
}

interface SessionState {
  activeInstance: ActiveInstance | null
  setActiveInstance: (inst: ActiveInstance | null) => void
  /** 沙盒 Teahouse.send() 写入的消息，ChatPanel 轮询后自动发送 */
  pendingMessage: string | null
  setPendingMessage: (msg: string | null) => void
  /** 沙盒子会话驱动：{session_id, message, focus?, ooc?}，ChatPanel 发消息；focus=true 时切到该会话。
   *  ooc=true 表示「局外发言」（不落 dm-output、DM 可回正文），目前只对 DM 会话有意义。 */
  pendingSessionSend: { sessionId: string; message: string; focus?: boolean; ooc?: boolean } | null
  setPendingSessionSend: (p: { sessionId: string; message: string; focus?: boolean; ooc?: boolean } | null) => void
}

export const useSessionStore = create<SessionState>()(
  persist(
    (set) => ({
      activeInstance: null,
      setActiveInstance: (inst) => set({ activeInstance: inst }),
      pendingMessage: null,
      setPendingMessage: (msg) => set({ pendingMessage: msg }),
      pendingSessionSend: null,
      setPendingSessionSend: (p) => set({ pendingSessionSend: p }),
    }),
    {
      name: "teahouse-session",
      partialize: (state) => ({
        activeInstance: state.activeInstance,
      }),
    }
  )
)

export function getActiveInstance(): ActiveInstance | null {
  return useSessionStore.getState().activeInstance
}

export function getPendingMessage(): string | null {
  return useSessionStore.getState().pendingMessage
}

export function getPendingSessionSend(): { sessionId: string; message: string; ooc?: boolean } | null {
  return useSessionStore.getState().pendingSessionSend
}
