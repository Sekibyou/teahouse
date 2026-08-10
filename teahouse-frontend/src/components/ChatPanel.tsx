import { useState, useRef, useEffect, useCallback } from "react"
import { Loader2, X, CheckCircle2, Flag } from "lucide-react"
import { chatApi, llmSlotsApi, llmModelsApi, instancesApi, gitApi, pluginsApi, API_BASE_URL } from "@/lib/api"
import { getActiveInstance, useSessionStore } from "@/stores/sessionStore"
import { useGenerationStore } from "@/stores/generationStore"
import { useGitStore } from "@/stores/gitStore"
import { useSettingsDialogStore } from "@/stores/settingsDialogStore"
import type { FloorsStats } from "@/lib/types"
import { toast } from "sonner"
import { GitDialog } from "@/components/GitDialog"
import type { MsgStatus, ContentBlock, RichMessage } from "./ChatPanelComps/types"
import { nextId, mergeConsecutiveSameRole, updateMessage, formatCommitPreview, compareBubbles, insertBubbleSorted, autoMsgKind, autoKindFields } from "./ChatPanelComps/utils"
import { AssistantBubble } from "./ChatPanelComps/AssistantBubble"
import { ChatHeader } from "./ChatPanelComps/ChatHeader"
import { ChatInput } from "./ChatPanelComps/ChatInput"

export function ChatPanel({ onGitRefresh }: { onGitRefresh?: () => void }) {
  const [messages, setMessages] = useState<RichMessage[]>([])

  // ── Per-session UI state ─────────────────────────────────────────
  // running / elapsed / tokenCount come from the BACKEND (session_tracker).
  // waiting / waitingSince are frontend-local (one-shot, cleared on first
  // session_event).  Together they drive the submit/stop button and the
  // "等待中…" / "生成中…" indicator bubble without any global timer.
  interface SessionUIState {
    running: boolean
    elapsed: number
    tokenCount: number
    waiting: boolean
    waitingSince: number   // Date.now() when enqueue was sent
  }
  const [sessionStateMap, setSessionStateMap] = useState<Record<string, SessionUIState>>({})
  const sessionStateRef = useRef<Record<string, SessionUIState>>({})
  sessionStateRef.current = sessionStateMap

  const MAIN_SID = "main"
  const [activeSid, setActiveSid] = useState(MAIN_SID)

  // Convenience getter/setter for the currently-viewed session
  const activeState: SessionUIState = sessionStateMap[activeSid] ?? {
    running: false, elapsed: 0, tokenCount: 0, waiting: false, waitingSince: 0,
  }
  const isStreaming = activeState.running
  const isWaiting = activeState.waiting && !activeState.running

  const patchSessionState = useCallback((sid: string, patch: Partial<SessionUIState>) => {
    const prev = sessionStateRef.current[sid] ?? {
      running: false, elapsed: 0, tokenCount: 0, waiting: false, waitingSince: 0,
    }
    const next = { ...sessionStateRef.current, [sid]: { ...prev, ...patch } }
    sessionStateRef.current = next
    setSessionStateMap(next)
  }, [])

  // Update running+stats from backend-authoritative sources (SSE / API)
  const applyBackendState = useCallback((sid: string, running: boolean, stats?: { elapsed?: number; token_count?: number }) => {
    const prev = sessionStateRef.current[sid] ?? {
      running: false, elapsed: 0, tokenCount: 0, waiting: false, waitingSince: 0,
    }
    // If backend says running, clear any stale waiting flag
    const next: SessionUIState = {
      ...prev,
      running,
      waiting: running ? false : prev.waiting,  // transition waiting→running
      elapsed: running ? (stats?.elapsed ?? prev.elapsed) : 0,
      tokenCount: running ? (stats?.token_count ?? prev.tokenCount) : 0,
    }
    if (prev.running === next.running && prev.elapsed === next.elapsed && prev.tokenCount === next.tokenCount && prev.waiting === next.waiting) return
    const map = { ...sessionStateRef.current, [sid]: next }
    sessionStateRef.current = map
    setSessionStateMap(map)
  }, [])
  const [sessionList, setSessionList] = useState<{ session_id: string; record_count: number }[]>([])
  const messagesBySidRef = useRef<Record<string, RichMessage[]>>({})
  // Track the active streaming assistant per session for session_event-based real-time
  // rendering. When the frontend sends directly via /v1/chat, `assistantMsg` (let in
  // _doSend) handles it. When a session is running in background (_drain path) and the
  // user is watching it, the session_event handler updates this message.
  const streamingAssistantRef = useRef<Record<string, RichMessage>>({})
  // "有新消息" 标志：后台会话有产出时需要提示，切过去即清。
  const [newMsgMap, setNewMsgMap] = useState<Record<string, boolean>>({})
  const newMsgMapRef = useRef<Record<string, boolean>>({})
  newMsgMapRef.current = newMsgMap
  const sessionListRef = useRef<typeof sessionList>([])
  sessionListRef.current = sessionList
  const activeSidNewRef = useRef(MAIN_SID)
  activeSidNewRef.current = activeSid
  // Writer (non-tools) path builds local bubbles with a private negative order
  // namespace so they sort after all backend-ordered (>=0) bubbles.
  const writerLocalOrderRef = useRef(-1)
  const markSessionNew = useCallback((sid: string) => {
    if (activeSidNewRef.current === sid) return // 正在看的会话不需要新消息标注
    const next = { ...newMsgMapRef.current, [sid]: true }
    newMsgMapRef.current = next
    setNewMsgMap(next)
  }, [])
  const clearSessionNew = useCallback((sid: string) => {
    const cur = newMsgMapRef.current
    if (!cur[sid]) return
    const next = { ...cur }
    delete next[sid]
    newMsgMapRef.current = next
    setNewMsgMap(next)
  }, [])

  // 每个实例独立的 localStorage key
  const activeInst = useSessionStore((s) => s.activeInstance)
  const instId = activeInst?.id
  const instName = activeInst?.name

  // ── Reasoning effort (thinking strength) per session ──────────────────
  // Reflects the value shown in the ChatHeader cycle button. None = not set
  // (model default). Keyed by session_id; main → user default, child → override.
  const EFFORT_ORDER = ["none", "low", "mid", "high", "max"]
  const [reasoningEffortBySid, setReasoningEffortBySid] = useState<Record<string, string>>({})
  const reasoningEffortBySidRef = useRef<Record<string, string>>({})
  reasoningEffortBySidRef.current = reasoningEffortBySid
  // The cycle button keys off the ACTIVE session's stored value; None means unset.
  const currentEffort = reasoningEffortBySid[activeSid] ?? "none"

  const refreshSessionEffort = useCallback((sid: string) => {
    if (!instId) return
    instancesApi.getSessionReasoning(instId, sid).then(res => {
      if (!res.ok) return
      const val = res.data?.reasoning_effort ?? "none"
      const map = { ...reasoningEffortBySidRef.current, [sid]: val }
      reasoningEffortBySidRef.current = map
      setReasoningEffortBySid(map)
    }).catch(() => {})
  }, [instId])

  const cycleSessionEffort = useCallback(async () => {
    if (!instId) return
    const cur = reasoningEffortBySidRef.current[activeSid] ?? "none"
    const next = EFFORT_ORDER[(EFFORT_ORDER.indexOf(cur) + 1) % EFFORT_ORDER.length]
    const res = await instancesApi.setSessionReasoning(instId, activeSid, next)
    if (res.ok) {
      const map = { ...reasoningEffortBySidRef.current, [activeSid]: next }
      reasoningEffortBySidRef.current = map
      setReasoningEffortBySid(map)
      const label = activeSid === MAIN_SID ? "主会话" : `子会话 ${activeSid}`
      toast.success(`${label} 思考强度已设为 ${next}`)
    } else {
      toast.error(`设置思考强度失败:${res.error || "未知错误"}`)
    }
  }, [instId, activeSid])

  // 顶层思考强度显示初始化：实例或活跃会话变化时,同步当前会话的 effort 值。
  useEffect(() => {
    refreshSessionEffort(activeSid)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instId, activeSid])

  // Chatpan must define refreshSessionsStatus AFTER instId (it reads it).
  const refreshSessionsStatus = useCallback(() => {
    if (instId) {
      instancesApi.getSessionsStatus(instId).then(res => {
        if (res.ok) {
          const running = res.data?.sessions || {}
          const stats = res.data?.stats || {}
          const map: Record<string, SessionUIState> = {}
          for (const [sid, isRunning] of Object.entries(running)) {
            const s = stats[sid]
            map[sid] = {
              running: isRunning === true,
              elapsed: s?.elapsed ?? 0,
              tokenCount: s?.token_count ?? 0,
              waiting: false,
              waitingSince: 0,
            }
          }
          // Merge with any local waiting state (API doesn't know about waiting)
          const cur = sessionStateRef.current
          for (const [sid, st] of Object.entries(cur)) {
            if (st.waiting && !map[sid]) {
              map[sid] = st
            }
          }
          sessionStateRef.current = map
          setSessionStateMap(map)
        }
      }).catch(() => {})
    }
  }, [instId])

  // 楼层元数据
  const [floorsStats, setFloorsStats] = useState<FloorsStats | null>(null)

  // 初始加载 + SSE 监听楼层变化
  const floorsESRef = useRef<EventSource | null>(null)
  useEffect(() => {
    if (!instId) return
    let stopped = false

    // 首次通过 refresh API 获取楼层数据
    gitApi.refresh(instId).then(res => {
      if (!stopped && res.ok && res.data?.floors) {
        setFloorsStats({ ...res.data.floors, instance_id: instId })
      }
    }).catch(() => {})

    const connect = () => {
      if (stopped) return
      const es = new EventSource(`${API_BASE_URL}/events`)
      floorsESRef.current = es

      es.addEventListener("floors_changed", (e: MessageEvent) => {
        try {
          const data = JSON.parse(e.data)
          if (data.instance_id && data.instance_id !== instId && data.instance_id !== instName) return
          setFloorsStats(data)
        } catch {
          // ignore malformed events
        }
      })

      es.addEventListener("session_destroyed", (e: MessageEvent) => {
        try {
          const data = JSON.parse(e.data)
          if (instId && data.instance_id !== instId) return
          const destroyedSid = data.session_id as string
          if (!destroyedSid) return
          // (1) 事件只负责告诉我们"谁被删了"。真实会话列表以服务端为准，主动拉一次
          //     (删除可能是导演 DeleteSubSession 或沙盒 sessionDestroy 触发的)。
          // (2) 用一个"上一个真实会话"记录当前丢失前的位置——切换时若活跃会话已消失，
          //     就落到列表里它前面的那个真实会话（不存在则主会话）。
          instancesApi.listSessions(instId!).then(res => {
            if (!res.ok) return
            const fresh = res.data?.sessions || []
            const nextList = mergeServerSessions(
              sessionListRef.current.filter(s => s.session_id !== destroyedSid),
              fresh
            )
            setSessionList(nextList)
            refreshSessionsStatus()
            // (3) 无论切换是主动（点击标签）还是被动（被删），都走同一条 switchSession，
            //     由它统一负责内容缓存、校验与重新加载 —— 不在这里特例 setActiveSid。
            if (activeSidRef.current === destroyedSid) {
              const idx = nextList.findIndex(s => s.session_id === destroyedSid)
              const prev = nextList[idx - 1] ?? nextList[nextList.length - 1]
              switchSessionRef.current(prev?.session_id ?? MAIN_SID)
            }
          }).catch(() => {
            // 拉取失败也要兜底切走，避免停留在已消失的会话上。
            if (activeSidRef.current === destroyedSid) {
              switchSessionRef.current(MAIN_SID)
            }
          })
        } catch {
          // ignore malformed events
        }
      })

      es.addEventListener("session_created", (e: MessageEvent) => {
        // A new sub-session appeared (created by the director via StartSubSession,
        // or by the sandbox). Add it to the panel's session strip so the user can
        // click in to watch / interact with it.
        try {
          const data = JSON.parse(e.data)
          if (instId && data.instance_id !== instId) return
          if (!data.session_id) return
          setSessionList(prev => {
            if (prev.some(s => s.session_id === data.session_id)) return prev
            return [...prev, { session_id: data.session_id, record_count: 0 }]
          })
          refreshSessionsStatus()
        } catch {
          // ignore malformed events
        }
      })

      es.addEventListener("session_done", (e: MessageEvent) => {
        // Child session finished its work (EndSession). We keep it listed. If this
        // child was created by a director session that awaited its result, wake that
        // parent by injecting a message so its round reopens (the "await_result" flow).
        try {
          const data = JSON.parse(e.data)
          if (instId && data.instance_id !== instId) return
          if (!data.session_id) return
          // 后台会话完成 → 标"有新消息"（除非正在看它）
          markSessionNew(data.session_id)
          // 结束后立即用后端附带的状态快照更新 running（该会话已从 running 消失）
          if (data.running && typeof data.running === "object") {
            const rMap = data.running as Record<string, boolean>
            for (const [s, r] of Object.entries(rMap)) {
              applyBackendState(s, r === true)
            }
          } else {
            refreshSessionsStatus()
          }
          instancesApi.listSessions(instId!).then(res => {
            if (res.ok) setSessionList(prev => mergeServerSessions(prev, res.data?.sessions || []))
          }).catch(() => {})
          // 唤醒已由后端完成（enqueue 入队 + broadcast session_user_msg）。前端
          // session_user_msg 处理器已负责追加 user 气泡 + pending assistant。
          // 这里只需确保父会话在 sessionList 里且标"有新消息"，不抢当前聚焦。
          if (data.parent_session_id) {
            const parent = data.parent_session_id as string
            setSessionList(prev => prev.some(s => s.session_id === parent)
              ? prev
              : [...prev, { session_id: parent, record_count: 0 }])
            markSessionNew(parent)
          }
        } catch {
          // ignore malformed events
        }
      })

      es.addEventListener("session_user_msg", (e: MessageEvent) => {
        // The backend persisted a user message to jsonl.  User bubbles carry a
        // stable backend ``order`` (the JSONL record id — the single source of
        // truth for ordering).  Upgrade a matching grey "queued" bubble to done;
        // otherwise insert a fresh user bubble at its sorted position.  We do
        // NOT create a placeholder assistant bubble here — the assistant's own
        // streaming (order,sub) events create its bubbles, and the standalone
        // "生成中… / 等待中…" indicator covers the gap before first token.
        try {
          const data = JSON.parse(e.data)
          if (instId && data.instance_id !== instId && data.instance_id !== instName) return
          const sid = data.session_id
          if (!sid) return
          const order = data.order as number | undefined
          if (activeSidRef.current === sid && data.content) {
            // Upgrade an existing queued (order,null) bubble, or insert fresh.
            let upgraded = false
            if (typeof order === "number") {
              setMessagesFor(sid, (prev) => {
                const idx = prev.findIndex(m => m.order === order && m.sub === null && m.status === "queued")
                if (idx >= 0) {
                  const next = [...prev]
                  next[idx] = { ...next[idx], status: "done" as MsgStatus }
                  upgraded = true
                  return next
                }
                return prev
              })
            }
            if (!upgraded) {
              // No queued bubble to upgrade — the frontend missed the queued
              // event (e.g. interrupt auto-message, sub-session wake-up while
              // idle). Insert the user bubble at its ordered position.
              const auto = autoMsgKind((data.content as string) || "")
              const userMsg: RichMessage = {
                id: nextId(), role: "user", content: data.content as string,
                reasoning: "", status: "done", order: typeof order === "number" ? order : 0,
                sub: null, subRank: 0,
                ...(auto ? autoKindFields(auto) : {}),
              }
              setMessagesFor(sid, (prev) => insertBubbleSorted(prev, userMsg))
            }
            scrollToBottom()
          } else {
            // Not viewing, or no content: invalidate cache so next switchSession
            // re-pulls from backend (which now has the new records).
            delete messagesBySidRef.current[sid]
            markSessionNew(sid)
          }
        } catch {
          // ignore malformed events
        }
      })

      es.addEventListener("session_user_queued", (e: MessageEvent) => {
        // The backend enqueued a user message into the in-memory queue; it has
        // NOT been persisted yet (the tool_loop may still be running).  Show a
        // grey "queued" bubble keyed by the reserved backend ``order``.  It is
        // upgraded to done by the later session_user_msg carrying the same order.
        try {
          const data = JSON.parse(e.data)
          if (instId && data.instance_id !== instId && data.instance_id !== instName) return
          const sid = data.session_id
          if (!sid) return
          if (activeSidRef.current === sid && data.content) {
            const order = typeof data.order === "number" ? data.order : 0
            const auto = autoMsgKind((data.content as string) || "")
            const queuedMsg: RichMessage = {
              id: nextId(),
              role: "user",
              content: data.content as string,
              reasoning: "",
              status: "queued",
              order,
              sub: null,
              subRank: 0,
              ...(auto ? autoKindFields(auto) : {}),
            }
            setMessagesFor(sid, (prev) => insertBubbleSorted(prev, queuedMsg))
            scrollToBottom()
          }
        } catch {
          // ignore malformed events
        }
      })

      es.addEventListener("file_changed", (e: MessageEvent) => {
        // 后台子会话只写 temp/（Report）——落 temp 的变更若发生在当前在看会话之外，
        // 表示有后台子会话在产出，给非当前会话标"有新消息"。
        try {
          const data = JSON.parse(e.data)
          if (instId && data.instance_id !== instId && data.instance_id !== instName) return
          const path = data.path || ""
          if (!path.startsWith("temp/")) return
          // Mark all sessions that are not currently active as having new content.
          setNewMsgMap(prev => {
            const next = { ...prev }
            sessionListRef.current.forEach(s => {
              if (s.session_id !== activeSidNewRef.current) next[s.session_id] = true
            })
            if (JSON.stringify(next) === JSON.stringify(prev)) return prev
            newMsgMapRef.current = next
            return next
          })
        } catch {
          // ignore malformed events
        }
      })

      es.addEventListener("session_event", (e: MessageEvent) => {
        // All director events now arrive via this single SSE path.
        // When viewing the session, we render streaming updates in real-time
        // (typing effect, tool calls, tool results, tool-round boundaries).
        // When not viewing, we mark as new and invalidate cache on boundaries.
        try {
          const data = JSON.parse(e.data)
          if (instId && data.instance_id !== instId && data.instance_id !== instName) return
          const sid = data.session_id
          if (!sid) return
          const t = data.type as string

          // Update running + stats from backend-authoritative sources.
          if (data.running && typeof data.running === "object") {
            // data.running is a {sid: bool} map across all sessions
            const rMap = data.running as Record<string, boolean>
            const rawStats = data.stats as { elapsed: number; token_count: number } | undefined
            for (const [s, r] of Object.entries(rMap)) {
              applyBackendState(s, r === true, s === sid ? rawStats : undefined)
            }
          }

          if (activeSidRef.current === sid) {
            // ---- Currently viewing this session: real-time streaming ----
            // Positioning is driven entirely by the backend (order, sub) key —
            // no "find last non-done bubble" inference. Every streaming event
            // carries the stable record order + block sub; bubbles are created
            // (or resumed) at exactly that (order, sub) and sorted numerically,
            // so an interrupted round can never have a later reply streamed
            // into a stale bubble positioned above newer user messages.
            const order = typeof data.order === "number" ? data.order : 0
            const sub = data.sub === undefined ? null : data.sub
            const subRank = sub === null ? 0 : (sub === "r" ? -1 : (sub as number))

            // Find the (order,sub) assistant bubble, or create it in sorted place.
            const bubbleFor = (prev: RichMessage[], action: (m: RichMessage) => RichMessage): RichMessage[] => {
              const idx = prev.findIndex(m => m.order === order && m.sub === sub)
              if (idx >= 0) {
                const updated = action(prev[idx])
                if (updated === prev[idx]) return prev
                const next = prev.slice()
                next[idx] = updated
                return next
              }
              const fresh: RichMessage = {
                id: nextId(), role: "assistant", content: "", reasoning: "",
                status: sub === "r" ? "reasoning" : "pending",
                blocks: sub === "r" ? [] : undefined,
                order, sub, subRank,
              }
              let placed = insertBubbleSorted(prev, fresh)
              // Apply the streaming chunk onto the freshly created bubble.
              placed = placed.map(m => (m.id === fresh.id ? action(m) : m))
              return placed
            }

            if (t === "done") {
              // Final done carries force_close semantics: the backend round is
              // over; close every still-open assistant bubble (drop empty ones).
              setMessagesFor(sid, (prev) => {
                const closer = [...prev]
                let changed = false
                for (let i = 0; i < closer.length; i++) {
                  const m = closer[i]
                  if (m.role === "assistant" && m.status !== "done") {
                    if (!m.content && !m.reasoning && (!m.blocks || m.blocks.length === 0)) {
                      closer.splice(i, 1); i--; changed = true
                    } else {
                      closer[i] = { ...m, status: "done" as MsgStatus }; changed = true
                    }
                  }
                }
                return changed ? closer : prev
              })
              return
            }

            if (t === "assistant_done") {
              // This assistant round completed: close its (order,sub) bubbles.
              setMessagesFor(sid, (prev) => {
                const closer = [...prev]
                let changed = false
                for (let i = 0; i < closer.length; i++) {
                  const m = closer[i]
                  if (m.role === "assistant" && m.status !== "done" && m.order === order) {
                    if (!m.content && !m.reasoning && (!m.blocks || m.blocks.length === 0)) {
                      closer.splice(i, 1); i--; changed = true
                    } else {
                      closer[i] = { ...m, status: "done" as MsgStatus }; changed = true
                    }
                  }
                }
                return changed ? closer : prev
              })
              return
            }

            if (t === "tool_call") {
              setMessagesFor(sid, (prev) => bubbleFor(prev, (m) => ({
                ...m,
                status: "streaming",
                blocks: [{
                  type: "tool_call" as const,
                  id: data.id as string,
                  name: data.name as string,
                  args: data.args as Record<string, unknown>,
                  ...(data._batch_meta ? { batch: data._batch_meta as { path: string; index: number; total: number } } : {}),
                }],
              })))
              return
            }

            if (t === "tool_result") {
              setMessagesFor(sid, (prev) => bubbleFor(prev, (m) => ({
                ...m,
                status: "streaming",
                blocks: [{
                  type: "tool_call" as const,
                  id: data.id as string,
                  name: data.name as string,
                  args: (m.blocks && m.blocks[0] && m.blocks[0].type === "tool_call" ? m.blocks[0].args : {}) as Record<string, unknown>,
                  result: data.result as string,
                }],
              })))
              return
            }

            if (t === "approval_required") {
              if (autoApproveCommitRef.current) {
                const inst = getActiveInstance()
                if (inst) {
                  gitApi.approveTool(inst.id, data.id as string, data.args as Record<string, unknown>).then(res => {
                    if (res.ok) {
                      setMessagesFor(sid, (prev) => bubbleFor(prev, (m) => ({
                        ...m,
                        status: "streaming",
                        blocks: [{
                          type: "tool_call" as const,
                          id: data.id as string,
                          name: data.name as string,
                          args: (data.args as Record<string, unknown>) || {},
                          result: "（自动批准）",
                        }],
                      })))
                    }
                  }).catch(() => {})
                  return
                }
              }
              useGenerationStore.getState().waitForApproval({
                id: data.id as string,
                name: data.name as string,
                args: data.args as Record<string, unknown>,
              })
              return
            }

            const chunkText = (data.text as string) || ""
            if (t === "text" || t === "reasoning") {
              // Defensive: skip tool_args text fragments (OpenAI tool-call arg
              // deltas). The backend also filters these now, but keeping this
              // guard ensures stale backends or edge cases don't flash JSON.
              if (data.tool_args) return
              if (t === "reasoning") {
                setMessagesFor(sid, (prev) => bubbleFor(prev, (m) => ({
                  ...m,
                  status: "reasoning",
                  reasoning: m.reasoning + chunkText,
                })))
              } else if (chunkText) {
                setMessagesFor(sid, (prev) => bubbleFor(prev, (m) => {
                  const block: ContentBlock = { type: "text", text: (m.blocks && m.blocks[0] && m.blocks[0].type === "text"
                    ? (m.blocks[0].text || "") + chunkText
                    : chunkText) }
                  return {
                    ...m,
                    blocks: [block],
                    content: m.content + chunkText,
                    status: "streaming",
                  }
                }))
              }
              return
            }
          } else {
            // ---- Not viewing: track for later ----
            markSessionNew(sid)
            // Only invalidate the cache when the ENTIRE tool_loop finishes.
            // If we delete on tool_result or assistant_done, subsequent SSE
            // events from the same loop will rebuild incomplete messages on
            // an empty slot — and when the user switches back, the stale
            // cached partial list masks the authoritative jsonl history.
            if (t === "done") {
              delete messagesBySidRef.current[sid]
            }
          }
        } catch {
          // ignore malformed events
        }
      })

      es.onerror = () => {
        es.close()
        floorsESRef.current = null
        if (!stopped) {
          // On reconnect, pull fresh backend state so elapsed/token/running
          // are immediately correct (no stale states from missed events).
          refreshSessionsStatus()
          setTimeout(connect, 3000)
        }
      }
    }

    connect()
    return () => {
      stopped = true
      if (floorsESRef.current) {
        floorsESRef.current.close()
        floorsESRef.current = null
      }
    }
  }, [instId, instName])

  // Slot state — lightweight model info display
  const [slotModels, setSlotModels] = useState<Record<string, string | null>>({ director: null, writer: null })
  const openSettings = useSettingsDialogStore((s) => s.openSettings)
  const [enabledPluginCount, setEnabledPluginCount] = useState(0)

  useEffect(() => {
    llmSlotsApi.getAll().then(res => {
      if (res.ok) {
        const slots = res.data!.slots
        const modelIds = [slots.director.model_id, slots.writer.model_id].filter(Boolean) as string[]
        if (modelIds.length > 0) {
          llmModelsApi.list().then(mRes => {
            if (mRes.ok) {
              const modelMap = new Map(mRes.data!.models.map(m => [m.id, m.name]))
              setSlotModels({
                director: slots.director.model_id ? modelMap.get(slots.director.model_id) || slots.director.model_id : null,
                writer: slots.writer.model_id ? modelMap.get(slots.writer.model_id) || slots.writer.model_id : null,
              })
            }
          })
        }
      }
    })
  }, [messages.length > 0])  // reload on first message sent (hack: refresh when messages change from 0)

  // Enabled plugin count for the header trigger
  const refreshPluginCount = useCallback(async () => {
    const res = await pluginsApi.list()
    if (res.ok) setEnabledPluginCount(res.data!.plugins.filter(p => p.enabled).length)
  }, [])
  useEffect(() => {
    refreshPluginCount()
  }, [refreshPluginCount, messages.length > 0])

  // ------------------------------------------------------------------
  // History loading — memory is owned by the backend (.sessions/). We pull a
  // bounded window of recent records and render them; earlier records are
  // lazy-loaded when the user scrolls to the top.
  // ------------------------------------------------------------------
  const PAGE_SIZE = 30
  const historyCursorRef = useRef<number | null>(null)  // count of records already known loaded
  const loadingMoreRef = useRef(false)
  const historyLoadedRef = useRef(false)

  // Convert a backend session record (already in bubble view, carrying
  // order/sub/subRank) or an in-flight local message into RichMessage shape.
  function recordToRichMessage(rec: { role: string; content?: string; blocks?: ContentBlock[]; reasoning?: string; order?: number; sub?: number | string | null; subRank?: number }): RichMessage {
    const order = typeof rec.order === "number" ? rec.order : 0
    const sub: number | "r" | null = rec.sub === undefined || rec.sub === null ? null : (rec.sub === "r" ? "r" : (typeof rec.sub === "number" ? rec.sub : null))
    const subRank = typeof rec.subRank === "number" ? rec.subRank : (sub === null ? 0 : (sub === "r" ? -1 : (sub as number)))
    const content = rec.content || ""
    const auto = content ? autoMsgKind(content) : null
    return {
      id: nextId(),
      role: rec.role === "user" ? "user" : "assistant",
      content,
      reasoning: rec.reasoning || "",
      status: "done",
      blocks: rec.blocks || undefined,
      order,
      sub,
      subRank,
      ...(auto && rec.role === "user" ? autoKindFields(auto) : {}),
    }
  }

  const loadHistory = useCallback((replace: boolean, sid?: string) => {
    const targetSid = sid ?? activeSid
    if (!instId || loadingMoreRef.current) return
    loadingMoreRef.current = true
    const offset = replace ? 0 : (historyCursorRef.current ?? 0)
    const fetchHistory = instancesApi.getSessionMemory(instId, targetSid, { limit: PAGE_SIZE, offset })
    fetchHistory.then(res => {
      if (!res.ok) return
      const recs = res.data?.records || []
      const total = res.data?.total ?? 0
      if (replace) {
        const first = recs.map(r => recordToRichMessage(r as any))
        // SSE events may have already appended in-flight (order,sub) bubbles to the
        // cache slot while the http fetch was in flight. Preserve the non-done ones
        // (current running round) and merge by sorted (order,subRank) without
        // duplicating record-level bubbles already persisted.
        const tail = messagesBySidRef.current[targetSid] || []
        const sseOnly = tail.filter(m => m.role === "assistant" && m.status !== "done")
        const merged = [...first, ...sseOnly].sort(compareBubbles)
        messagesBySidRef.current[targetSid] = merged
        setMessages(merged)
        historyCursorRef.current = first.length
        historyLoadedRef.current = first.length >= total
      } else if (recs.length > 0) {
        const more = recs.map(r => recordToRichMessage(r as any))
        const existing = messagesBySidRef.current[targetSid] || []
        const known = new Set(existing.map(m => `${m.order}|${m.sub}`))
        const merged = [...more.filter(m => !known.has(`${m.order}|${m.sub}`)), ...existing].sort(compareBubbles)
        messagesBySidRef.current[targetSid] = merged
        setMessages(merged)
        historyCursorRef.current = (historyCursorRef.current ?? 0) + more.length
        if (more.length < PAGE_SIZE || (historyCursorRef.current ?? 0) >= total) {
          historyLoadedRef.current = true
        }
      } else {
        historyLoadedRef.current = true
      }
    }).catch(() => {}).finally(() => { loadingMoreRef.current = false })
  }, [instId, activeSid])

  // Latest loadHistory, exposed via ref so SSE listeners (created once) can call it
  // without capturing a stale closure.
  const loadHistoryRef = useRef(loadHistory)
  loadHistoryRef.current = loadHistory

  // Initial load (on mount / instance change): replace with the latest window.
  // NOTE: deps are deliberately [instId] only — NOT including loadHistory. If
  // loadHistory (which depends on activeSid) were a dep, then switching sessions
  // would rebuild it and re-run this effect, yanking activeSid back to main and
  // looping every time the user clicks a sub-session (the "main stays lit, child
  // never lights" bug). We track the previous instId ourselves so the reset-to-main
  // only fires on a genuine instance change.
  const prevInstRef = useRef<string | null>(null)
  useEffect(() => {
    const changed = prevInstRef.current !== instId
    prevInstRef.current = instId ?? null
    // Load the session list for the director panel (always refresh on instId change).
    if (instId) {
      instancesApi.listSessions(instId).then(res => {
        if (res.ok) setSessionList(mergeServerSessions([], res.data?.sessions || []))
      }).catch(() => {})
    }
    if (!changed) return
    // Only reset to main on a true instance change / first mount.
    setMessages([])
    messagesBySidRef.current = {}
    setActiveSid(MAIN_SID)
    historyCursorRef.current = null
    historyLoadedRef.current = false
    loadHistory(true, MAIN_SID)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instId])

  // Lazy-load earlier history when the user scrolls near the top.
  const handleHistoryScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget
    if (el.scrollTop < 60 && !historyLoadedRef.current && !loadingMoreRef.current) {
      loadHistory(false)
    }
  }, [loadHistory])

  // Switch the director panel's active session. The current session's messages
  // are cached; the newly selected session's history is loaded into view.
  const switchSession = useCallback((sid: string) => {
    if (sid === activeSid) {
      // 已是当前会话，仅清"有新消息"标志（若它还在）
      clearSessionNew(sid)
      return
    }
    // Cache whatever is in view now, under its session key.
    if (messagesBySidRef.current[activeSid]?.length !== messages.length || activeSid === sid) {
      messagesBySidRef.current[activeSid] = messages
    }
    setActiveSid(sid)
    clearSessionNew(sid)
    // 查询通道：切换会话时拉一次后端权威的 running 初始状态。
    // This populates sessionStateMap so isStreaming / elapsed / tokenCount are
    // correct immediately for the target session.
    refreshSessionsStatus()
    // 同步拉取目标会话的思考强度,更新顶部轮换按钮的显示。
    refreshSessionEffort(sid)
    historyCursorRef.current = null
    historyLoadedRef.current = false
    // If the session is running, always rebuild from jsonl rather than trusting
    // the cache.  Background SSE events from a multi-round tool_loop may have
    // partially overwritten the cached messagesBySidRef slot (see the "done"-only
    // invalidation rule in the session_event handler), so the cache is stale.
    const isRunning = sessionStateRef.current[sid]?.running === true
    const cached = isRunning ? undefined : messagesBySidRef.current[sid]
    if (cached) {
      setMessages(cached)
      historyLoadedRef.current = true
    } else {
      setMessages([])
      loadHistory(true, sid)
    }
  }, [activeSid, messages, loadHistory, clearSessionNew, refreshSessionsStatus, refreshSessionEffort])

  // Latest switchSession, exposed via ref so once-created SSE listeners can drive
  // a passive switch (e.g. session_destroyed) through the SAME unified path as a
  // user clicking a tab — without capturing a stale closure. Mirrors loadHistoryRef.
  const switchSessionRef = useRef(switchSession)
  switchSessionRef.current = switchSession

  /**
   * Merge a freshly-listed set of server sessions into the current list WITHOUT
   * dropping entries a transient backend miss or an in-flight event may have
   * hidden. Server entries update record_count; local-only sessions (e.g. just
   * created, or broadcast-injected) are kept. Removal happens only explicitly
   * via session_destroyed.
   */
  const mergeServerSessions = useCallback((local: typeof sessionList, server: typeof sessionList) => {
    const byId = new Map(local.map(s => [s.session_id, s]))
    for (const s of server) byId.set(s.session_id, s)
    return [...byId.values()]
  }, [])

  // Refresh session list when a child session is destroyed remotely.
  const refreshSessionList = useCallback(() => {
    if (instId) {
      instancesApi.listSessions(instId).then(res => {
        if (res.ok) setSessionList(mergeServerSessions(sessionList, res.data?.sessions || []))
      }).catch(() => {})
    }
  }, [instId, sessionList, mergeServerSessions])

  /**
   * Session-aware messages setter. Stream closures capture the session that
   * started them; updates always land in that session's cached array, and only
   * mirror to the live `messages` state when that session is on screen. This
   * keeps a sub-session's stream from corrupting another session while the user
   * switches the panel during generation.
   */
  const activeSidRef = useRef(MAIN_SID)
  activeSidRef.current = activeSid
  const setMessagesFor = useCallback((sid: string, updater: (prev: RichMessage[]) => RichMessage[]) => {
    const slot = messagesBySidRef.current[sid]
    const base = slot || []
    const next = updater(base)
    messagesBySidRef.current[sid] = next
    if (activeSidRef.current === sid) {
      setMessages(next)
    }
  }, [])

  const [input, setInput] = useState("")
  const [error, setError] = useState("")
  // 大输入框模式：点击按钮后独占「历史记录 + 输入框」总高度的 80%，便于长文本输入
  const [expandedInput, setExpandedInput] = useState(false)
  // 普通模式下输入框自动变高的上限（像素）
  const INPUT_GROW_MAX = 120
  const [autoApproveCommit, setAutoApproveCommit] = useState(() => {
    const saved = localStorage.getItem("teahouse_auto_approve_commit")
    return saved === "true"
  })
  // Ref to always read the latest autoApproveCommit inside streaming closures
  const autoApproveCommitRef = useRef(autoApproveCommit)
  autoApproveCommitRef.current = autoApproveCommit
  const [approving, setApproving] = useState(false)

  // Git state from unified store
  const gitStatus = useGitStore((s) => s.gitStatus)
  const fileStatuses = useGitStore((s) => s.fileStatuses)
  const [showGitDialog, setShowGitDialog] = useState(false)

  // Refresh git on instance change
  useEffect(() => {
    if (instId) {
      useGitStore.getState().fetchGitStatus(instId)
    }
  }, [instId])

  const latestCommitMsg = gitStatus?.recent_commits?.[0]?.message
  const currentBranch = gitStatus?.current_branch || "main"

  // Compute file change counts
  const changeCounts = { added: 0, modified: 0, deleted: 0 }
  for (const st of fileStatuses.values()) {
    if (st === "A" || st === "?") changeCounts.added++
    else if (st === "M" || st === "R") changeCounts.modified++
    else if (st === "D") changeCounts.deleted++
  }
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const [commandIndex, setCommandIndex] = useState(0)

  // ── Generation state (minimal — backend is authoritative) ──
  // approvalData is the only remaining global generation-level state;
  // running / elapsed / tokenCount come from sessionStateMap per-session.
  const genApprovalData = useGenerationStore((s) => s.approvalData)
  const pendingApproval = genApprovalData

  // Convenience aliases for the currently-viewed session
  const isGlobalGenerating = isStreaming
  const isIdle = !isStreaming
  const elapsed = activeState.elapsed
  const tokenCount = activeState.tokenCount

  // ── Waiting timer (frontend-local, one-shot per session) ──
  // Each session with waiting=true ticks its own "等待中 Ns" counter.
  // Running elapsed is pushed by the backend via SSE stats.
  useEffect(() => {
    const timer = setInterval(() => {
      const cur = sessionStateRef.current
      let changed = false
      const next = { ...cur }
      for (const [s, st] of Object.entries(cur)) {
        if (st.waiting && st.waitingSince > 0) {
          next[s] = { ...st, elapsed: Math.floor((Date.now() - st.waitingSince) / 1000) }
          changed = true
        }
      }
      if (changed) {
        sessionStateRef.current = next
        setSessionStateMap(next)
      }
    }, 250)
    return () => clearInterval(timer)
  }, [])

  // Available commands for autocomplete.
  // A command with a `params` list gets a second autocomplete stage: after the
  // name is picked, the menu suggests parameter values instead.
  interface CommandParam {
    name: string
    description: string
  }
  interface CommandDef {
    name: string
    description: string
    params?: CommandParam[]
  }
  const COMMANDS: CommandDef[] = [
    { name: "/clear", description: "清空当前对话" },
    {
      name: "/think",
      description: "设置思考强度",
      params: [
        { name: "none", description: "关闭思考" },
        { name: "low", description: "低" },
        { name: "mid", description: "中" },
        { name: "high", description: "高" },
        { name: "max", description: "最高" },
      ],
    },
  ]

  // Two-stage autocomplete derived purely from `input` (no extra state).
  // - stage "command": "/xxx" without a space → suggest command names.
  // - stage "param":   "/name <tail>" on a command with params → suggest param values.
  // - stage "none":    otherwise → no menu.
  type CompletionStage = "none" | "command" | "param"
  const parseCommandInput = (value: string): {
    stage: CompletionStage
    command: CommandDef | null
    nick: (CommandDef | CommandParam)[]
  } => {
    if (!value.startsWith("/")) return { stage: "none", command: null, nick: [] }
    const paramMatch = value.match(/^\/(\S+)\s+([^/]*)$/)
    if (paramMatch) {
      const cmd = COMMANDS.find((c) => c.name === "/" + paramMatch[1]) || null
      if (!cmd || !cmd.params) return { stage: "none", command: null, nick: [] }
      const tail = paramMatch[2]
      // A full param value already in place means the command is complete — close
      // the menu so Enter runs it instead of re-picking the same param.
      if (cmd.params.some((p) => p.name === tail)) {
        return { stage: "none", command: null, nick: [] }
      }
      return {
        stage: "param",
        command: cmd,
        nick: cmd.params.filter((p) => p.name.startsWith(tail)),
      }
    }
    return {
      stage: "command",
      command: null,
      nick: COMMANDS.filter((c) => c.name.startsWith(value)),
    }
  }

  const completion = parseCommandInput(input)
  const filteredCommands = completion.nick

  // Clamp commandIndex when filtered list shrinks
  useEffect(() => {
    setCommandIndex((i) => Math.min(i, Math.max(filteredCommands.length - 1, 0)))
  }, [filteredCommands.length])

  const scrollToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      if (scrollRef.current) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight
      }
    })
  }, [])

  // 用户聚焦输入框开始输入时，自动吸底一次，让用户看到最新对话
  const handleInputFocus = useCallback(() => {
    scrollToBottom()
  }, [scrollToBottom])

  // Auto-scroll when messages change (except during streaming to avoid forced bottom-pinning)
  useEffect(() => {
    if (!isStreaming) {
      scrollToBottom()
    }
  }, [messages, isStreaming, scrollToBottom])

  // 布局变化时（tab 栏出现、footer 变化等）滚到底部
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const observer = new ResizeObserver(() => {
      if (!isStreaming) {
        el.scrollTop = el.scrollHeight
      }
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [isStreaming])

  const handleStop = useCallback(() => {
    const inst = getActiveInstance()
    if (inst) {
      instancesApi.interruptSession(inst.id, activeSid).catch(() => {})
    }
  }, [activeSid])

  // When the active session transitions from running → idle, mark any
  // incomplete tool_call blocks as "(interrupted)" and close the bubble.
  const prevStreamingRef = useRef(false)
  useEffect(() => {
    if (!isStreaming && prevStreamingRef.current) {
      setMessages(prev => {
        let changed = false
        const next = prev.map(m => {
          if (m.role !== "assistant" || !m.blocks || m.status === "done") return m
          changed = true
          const updatedBlocks = m.blocks.map(b => {
            if (b.type === "tool_call" && b.result === undefined) {
              return { ...b, result: "(interrupted)" }
            }
            return b
          })
          return { ...m, blocks: updatedBlocks, status: "done" as MsgStatus }
        })
        return changed ? next : prev
      })
    }
    prevStreamingRef.current = isStreaming
  }, [isStreaming])

  // ESC 快捷键：停止生成
  // 注意：handler 里的 running/waiting 必须从 ref 读最新值——把 isStreaming/
  // isWaiting 放进依赖数组会让监听器随每次流式状态变化反复重建，且闭包若只
  // 捕获首次渲染的值会导致 ESC 在生成中失效（按钮在 render 里每次读，故正常）。
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return
      const sidNow = activeSidRef.current
      const st = sessionStateRef.current[sidNow]
      const running = st?.running === true
      const waiting = st?.waiting === true && !running
      if (!running && !waiting) return
      e.preventDefault()
      handleStop()
    }
    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [handleStop])

  const handleSend = async (useTools: boolean = true) => {
    const text = input.trim()
    if (!text) return

    setExpandedInput(false)
    _doSend(text, useTools)
  }

  // 核心发送逻辑（供 handleSend 和 sandbox 调用的共享函数）
  const _doSend = async (text: string, useTools: boolean, targetSid?: string) => {
    const sid = targetSid || activeSid

    // /clear command
    if (text === "/clear") {
      setMessages([])
      messagesBySidRef.current[sid] = []
      setInput("")
      historyCursorRef.current = null
      historyLoadedRef.current = true
      const inst = getActiveInstance()
      if (inst) {
        instancesApi.clearSessionMemory(inst.id, sid).catch(() => {})
      }
      const label = sid === "main" ? "主会话" : `子会话 ${sid}`
      toast.success(`已清除 ${label} 内容`)
      scrollToBottom()
      return
    }

    // /think command — set reasoning effort for the active session.
    // Persists: main → user default (global), child → that session's meta.
    const thinkMatch = text.match(/^\/think\s+(\S+)$/)
    if (thinkMatch) {
      const effort = thinkMatch[1].toLowerCase()
      const valid = ["none", "low", "mid", "high", "max"]
      if (!valid.includes(effort)) {
        toast.error(`无效思考强度：${thinkMatch[1]}。可选 ${valid.join("|")}`)
        return
      }
      const activeInst = getActiveInstance()
      if (!activeInst) {
        toast.error("未选中实例,无法设置思考强度")
        return
      }
      const res = await instancesApi.setSessionReasoning(activeInst.id, sid, effort)
      if (res.ok) {
        const scope = res.data?.scope
        const label = sid === "main" ? "主会话" : `子会话 ${sid}`
        toast.success(
          scope === "user"
            ? `主会话思考强度已设为 ${effort}`
            : `${label} 思考强度已设为 ${effort}`,
        )
      } else {
        toast.error(`设置思考强度失败:${res.error || "未知错误"}`)
      }
      setInput("")
      scrollToBottom()
      return
    }

    if (!text.trim()) return

    const activeInst = getActiveInstance()
    const shouldUseTools = useTools && activeInst !== null

    // For the tools path, the backend broadcasts session_user_msg synchronously
    // during enqueue() inside the POST handler. Let that SSE event create both
    // the user bubble and the pending assistant bubble — do NOT optimistically
    // append here, or the message will appear twice.

    setInput("")
    setError("")
    scrollToBottom()

    try {
      if (shouldUseTools) {
        // Enter waiting state for this session BEFORE the backend responds.
        // The backend broadcasts session_user_queued (creates grey bubble) and
        // session_user_msg (upgrades to white). The first session_event will
        // transition waiting→running via applyBackendState.
        patchSessionState(sid, { waiting: true, waitingSince: Date.now(), elapsed: 0, tokenCount: 0 })
        await chatApi.sendDirectorMessage(
          [{ role: "user", content: text }],
          activeInst!.id,
          sid,
        )
      } else {
        // Writer path (non-tools): still uses direct SSE streaming. These local
        // bubbles carry negative orders (a private namespace) so they sort after
        // all backend-ordered (>=0) bubbles and never collide with them.
        writerLocalOrderRef.current -= 2
        const localOrder = writerLocalOrderRef.current
        const userMsg: RichMessage = { id: nextId(), role: "user", content: text, reasoning: "", status: "done", order: localOrder, sub: null, subRank: 0 }
        const pendingAssistant: RichMessage = { id: nextId(), role: "assistant", content: "", reasoning: "", status: "pending", blocks: [], order: localOrder + 1, sub: null, subRank: 0 }
        setMessagesFor(sid, (prev) => [...prev, userMsg, pendingAssistant])
        const mergedMessages = mergeConsecutiveSameRole([...messages, userMsg, pendingAssistant])
        const apiMessages = mergedMessages.map((m) => {
          const msg: Record<string, unknown> = { role: m.role, content: m.content || "" }
          if (m.blocks && m.blocks.length > 0) msg.blocks = m.blocks
          if (m.reasoning) msg.reasoning = m.reasoning
          return msg
        })
        const stream = await chatApi.sendStream(apiMessages, undefined, "writer")
        const reader = stream.getReader()
        const decoder = new TextDecoder()
        let buffer = ""
        let currentType: string | null = null
        const writerMsg = pendingAssistant

        const processLine = async (line: string) => {
          if (line.startsWith("event: ")) { currentType = line.slice(7).trim(); return }
          if (!line.startsWith("data: ")) return
          const dataStr = line.slice(6).trim()
          if (!dataStr) return
          if (currentType === "done") {
            setMessagesFor(sid, (prev) =>
              updateMessage(prev, writerMsg.id, (m) => m.status === "done" ? m : { ...m, status: "done" }) || prev
            )
            return
          }
          try {
            const data = JSON.parse(dataStr)
            const chunkText = data.text || ""
            if (data.type === "reasoning") {
              setMessagesFor(sid, (prev) =>
                updateMessage(prev, writerMsg.id, (m) => ({ ...m, status: "reasoning", reasoning: m.reasoning + chunkText })) || prev
              )
            } else if (chunkText) {
              setMessagesFor(sid, (prev) =>
                updateMessage(prev, writerMsg.id, (m) => ({ ...m, status: "streaming", content: m.content + chunkText })) || prev
              )
            }
          } catch { /* skip malformed */ }
        }

        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split("\n")
          buffer = lines.pop() || ""
          for (const line of lines) await processLine(line)
        }
        if (buffer.trim()) {
          for (const line of buffer.split("\n")) await processLine(line)
        }
        setMessagesFor(sid, (prev) =>
          updateMessage(prev, writerMsg.id, (m) => m.status === "done" ? m : { ...m, status: "done" }) || prev
        )
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return
      setError(err instanceof Error ? err.message : "请求失败")
    }
  }

  // 沙盒 Teahouse.send() 消息 → 入队列 (no polling, fire-and-forget)
  const handleSandboxSend = useCallback((msg: string, targetSid?: string) => {
    const sid = targetSid || activeSid
    const inst = getActiveInstance()
    if (!inst) return
    // 与 _doSend 保持一致：发送前进入 waiting，待首个 session_event 转 running 时清掉。
    patchSessionState(sid, { waiting: true, waitingSince: Date.now(), elapsed: 0, tokenCount: 0 })
    chatApi.sendDirectorMessage([{ role: "user", content: msg }], inst.id, sid).catch(() => {})
  }, [activeSid])

  // Check sessionStore for pending sandbox messages (polled lightly)
  useEffect(() => {
    const interval = setInterval(() => {
      const bSess = useSessionStore.getState().pendingSessionSend
      if (bSess) {
        useSessionStore.getState().setPendingSessionSend(null)
        const sid = bSess.sessionId
        setSessionList(prev => {
          if (prev.some(s => s.session_id === sid)) return prev
          return [...prev, { session_id: sid, record_count: 0 }]
        })
        if (bSess.focus !== false) {
          if (activeSidRef.current !== sid) {
            switchSession(sid)
            activeSidRef.current = sid
          }
        }
        handleSandboxSend(bSess.message, sid)
        return
      }
      const msg = useSessionStore.getState().pendingMessage
      if (msg) {
        useSessionStore.getState().setPendingMessage(null)
        handleSandboxSend(msg)
      }
    }, 300)
    return () => clearInterval(interval)
  }, [activeSid, switchSession, handleSandboxSend])

  // 普通模式下输入框随输入自动变高（有上限）；大输入框模式下交给 flex 拉伸填满，须清掉内联高度让其生效
  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    if (expandedInput) {
      el.style.height = ""
      return
    }
    el.style.height = "auto"
    el.style.height = Math.min(el.scrollHeight, INPUT_GROW_MAX) + "px"
  }, [input, expandedInput])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (filteredCommands.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault()
        setCommandIndex((i) => (i + 1) % filteredCommands.length)
        return
      }
      if (e.key === "ArrowUp") {
        e.preventDefault()
        setCommandIndex((i) => (i - 1 + filteredCommands.length) % filteredCommands.length)
        return
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault()
        const selected = filteredCommands[commandIndex]
        if (completion.stage === "command" && selected && "params" in selected) {
          // Pick a command name → fill with trailing space so the param stage fires.
          setInput((selected as CommandDef).name + " ")
        } else if (completion.stage === "param" && selected) {
          // Pick a param value → fill the full "cmd param" and let the Enter-to-send
          // branch below execute it.
          setInput(`${completion.command!.name} ${(selected as CommandParam).name}`)
        } else if (selected) {
          // Param-less command name → fill with trailing space (no second stage).
          setInput((selected as CommandDef).name + " ")
        }
        setCommandIndex(0)
        inputRef.current?.focus()
        return
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      if (input.trim()) {
        handleSend()
      }
    }
  }

  return (
    <div className="h-full flex flex-col relative">
      {/* Header */}
      <ChatHeader
        slotModels={slotModels}
        enabledPluginCount={enabledPluginCount}
        onOpenSettings={openSettings}
        MAIN_SID={MAIN_SID}
        sessionList={sessionList}
        activeSid={activeSid}
        newMsgMap={newMsgMap}
        onSwitchSession={switchSession}
        onRefreshSessionList={refreshSessionList}
        instId={instId}
        currentBranch={currentBranch}
        latestCommitMsg={latestCommitMsg}
        changeCounts={changeCounts}
        onOpenGitDialog={() => setShowGitDialog(true)}
        autoApproveCommit={autoApproveCommit}
        onAutoApproveChange={(checked) => {
          setAutoApproveCommit(checked)
          localStorage.setItem("teahouse_auto_approve_commit", String(checked))
        }}
        reasoningEffort={currentEffort}
        onCycleReasoningEffort={cycleSessionEffort}
      />

      {/* Messages */}
      <div ref={scrollRef} onScroll={handleHistoryScroll} className={`overflow-auto px-3 py-2 space-y-3 min-h-0 ${expandedInput ? "flex-[0.2]" : "flex-1"}`}>
        {messages.length === 0 && (
          <div className="text-center text-muted-foreground py-8">
            <p className="text-sm">发送消息开始对话</p>
          </div>
        )}

        {(() => {
          // 找到当前最新的 assistant 消息（只有它应显示"生成中"指示器）
          const lastAssistantId = [...messages].reverse().find(m => m.role === "assistant")?.id
          return (
            <>
              {messages.map((msg) => (
                <div key={msg.id} className={`flex ${msg.autoKind ? "justify-center" : (msg.role === "user" ? "justify-end" : "justify-start")}`}>
                  {msg.role === "assistant" ? (
                    <AssistantBubble
                      message={msg}
                      isLatest={msg.id === lastAssistantId}
                      isGlobalGenerating={isGlobalGenerating}
                      isIdle={isIdle}
                    />
                  ) : msg.role === "user" && msg.autoKind ? (
                    <div className="max-w-fit rounded-md px-2.5 py-1 text-[11px] text-muted-foreground/70 bg-muted/40 flex items-center gap-1.5">
                      {msg.autoKind === "interrupt" ? (
                        <>
                          <X className="h-3 w-3 text-muted-foreground/60" />
                          <span>用户中断了生成</span>
                        </>
                      ) : msg.autoKind === "endsession" ? (
                        <>
                          <Flag className="h-3 w-3 text-muted-foreground/60" />
                          <span>会话经 EndSession 结束</span>
                        </>
                      ) : (
                        <>
                          <CheckCircle2 className="h-3 w-3 text-muted-foreground/60" />
                          <span>子会话已结束：<span className="font-mono">{msg.autoSid || ""}</span></span>
                        </>
                      )}
                    </div>
                  ) : msg.status === "queued" ? (
                    <div className="max-w-[85%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap break-words bg-muted text-muted-foreground flex items-center gap-2">
                      <Loader2 className="h-3 w-3 animate-spin" />
                      {msg.content}
                    </div>
                  ) : (
                    <div className="max-w-[85%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap break-words bg-primary text-primary-foreground">
                      {msg.content}
                    </div>
                  )}
                </div>
              ))}

        {/* Standalone 等待中 / 生成中 indicator — always at the bottom
            of the message list when waiting or generating. */}
        {(isWaiting || isStreaming) && (
          <div className="flex justify-start">
            <div className="max-w-[85%] rounded-lg px-3 py-2 bg-muted text-sm text-muted-foreground flex items-center gap-2">
              <Loader2 className="h-3 w-3 animate-spin" />
              <span>{isWaiting ? "等待中..." : "生成中..."}</span>
              <span className="text-[10px] text-muted-foreground/60">
                {elapsed > 0 && `${elapsed}s`}
                {!isWaiting && tokenCount > 0 && `, ${tokenCount >= 1000 ? (tokenCount / 1000).toFixed(1) + "k" : tokenCount} tokens`}
              </span>
              {!isWaiting && <span className="inline-block w-2 h-4 bg-foreground/50 animate-pulse" />}
            </div>
          </div>
        )}

        {error && (
          <div className="text-center">
            <p className="text-xs text-red-500">{error}</p>
          </div>
        )}
            </>
          )
        })()}
      </div>

      {/* Input */}
      <ChatInput
        input={input}
        onInputChange={setInput}
        onKeyDown={handleKeyDown}
        inputRef={inputRef}
        isStreaming={isStreaming || isWaiting}
        expandedInput={expandedInput}
        onToggleExpand={() => setExpandedInput(v => !v)}
        onSend={handleSend}
        onStop={handleStop}
        onFocus={handleInputFocus}
        filteredCommands={filteredCommands}
        commandIndex={commandIndex}
        onCommandHover={setCommandIndex}
        onCommandSelect={(name) => {
          if (completion.stage === "param") {
            // Selecting a param value → fill full "cmd param", don't keep the menu open.
            setInput(`${completion.command!.name} ${name}`)
          } else {
            // Selecting a command name → fill with trailing space so the param stage fires.
            setInput(name + " ")
          }
          setCommandIndex(0)
          inputRef.current?.focus()
        }}
        pendingApproval={pendingApproval}
        approving={approving}
        commitPreview={pendingApproval ? formatCommitPreview(pendingApproval.args) : ""}
        onApprove={async () => {
          const data = pendingApproval!
          setApproving(true)
          const inst = getActiveInstance()
          if (!inst) { setApproving(false); return }
          const res = await gitApi.approveTool(inst.id, data.id, data.args)
          setApproving(false)
          if (!res.ok) {
            toast.error("批准提交失败")
            return
          }
          useGenerationStore.getState().resolveApproval()
        }}
        onReject={async () => {
          const data = pendingApproval!
          setApproving(true)
          const inst = getActiveInstance()
          if (!inst) { setApproving(false); return }
          const res = await gitApi.rejectTool(inst.id, data.id, "")
          setApproving(false)
          if (!res.ok) {
            toast.error("拒绝请求失败")
            return
          }
          useGenerationStore.getState().resolveApproval()
        }}
      />

      {/* Floor stats footer */}
      {floorsStats && floorsStats.latest_floor != null && (
        <div className="px-3 pb-2 shrink-0">
          <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
            <span>
              最新楼层: <span className="text-foreground font-mono">{String(floorsStats.latest_floor).padStart(3, '0')}</span>
              （共 {floorsStats.total_confirmed} 正式层
              {floorsStats.total_drafts > 0 && <span> + {floorsStats.total_drafts} 草稿层</span>}
              {floorsStats.unsummarized > 0 && <span>，{floorsStats.unsummarized} 层未总结</span>}）
            </span>
            {floorsStats.last_summary_start != null ? (
              <span>
                | 上次总结: <span className="text-foreground font-mono">
                  {floorsStats.last_summary_start === floorsStats.last_summary_end
                    ? `第 ${floorsStats.last_summary_start} 层`
                    : `第 ${floorsStats.last_summary_start}~${floorsStats.last_summary_end} 层`}
                </span>
              </span>
            ) : (
              <span>| 当前尚无总结</span>
            )}
          </div>
        </div>
      )}

      {/* Git Dialog */}
      <GitDialog
        instanceId={getActiveInstance()?.id || ""}
        open={showGitDialog}
        onClose={() => {
          setShowGitDialog(false)
          if (instId) useGitStore.getState().fetchGitStatus(instId)
        }}
        onRefresh={() => {
          if (instId) useGitStore.getState().fetchGitStatus(instId)
          onGitRefresh?.()
        }}
      />
    </div>
  )
}
