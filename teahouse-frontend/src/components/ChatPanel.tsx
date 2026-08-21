import { useState, useRef, useEffect, useCallback, useMemo } from "react"
import { useTranslation } from "react-i18next"
import { Loader2, X, CheckCircle2, Flag, ArrowRight, FileText } from "lucide-react"
import { chatApi, llmSlotsApi, llmModelsApi, instancesApi, gitApi, pluginsApi, toolsApi } from "@/lib/api"
import { getApiBaseUrl } from "@/lib/apiBaseUrl"
import { getActiveInstance, useSessionStore } from "@/stores/sessionStore"
import { useGenerationStore } from "@/stores/generationStore"
import { useGitStore } from "@/stores/gitStore"
import { useSettingsDialogStore } from "@/stores/settingsDialogStore"
import { useIsMobile } from "@/hooks/useMediaQuery"
import type { FloorsStats, ContextUsage } from "@/lib/types"
import { toast } from "sonner"
import { GitDialog } from "@/components/GitDialog"
import { ContextUsageBar } from "./ChatPanelComps/ContextUsageBar"
import type { MsgStatus, ContentBlock, RichMessage } from "./ChatPanelComps/types"
import { nextId, mergeConsecutiveSameRole, updateMessage, formatCommitPreview, compareBubbles, insertBubbleSorted, autoMsgKind, autoKindFields, longMsgPath, pasteNoticeText } from "./ChatPanelComps/utils"
import { AssistantBubble } from "./ChatPanelComps/AssistantBubble"
import { ChatHeader } from "./ChatPanelComps/ChatHeader"
import { ChatInput } from "./ChatPanelComps/ChatInput"

export function ChatPanel({ onGitRefresh, onClosePanel }: { onGitRefresh?: () => void; onClosePanel?: () => void }) {
  const { t } = useTranslation("chat")
  const isMobile = useIsMobile()
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
    compacting: boolean    // true during session compact
  }
  const [sessionStateMap, setSessionStateMap] = useState<Record<string, SessionUIState>>({})
  const sessionStateRef = useRef<Record<string, SessionUIState>>({})
  sessionStateRef.current = sessionStateMap

  const MAIN_SID = "main"
  const [activeSid, setActiveSid] = useState(MAIN_SID)

  // Convenience getter/setter for the currently-viewed session
  const activeState: SessionUIState = sessionStateMap[activeSid] ?? {
    running: false, elapsed: 0, tokenCount: 0, waiting: false, waitingSince: 0, compacting: false,
  }
  const isStreaming = activeState.running
  const isWaiting = activeState.waiting && !activeState.running
  const isCompacting = activeState.compacting

  const patchSessionState = useCallback((sid: string, patch: Partial<SessionUIState>) => {
    const prev = sessionStateRef.current[sid] ?? {
      running: false, elapsed: 0, tokenCount: 0, waiting: false, waitingSince: 0, compacting: false,
    }
    const next = { ...sessionStateRef.current, [sid]: { ...prev, ...patch } }
    sessionStateRef.current = next
    setSessionStateMap(next)
  }, [])

  // Update running+stats from backend-authoritative sources (SSE / API)
  const applyBackendState = useCallback((sid: string, running: boolean, stats?: { elapsed?: number; token_count?: number }) => {
    const prev = sessionStateRef.current[sid] ?? {
      running: false, elapsed: 0, tokenCount: 0, waiting: false, waitingSince: 0, compacting: false,
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
  const [sessionList, setSessionList] = useState<{ session_id: string; record_count: number; enabled_tools?: string[] }[]>([])
  // 内置工具清单（name + short），来自后端 tools.json，驱动 permission 补全
  const [availableTools, setAvailableTools] = useState<{ name: string; short: string }[]>([])
  useEffect(() => {
    toolsApi.listTools().then(res => {
      if (res.ok) setAvailableTools(res.data?.tools || [])
    }).catch(() => {})
  }, [])
  const messagesBySidRef = useRef<Record<string, RichMessage[]>>({})
  // Track the active streaming assistant per session for session_event-based real-time
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
      const label = activeSid === MAIN_SID ? t("mainSession") : t("subSession", { sid: activeSid })
      toast.success(t("effortSetSuccess", { label, effort: next }))
    } else {
      toast.error(t("effortSetFail", { err: res.error || t("unknownError") }))
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
              compacting: false,
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

  // 上下文用量（活跃会话）
  const [contextUsage, setContextUsage] = useState<ContextUsage | null>(null)
  const refreshContextUsage = useCallback(() => {
    if (!instId) return
    instancesApi.contextUsage(instId, activeSid).then(res => {
      setContextUsage(res.ok ? (res.data ?? null) : null)
    }).catch(() => {
      setContextUsage(null)
    })
  }, [instId, activeSid])
  // SSE 事件处理器在 [instId] effect 里注册，闭包会捕获初次渲染的
  // refreshContextUsage（activeSid=main）。用 ref 让它们总能拿到最新回调，
  // 避免子会话完成时把主会话用量错误覆盖到 bar 上。
  const refreshContextUsageRef = useRef(refreshContextUsage)
  useEffect(() => {
    refreshContextUsageRef.current = refreshContextUsage
  })

  useEffect(() => {
    refreshContextUsage()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instId, activeSid])

  // 兜底轮询：ChatPanel 常驻挂载，事件遗漏也能保持用量新鲜
  useEffect(() => {
    if (!instId) return
    const t = setInterval(refreshContextUsage, 10000)
    return () => clearInterval(t)
  }, [instId, refreshContextUsage])

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
      const es = new EventSource(`${getApiBaseUrl()}/events`)
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
            return [...prev, { session_id: data.session_id, record_count: 0, enabled_tools: data.enabled_tools }]
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
          const evType = data.type as string

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
              // 新气泡产生且当前靠近底部 → 开开关 + 吸底（规则 2）。
              // 只在“创建”瞬间判定（流式正文追加不算），避免正文每增一行都重开开关。
              if (isNearBottom()) {
                stickRef.current = true
              }
              let placed = insertBubbleSorted(prev, fresh)
              // Apply the streaming chunk onto the freshly created bubble.
              placed = placed.map(m => (m.id === fresh.id ? action(m) : m))
              return placed
            }

            // ── Compact events ──
            if (evType === "compact_started") {
              patchSessionState(sid, { compacting: true })
              return
            }
            if (evType === "compact_done") {
              patchSessionState(sid, { compacting: false })
              refreshContextUsageRef.current()
              if (data.error) {
                if (data.error !== "interrupted") {
                  toast.error(t("compactFailMsg", { err: data.error }))
                }
              } else {
                // Reload history so the compact summary record appears
                setMessages([])
                messagesBySidRef.current[sid] = []
                historyCursorRef.current = null
                historyLoadedRef.current = true
                loadHistory(true, sid)
              }
              return
            }

            if (evType === "done") {
              // Final done carries force_close semantics: the backend round is
              // over; close every still-open assistant bubble (drop empty ones).
              refreshContextUsageRef.current()
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

            if (evType === "assistant_done") {
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

            if (evType === "tool_call") {
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

            if (evType === "tool_result") {
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

            if (evType === "approval_required") {
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
                          result: t("autoApproved"),
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
            if (evType === "text" || evType === "reasoning") {
              // Defensive: skip tool_args text fragments (OpenAI tool-call arg
              // deltas). The backend also filters these now, but keeping this
              // guard ensures stale backends or edge cases don't flash JSON.
              if (data.tool_args) return
              if (evType === "reasoning") {
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
            if (evType === "done" || evType === "compact_done") {
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
  const settingsOpen = useSettingsDialogStore((s) => s.open)
  const openSettings = useSettingsDialogStore((s) => s.openSettings)
  const [enabledPluginCount, setEnabledPluginCount] = useState(0)

  const refreshSlotModels = useCallback(async () => {
    const res = await llmSlotsApi.getAll()
    if (!res.ok) return
    const slots = res.data!.slots
    const modelIds = [slots.director.model_id, slots.writer.model_id].filter(Boolean) as string[]
    if (modelIds.length === 0) {
      setSlotModels({ director: null, writer: null })
      return
    }
    const mRes = await llmModelsApi.list()
    if (!mRes.ok) return
    const modelMap = new Map(mRes.data!.models.map(m => [m.id, m.name]))
    setSlotModels({
      director: slots.director.model_id ? modelMap.get(slots.director.model_id) || slots.director.model_id : null,
      writer: slots.writer.model_id ? modelMap.get(slots.writer.model_id) || slots.writer.model_id : null,
    })
  }, [])

  useEffect(() => {
    refreshSlotModels()
  }, [refreshSlotModels, messages.length > 0])  // reload on first message sent (hack: refresh when messages change from 0)

  // Enabled plugin count for the header trigger
  const refreshPluginCount = useCallback(async () => {
    const res = await pluginsApi.list()
    if (res.ok) setEnabledPluginCount(res.data!.plugins.filter(p => p.enabled).length)
  }, [])
  useEffect(() => {
    refreshPluginCount()
  }, [refreshPluginCount, messages.length > 0])

  // Re-sync header previews after the settings dialog closes (slot/plugin changes there)
  const prevSettingsOpenRef = useRef(settingsOpen)
  useEffect(() => {
    if (prevSettingsOpenRef.current && !settingsOpen) {
      refreshSlotModels()
      refreshPluginCount()
    }
    prevSettingsOpenRef.current = settingsOpen
  }, [settingsOpen, refreshSlotModels, refreshPluginCount])

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
      // The backend pages by JSONL *record* but returns records expanded into
      // one-or-more display bubbles (reasoning + each block). Advance the cursor
      // by next_offset (record units), never by bubble count — otherwise the
      // offset drifts past records and the loaded-all check fires too early.
      const nextOffset = res.data?.next_offset ?? (offset + new Set(recs.map(r => (r as any).order)).size)
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
        historyCursorRef.current = nextOffset
        historyLoadedRef.current = nextOffset >= total
      } else if (recs.length > 0) {
        const more = recs.map(r => recordToRichMessage(r as any))
        const existing = messagesBySidRef.current[targetSid] || []
        const known = new Set(existing.map(m => `${m.order}|${m.sub}`))
        const merged = [...more.filter(m => !known.has(`${m.order}|${m.sub}`)), ...existing].sort(compareBubbles)
        messagesBySidRef.current[targetSid] = merged
        setMessages(merged)
        historyCursorRef.current = nextOffset
        if (nextOffset >= total) {
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
    // 吸底开关：消费程序化滚动标记；真正由用户向上滚（恢复查看旧内容）时关开关（规则 3）。
    if (isProgrammaticScrollRef.current) {
      isProgrammaticScrollRef.current = false
      return
    }
    if (el.scrollTop < lastUserScrollTopRef.current) {
      stickRef.current = false
    }
    lastUserScrollTopRef.current = el.scrollTop
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

  // Manually create a new sub-session.
  const createSession = useCallback(() => {
    if (!instId) return
    instancesApi.createSession(instId).then(res => {
      if (res.ok) {
        toast.success(t("subSessionCreated", { sid: res.data?.session_id }))
      } else {
        toast.error(t("createSubSessionFail"))
      }
    }).catch(() => {
      toast.error(t("createSubSessionFail"))
    })
  }, [instId])

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
  // Paste blocks (oversized pasted chunks) kept separate from hand-typed text.
  // Badges render above the input; each block can be edited/deleted via a popover.
  const [pastes, setPastes] = useState<{ id: number; content: string }[]>([])
  const pastesRef = useRef(pastes)
  pastesRef.current = pastes
  const pasteIdRef = useRef(0)
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

  // ── 吸底开关（stick-to-bottom）────
  // stickRef：true = 流式正文持续贴底 + 新气泡也贴底；false = 跟随用户阅读位置。
  // 三个来源控制它：
  //   1. 用户发消息 → 强制吸底一次 + 打开开关
  //   2. 新气泡产生且当时靠近底部 → 吸底 + 打开开关
  //   3. 用户主动向上滚动 → 关闭开关
  // 打开开关后，只要 messages 一变（流式正文、新气泡）就强制贴底。
  const stickRef = useRef(true)
  // 距离判定的“近底部”阈值（像素）：规则 2 用它决定要不要开开关。
  const NEAR_BOTTOM_PX = 80
  // 程序化滚动标记：scrollToBottom 设置 scrollTop 前置位，onScroll 消费后清除，
  // 避免程序化滚动被误判成“用户上滑”而关掉开关。
  const isProgrammaticScrollRef = useRef(false)
  // 最近一次用户滚动的 scrollTop，用于判断这次是否向上（滚回查看旧内容）。
  const lastUserScrollTopRef = useRef(0)

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
    // 动态参数：permission-add/remove 的可选工具随当前会话 enabled_tools 变化
    dynamicParams?: () => CommandParam[]
  }
  // 当前激活会话的工具白名单（子会话）；主会话不受限（undefined）
  const activeEnabled = sessionList.find((s) => s.session_id === activeSid)?.enabled_tools
  const COMMANDS: CommandDef[] = useMemo(() => {
    const think: CommandDef = {
      name: "/think",
      description: t("setThink"),
      params: [
        { name: "none", description: t("thinkNone") },
        { name: "low", description: t("thinkLow") },
        { name: "mid", description: t("thinkMid") },
        { name: "high", description: t("thinkHigh") },
        { name: "max", description: t("thinkMax") },
      ],
    }
    const clear: CommandDef = { name: "/clear", description: t("clearConversation") }
    if (activeSid === MAIN_SID) {
      return [think, { name: "/compact", description: t("compactContext") }, clear]
    }
    const enabled = new Set(activeEnabled || [])
    return [
      think,
      clear,
      {
        name: "/permission-add",
        description: t("permissionAddDesc"),
        dynamicParams: () => availableTools.filter((t) => !enabled.has(t.name)).map((t) => ({ name: t.name, description: t.short })),
      },
      {
        name: "/permission-remove",
        description: t("permissionRemoveDesc"),
        dynamicParams: () => availableTools.filter((t) => enabled.has(t.name)).map((t) => ({ name: t.name, description: t.short })),
      },
    ]
  }, [activeSid, activeEnabled, availableTools, t])

  // Two-stage autocomplete derived purely from `input` (no extra state).
  // - stage "command": "/xxx" without a space → suggest command names.
  // - stage "param":   "/name <tail>" on a command with params → suggest param values.
  // - stage "none":    otherwise → no menu.
  type CompletionStage = "none" | "command" | "param"
  const parseCommandInput = (value: string): {
    stage: CompletionStage
    command: CommandDef | null
    nick: (CommandDef | CommandParam)[]
    paramPrefix?: string   // 动态多参数：命令 + 已输入部分（不含待补全的最后一个词）
  } => {
    if (!value.startsWith("/")) return { stage: "none", command: null, nick: [] }
    const paramMatch = value.match(/^\/(\S+)\s+([^/]*)$/)
    if (paramMatch) {
      const cmd = COMMANDS.find((c) => c.name === "/" + paramMatch[1]) || null
      if (!cmd) return { stage: "none", command: null, nick: [] }
      const tail = paramMatch[2]
      // 静态参数（/think）：完整匹配一个参数 → 关闭菜单让 Enter 执行
      if (cmd.params) {
        if (cmd.params.some((p) => p.name === tail)) {
          return { stage: "none", command: null, nick: [] }
        }
        return {
          stage: "param",
          command: cmd,
          nick: cmd.params.filter((p) => p.name.startsWith(tail)),
          paramPrefix: `/${paramMatch[1]} `,
        }
      }
      // 动态多参数（/permission-add|remove）：补全最后一个词，已选工具排除。
      // 尾空格表示用户已敲完一个工具 → 关闭菜单让 Enter 执行。
      if (cmd.dynamicParams) {
        if (tail.endsWith(" ")) return { stage: "none", command: null, nick: [] }
        const lastWord = tail.split(/\s+/).pop() || ""
        const typed = tail.trim().split(/\s+/).slice(0, -1)
        const opts = cmd.dynamicParams()
        return {
          stage: "param",
          command: cmd,
          nick: opts.filter((o) => !typed.includes(o.name) && o.name.startsWith(lastWord)),
          paramPrefix: value.slice(0, value.length - lastWord.length),
        }
      }
      return { stage: "none", command: null, nick: [] }
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

  // 程序化滚到底：置位程序化标记，静默滚动，不触发“用户上滑关开关”。
  // 标记用 setTimeout(0) 兜底清除：若 scrollTop 本就到底（无 scroll 事件），
  // 也能清掉，避免标记永远卡在 true、误吞后续真实用户滚动。
  const scrollToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      if (scrollRef.current) {
        isProgrammaticScrollRef.current = true
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight
        setTimeout(() => { isProgrammaticScrollRef.current = false }, 0)
      }
    })
  }, [])

  // 当前滚动容器是否“靠近底部”（within NEAR_BOTTOM_PX）。
  const isNearBottom = useCallback((): boolean => {
    const el = scrollRef.current
    if (!el) return true
    return el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_PX
  }, [])

  // 布局变化时（tab 栏出现、footer 变化等）：仅当开关还开着才跟随贴底。
  // 用户已上滑离开底部（开关关），布局变动不应把他拽回。
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const observer = new ResizeObserver(() => {
      if (!isStreaming && stickRef.current) {
        scrollToBottom()
      }
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [isStreaming, scrollToBottom])

  // 开关打开时：messages 每变一次（流式正文、新气泡）都强制贴底。
  useEffect(() => {
    if (stickRef.current) {
      scrollToBottom()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, activeSid])

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
      const compacting = st?.compacting === true
      if (!running && !waiting && !compacting) return
      e.preventDefault()
      handleStop()
    }
    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [handleStop])

  const handleSend = async (useTools: boolean = true) => {
    const text = input.trim()
    const hasPastes = pastesRef.current.length > 0
    if (!text && !hasPastes) return

    setExpandedInput(false)
    // Capture current pastes, then clear both working states immediately so the
    // (async) _doSend uses a stable snapshot and the input resets right away.
    const p = pastesRef.current
    setPastes([])
    setInput("")
    _doSend(text, useTools, undefined, p)
  }

  // 核心发送逻辑（供 handleSend 和 sandbox 调用的共享函数）
  const _doSend = async (text: string, useTools: boolean, targetSid?: string, pastes?: { id: number; content: string }[]) => {
    const sid = targetSid || activeSid

    // 命令仅在会话空闲时执行（生成/等待/压缩中禁用）
    const trimmedText = text.trim()
    const isCommand = /^\/(clear|compact|think|permission-add|permission-remove)(\s|$)/.test(trimmedText)
    if (isCommand) {
      const st = sessionStateRef.current[sid]
      if (st?.running || st?.waiting || st?.compacting) {
        toast.error(t("sessionBusyCommand"))
        return
      }
    }

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
      const label = sid === "main" ? t("mainSession") : t("subSession", { sid })
      toast.success(t("clearedContent", { label }))
      return
    }

    // /compact command — send [compact] through the normal session loop
    if (text === "/compact") {
      setInput("")
      const inst = getActiveInstance()
      if (!inst) {
        toast.error(t("noInstanceCompact"))
        return
      }
      setError("")
      patchSessionState(sid, { compacting: true, waiting: true, waitingSince: Date.now(), elapsed: 0, tokenCount: 0 })
      try {
        await chatApi.sendDirectorMessage(
          [{ role: "user", content: "[compact]" }],
          inst.id,
          sid,
        )
      } catch {
        patchSessionState(sid, { compacting: false, waiting: false })
        toast.error(t("compactFail"))
      }
      return
    }

    // /think command — set reasoning effort for the active session.
    // Persists: main → user default (global), child → that session's meta.
    const thinkMatch = text.match(/^\/think\s+(\S+)$/)
    if (thinkMatch) {
      const effort = thinkMatch[1].toLowerCase()
      const valid = ["none", "low", "mid", "high", "max"]
      if (!valid.includes(effort)) {
        toast.error(t("invalidEffort", { name: thinkMatch[1], valid: valid.join("|") }))
        return
      }
      const activeInst = getActiveInstance()
      if (!activeInst) {
        toast.error(t("noInstanceEffort"))
        return
      }
      const res = await instancesApi.setSessionReasoning(activeInst.id, sid, effort)
      if (res.ok) {
        const scope = res.data?.scope
        const label = sid === "main" ? t("mainSession") : t("subSession", { sid })
        toast.success(
          scope === "user"
            ? t("mainEffortSet", { effort })
            : t("effortSetSuccess", { label, effort }),
        )
      } else {
        toast.error(t("effortSetFail", { err: res.error || t("unknownError") }))
      }
      setInput("")
      return
    }

    // /permission-add <tool1> <tool2> ... / /permission-remove <tool1> ...
    // Modify the child session's enabled_tools allow-list in its .meta.json.
    const permMatch = text.match(/^\/(permission-add|permission-remove)(?:\s+(.+))?$/)
    if (permMatch) {
      const action: "add" | "remove" = permMatch[1] === "permission-add" ? "add" : "remove"
      const tools = (permMatch[2] || "").trim().split(/\s+/).filter(Boolean)
      if (sid === MAIN_SID) {
        toast.error(t("permissionMainOnly"))
        return
      }
      if (tools.length === 0) {
        toast.error(t("permissionNoTools", { cmd: permMatch[1] }))
        return
      }
      const activeInst = getActiveInstance()
      if (!activeInst) {
        toast.error(t("noInstancePerm"))
        return
      }
      const res = await instancesApi.setSessionPermissions(activeInst.id, sid, action, tools)
      if (res.ok) {
        const joined = res.data?.enabled_tools?.join(", ") || ""
        toast.success(t("permissionUpdated", { sid, joined }))
        refreshSessionList()
      } else {
        toast.error(t("permissionFail", { err: res.error || t("unknownError") }))
      }
      setInput("")
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
    // 用户发消息：开开关 + 强制吸底一次（规则 1）。之后流式正文会一直贴底。
    stickRef.current = true
    scrollToBottom()

    try {
      if (shouldUseTools) {
        // Enter waiting state for this session BEFORE the backend responds.
        // The backend broadcasts session_user_queued (creates grey bubble) and
        // session_user_msg (upgrades to white). The first session_event will
        // transition waiting→running via applyBackendState.
        patchSessionState(sid, { waiting: true, waitingSince: Date.now(), elapsed: 0, tokenCount: 0 })
        // Director path: send paste blocks as structured content so the backend
        // can fold/spill them (see SessionLoop._compose_message). No pastes →
        // a plain string, matching the previous envelope.
        const content = pastes && pastes.length > 0
          ? { manual: text, pastes: pastes.map((p) => ({ id: p.id, content: p.content })) }
          : text
        await chatApi.sendDirectorMessage(
          [{ role: "user", content }],
          activeInst!.id,
          sid,
        )
      } else {
        // Writer path (non-tools): no backend enqueue — content must stay a
        // plain string. Any paste blocks are concatenated into the text so no
        // content is dropped.
        const writerText = pastes && pastes.length > 0
          ? `${text}\n\n${pastes.map((p) => p.content).join("\n\n")}`
          : text
        // Writer path (non-tools): still uses direct SSE streaming. These local
        // bubbles carry negative orders (a private namespace) so they sort after
        // all backend-ordered (>=0) bubbles and never collide with them.
        writerLocalOrderRef.current -= 2
        const localOrder = writerLocalOrderRef.current
        const userMsg: RichMessage = { id: nextId(), role: "user", content: writerText, reasoning: "", status: "done", order: localOrder, sub: null, subRank: 0 }
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
      setError(err instanceof Error ? err.message : t("requestFail"))
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
          if (completion.command?.dynamicParams) {
            // 动态多参数：保留已输入部分，追加选中工具 + 尾空格
            setInput(`${completion.paramPrefix ?? ""}${(selected as CommandParam).name} `)
          } else {
            // Pick a param value → fill the full "cmd param" and let the Enter-to-send
            // branch below execute it.
            setInput(`${completion.command!.name} ${(selected as CommandParam).name}`)
          }
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
        onCreateSession={createSession}
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
        floorsStats={floorsStats}
        contextUsage={contextUsage}
        onClosePanel={onClosePanel}
      />

      {/* Messages */}
      <div ref={scrollRef} onScroll={handleHistoryScroll} className={`overflow-auto px-3 py-2 space-y-3 min-h-0 ${expandedInput ? "flex-[0.2]" : "flex-1"}`}>
        {messages.length === 0 && (
          <div className="text-center text-muted-foreground py-8">
            <p className="text-sm">{t("startHint")}</p>
          </div>
        )}

        {(() => {
          // 找到当前最新的 assistant 消息（只有它应显示"生成中"指示器）
          const lastAssistantId = [...messages].reverse().find(m => m.role === "assistant")?.id
          // 待发送（灰色）用户消息：单独垫在"生成中"指示器下方
          const queuedMsgs = messages.filter(m => m.status === "queued")
          return (
            <>
              {messages.map((msg) => (
                <div key={msg.id} className={`flex ${msg.autoKind && msg.autoKind !== "long_msg" ? "justify-center" : (msg.role === "user" ? "justify-end" : "justify-start")}`}>
                  {msg.role === "assistant" ? (
                    <AssistantBubble
                      message={msg}
                      isLatest={msg.id === lastAssistantId}
                      isGlobalGenerating={isGlobalGenerating}
                      isIdle={isIdle}
                    />
                  ) : msg.role === "user" && msg.autoKind === "paste_notice" ? (
                    <div className="max-w-fit rounded-md px-2.5 py-1 text-[11px] text-muted-foreground/70 bg-muted/40 flex items-center gap-1.5">
                      <FileText className="h-3 w-3 text-muted-foreground/60" />
                      <span>{pasteNoticeText(msg.content)}</span>
                    </div>
                  ) : msg.role === "user" && msg.autoKind === "long_msg" ? (
                    <div className="max-w-[85%] relative rounded-lg px-3 py-2 text-base bg-primary text-primary-foreground">
                      <span className="whitespace-pre-wrap break-words">
                        <FileText className="inline h-3.5 w-3.5 mr-1.5 align-[-1px]" />
                        <span className="pr-10">已储存为：</span>
                        <span className="font-mono break-all">{longMsgPath(msg.content) || msg.content}</span>
                      </span>
                      <span className="absolute -top-2.5 -right-2 rounded-full bg-destructive text-destructive-foreground text-[10px] px-2 py-0.5 shadow">
                        {t("longMsgBubble")}
                      </span>
                    </div>
                  ) : msg.role === "user" && msg.autoKind ? (
                    <div className="max-w-fit rounded-md px-2.5 py-1 text-[11px] text-muted-foreground/70 bg-muted/40 flex items-center gap-1.5">
                      {msg.autoKind === "interrupt" ? (
                        <>
                          <X className="h-3 w-3 text-muted-foreground/60" />
                          <span>{t("interruptBubble")}</span>
                        </>
                      ) : msg.autoKind === "endsession" ? (
                        <>
                          <Flag className="h-3 w-3 text-muted-foreground/60" />
                          <span>{t("endsessionBubble")}</span>
                        </>
                      ) : msg.autoKind === "compact" ? (
                        <>
                          <Loader2 className="h-3 w-3 animate-spin text-muted-foreground/60" />
                          <span>{t("compactingBubble")}</span>
                        </>
                      ) : msg.autoKind === "auto_continue" ? (
                        <>
                          <ArrowRight className="h-3 w-3 text-muted-foreground/60" />
                          <span>{t("autoContinueBubble")}</span>
                        </>
                      ) : (
                        <>
                          <CheckCircle2 className="h-3 w-3 text-muted-foreground/60" />
                          <span>{t("subSessionEnd")}<span className="font-mono">{msg.autoSid || ""}</span></span>
                        </>
                      )}
                    </div>
                  ) : msg.status === "queued" ? (
                    // Pending (grey) user messages are rendered at the very bottom,
                    // below the "generating" indicator — see `queuedMsgs` below.
                    null
                  ) : (
                    <div className="max-w-[85%] rounded-lg px-3 py-2 text-base whitespace-pre-wrap break-words bg-primary text-primary-foreground">
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
              <span>{isWaiting ? t("waitingDots") : t("generatingDots")}</span>
              <span className="text-[10px] text-muted-foreground/60">
                {elapsed > 0 && `${elapsed}s`}
                {!isWaiting && tokenCount > 0 && `, ${tokenCount >= 1000 ? t("kToken", { n: (tokenCount / 1000).toFixed(1) }) : t("tokensUnit", { n: tokenCount })}`}
              </span>
              {!isWaiting && <span className="inline-block w-2 h-4 bg-foreground/50 animate-pulse" />}
            </div>
          </div>
        )}

        {/* Pending (grey) user messages — truly bottom, below the generating
            indicator, since they are the newest input awaiting the LLM. A divider
            line sits above them to separate queued input from already-sent turns. */}
        {queuedMsgs.length > 0 && (
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground/60 pt-1">
            <div className="flex-1 h-px bg-border" />
            <span>{t("queuedBubble")}</span>
            <div className="flex-1 h-px bg-border" />
          </div>
        )}
        {queuedMsgs.map((msg) => (
          <div key={msg.id} className="flex justify-end">
            <div className="max-w-[85%] rounded-lg px-3 py-2 text-base whitespace-pre-wrap break-words bg-muted text-muted-foreground flex items-center gap-2">
              <Loader2 className="h-3 w-3 animate-spin" />
              {msg.content}
            </div>
          </div>
        ))}

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
        isStreaming={isStreaming || isWaiting || isCompacting}
        expandedInput={expandedInput}
        onToggleExpand={() => setExpandedInput(v => !v)}
        onSend={handleSend}
        onStop={handleStop}
        isCompacting={isCompacting}
        pastes={pastes}
        onAddPaste={(content) => {
          const id = ++pasteIdRef.current
          setPastes((prev) => [...prev, { id, content }])
        }}
        onRemovePaste={(id) => setPastes((prev) => prev.filter((p) => p.id !== id))}
        onUpdatePaste={(id, content) => setPastes((prev) => prev.map((p) => (p.id === id ? { ...p, content } : p)))}
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
            toast.error(t("approveCommitFail"))
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
            toast.error(t("rejectCommitFail"))
            return
          }
          useGenerationStore.getState().resolveApproval()
        }}
      />

      {/* Floor stats footer + context usage（移动端已上移到头部右上角） */}
      {!isMobile && ((floorsStats && floorsStats.latest_floor != null) || (contextUsage && contextUsage.threshold != null)) && (
        <div className="px-3 pb-2 shrink-0">
          <div className="flex items-center gap-2 text-[10px] text-muted-foreground flex-wrap">
            {floorsStats && floorsStats.latest_floor != null && (
              <div className="flex items-center gap-2 min-w-0">
                <span>
                  {t("latestFloor")}<span className="text-foreground font-mono">{String(floorsStats.latest_floor).padStart(3, '0')}</span>
                  {t("ofFloors", { n: floorsStats.total_confirmed })}
                  {floorsStats.total_drafts > 0 && <span>{t("plusDrafts", { n: floorsStats.total_drafts })}</span>}
                  {floorsStats.unsummarized > 0 && <span>{t("unsummarized", { n: floorsStats.unsummarized })}</span>}）
                </span>
                {floorsStats.last_summary_start != null ? (
                  <span>
                    {t("lastSummary")}<span className="text-foreground font-mono">
                      {floorsStats.last_summary_start === floorsStats.last_summary_end
                        ? t("lastSummarySingle", { n: floorsStats.last_summary_start })
                        : t("lastSummaryRange", { a: floorsStats.last_summary_start, b: floorsStats.last_summary_end })}
                    </span>
                  </span>
                ) : (
                  <span>{t("noSummaryYet")}</span>
                )}
              </div>
            )}
            <div className="ml-auto shrink-0">
              <ContextUsageBar usage={contextUsage} />
            </div>
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
