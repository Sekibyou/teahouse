import { useState, useRef, useEffect, useCallback } from "react"
import { Loader2 } from "lucide-react"
import { chatApi, llmSlotsApi, llmModelsApi, instancesApi, gitApi, pluginsApi, API_BASE_URL } from "@/lib/api"
import { getActiveInstance, useSessionStore } from "@/stores/sessionStore"
import { useGenerationStore } from "@/stores/generationStore"
import { useGitStore } from "@/stores/gitStore"
import { useSettingsDialogStore } from "@/stores/settingsDialogStore"
import type { FloorsStats } from "@/lib/types"
import { toast } from "sonner"
import { GitDialog } from "@/components/GitDialog"
import { useDiagnosticLog, DiagnosticPanel } from "@/components/DiagnosticPanel"
import type { MsgStatus, ContentBlock, RichMessage } from "./ChatPanelComps/types"
import { nextId, mergeConsecutiveSameRole, updateMessage, formatCommitPreview } from "./ChatPanelComps/utils"
import { AssistantBubble } from "./ChatPanelComps/AssistantBubble"
import { ChatHeader } from "./ChatPanelComps/ChatHeader"
import { ChatInput } from "./ChatPanelComps/ChatInput"

export function ChatPanel({ onGitRefresh }: { onGitRefresh?: () => void }) {
  const [messages, setMessages] = useState<RichMessage[]>([])
  const [showDiag, setShowDiag] = useState(false)
  const diag = useDiagnosticLog()

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
          // Refresh the session list (merge, keep others) and if the destroyed
          // session was active, fall back to main. The destroyed sid is dropped.
          instancesApi.listSessions(instId!).then(res => {
            if (res.ok) {
              setSessionList(prev => mergeServerSessions(prev, res.data?.sessions || []).filter(s => s.session_id !== data.session_id))
            }
          }).catch(() => {})
          refreshSessionsStatus()
          if (activeSidRef.current === data.session_id) {
            setActiveSid(MAIN_SID)
          }
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
        // The backend persisted a user message to jsonl.  If there is a
        // queue_id, try to upgrade an existing grey "queued" bubble first;
        // otherwise append a fresh user bubble (sub-session wake-up,
        // interrupt auto-message, etc.).
        try {
          const data = JSON.parse(e.data)
          if (instId && data.instance_id !== instId && data.instance_id !== instName) return
          const sid = data.session_id
          if (!sid) return
          const qid = data.queue_id as string | undefined
          window.__TEAHOUSE_LOG__?.("session_user_msg", `sid=${sid} active=${activeSidRef.current} qid=${qid || "NONE"} content=${data.content ? JSON.stringify((data.content as string).slice(0, 80)) : "NONE"}`)
          if (activeSidRef.current === sid && data.content) {
            // Try to upgrade an existing queued bubble first
            let upgraded = false
            if (qid) {
              setMessagesFor(sid, (prev) => {
                const idx = prev.findIndex(m => m._queue_id === qid && m.status === "queued")
                if (idx >= 0) {
                  const next = [...prev]
                  next[idx] = { ...next[idx], status: "done" as MsgStatus }
                  upgraded = true
                  window.__TEAHOUSE_LOG__?.("session_user_msg", `UPGRADED queued msg idx=${idx} → done`)
                  return next
                }
                return prev
              })
            }
            if (!upgraded) {
              // No queued bubble to upgrade — append fresh user message +
              // pending assistant bubble (e.g. interrupt auto-message, sub-session
              // wake-up that arrived when loop was idle so no queued event fired).
              const userMsg: RichMessage = { id: nextId(), role: "user", content: data.content as string, reasoning: "", status: "done", _queue_id: qid }
              const pendingAsst: RichMessage = { id: nextId(), role: "assistant", content: "", reasoning: "", status: "pending", blocks: [] }
              window.__TEAHOUSE_LOG__?.("session_user_msg", `APPENDING userMsg.id=${userMsg.id} pendingAsst.id=${pendingAsst.id}`)
              setMessagesFor(sid, (prev) => [...prev, userMsg, pendingAsst])
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
        // The backend enqueued a user message into the in-memory queue.
        // It has NOT been persisted to jsonl yet (the tool_loop may still
        // be running).  Show a grey "waiting" bubble; it will be upgraded
        // to white "done" when session_user_msg fires later.
        try {
          const data = JSON.parse(e.data)
          if (instId && data.instance_id !== instId && data.instance_id !== instName) return
          const sid = data.session_id
          if (!sid) return
          window.__TEAHOUSE_LOG__?.("session_user_queued", `sid=${sid} active=${activeSidRef.current} qid=${data.queue_id}`)
          if (activeSidRef.current === sid && data.content) {
            const queuedMsg: RichMessage = {
              id: nextId(),
              role: "user",
              content: data.content as string,
              reasoning: "",
              status: "queued",
              _queue_id: data.queue_id as string,
            }
            setMessagesFor(sid, (prev) => [...prev, queuedMsg])
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
            window.__TEAHOUSE_LOG__?.("session_event", `type=${t} sid=${sid} ${t === "text" ? `text_len=${(data.text as string)?.length || 0}` : t === "tool_call" ? `name=${data.name}` : t === "tool_result" ? `name=${data.name} id=${data.id}` : ""}`)

            // Helper: find or create a pending assistant to stream into.
            // When the user switches back to a running session mid-stream,
            // the history loaded from jsonl only contains done records, so
            // we synthesise a fresh "生成中…" bubble for the in-flight round.
            const findOrCreatePending = (prev: RichMessage[]): { list: RichMessage[]; msg: RichMessage } => {
              const existing = [...prev].reverse().find((m) => m.role === "assistant" && m.status !== "done")
              if (existing) return { list: prev, msg: existing }
              const newMsg: RichMessage = { id: nextId(), role: "assistant", content: "", reasoning: "", status: "pending", blocks: [] }
              return { list: [...prev, newMsg], msg: newMsg }
            }

            if (t === "done") {
              // Stream finished. Close any open streaming assistant bubble.
              setMessagesFor(sid, (prev) => {
                const lastAsst = [...prev].reverse().find((m) => m.role === "assistant" && m.status !== "done")
                if (!lastAsst) return prev
                // Drop empty bubble
                if (!lastAsst.content && !lastAsst.reasoning && (!lastAsst.blocks || lastAsst.blocks.length === 0)) {
                  return prev.filter((m) => m.id !== lastAsst.id)
                }
                return updateMessage(prev, lastAsst.id, (m) => ({ ...m, status: "done" })) || prev
              })
              return
            }

            if (t === "assistant_done") {
              // Tool-round boundary: close current bubble, start a fresh one.
              setMessagesFor(sid, (prev) => {
                const closed = prev.map((m) =>
                  m.role === "assistant" && m.status !== "done"
                    ? { ...m, status: "done" as MsgStatus }
                    : m
                )
                const nextAssistant: RichMessage = { id: nextId(), role: "assistant", content: "", reasoning: "", status: "pending", blocks: [] }
                return [...closed, nextAssistant]
              })
              return
            }

            if (t === "tool_call") {
              setMessagesFor(sid, (prev) => {
                const { list, msg } = findOrCreatePending(prev)
                return updateMessage(list, msg.id, (m) => ({
                  ...m,
                  status: "streaming",
                  blocks: [
                    ...(m.blocks || []),
                    {
                      type: "tool_call" as const,
                      id: data.id as string,
                      name: data.name as string,
                      args: data.args as Record<string, unknown>,
                      ...(data._batch_meta ? { batch: data._batch_meta as { path: string; index: number; total: number } } : {}),
                    },
                  ],
                })) || prev
              })
              return
            }

            if (t === "tool_result") {
              setMessagesFor(sid, (prev) => {
                const { list, msg } = findOrCreatePending(prev)
                return updateMessage(list, msg.id, (m) => ({
                  ...m,
                  blocks: (m.blocks || []).map((b) =>
                    b.type === "tool_call" && b.id === data.id ? { ...b, result: data.result as string } : b
                  ),
                })) || prev
              })
              return
            }

            if (t === "approval_required") {
              if (autoApproveCommitRef.current) {
                const inst = getActiveInstance()
                if (inst) {
                  gitApi.approveTool(inst.id, data.id as string, data.args as Record<string, unknown>).then(res => {
                    if (res.ok) {
                      setMessagesFor(sid, (prev) => {
                        const { list, msg: target } = findOrCreatePending(prev)
                        return updateMessage(list, target.id, (m) => ({
                          ...m,
                          blocks: (m.blocks || []).map((b) =>
                            b.type === "tool_call" && b.id === data.id ? { ...b, result: "（自动批准）" } : b
                          ),
                        })) || prev
                      })
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
                setMessagesFor(sid, (prev) => {
                  const { list, msg } = findOrCreatePending(prev)
                  return updateMessage(list, msg.id, (m) => ({
                    ...m,
                    status: "reasoning",
                    reasoning: m.reasoning + chunkText,
                  })) || prev
                })
              } else if (chunkText) {
                setMessagesFor(sid, (prev) => {
                  const { list, msg } = findOrCreatePending(prev)
                  const blocks = [...(msg.blocks || [])]
                  const last = blocks[blocks.length - 1]
                  if (last && last.type === "text") {
                    blocks[blocks.length - 1] = { ...last, text: (last.text || "") + chunkText }
                  } else {
                    blocks.push({ type: "text", text: chunkText })
                  }
                  return updateMessage(list, msg.id, (m) => ({
                    ...m,
                    blocks,
                    content: m.content + chunkText,
                    status: "streaming",
                  })) || prev
                })
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

  // Convert a backend session record (or an in-flight local message) into the
  // RichMessage shape the renderer uses.
  function recordToRichMessage(rec: { role: string; content?: string; blocks?: ContentBlock[]; reasoning?: string }): RichMessage {
    return {
      id: nextId(),
      role: rec.role === "user" ? "user" : "assistant",
      content: rec.content || "",
      reasoning: rec.reasoning || "",
      status: "done",
      blocks: rec.blocks || undefined,
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
        // SSE events may have already appended an in-flight pending assistant
        // to the cache slot while the http fetch was in flight.  Preserve it
        // so the "生成中…" bubble and streamed chunks aren't wiped.
        const tail = messagesBySidRef.current[targetSid] || []
        const sseOnly = tail.filter(m => m.role === "assistant" && m.status !== "done")
        const merged = sseOnly.length > 0 ? [...first, ...sseOnly] : first
        messagesBySidRef.current[targetSid] = merged
        setMessages(merged)
        historyCursorRef.current = first.length
        historyLoadedRef.current = first.length >= total
      } else if (recs.length > 0) {
        const more = recs.map(r => recordToRichMessage(r as any))
        const merged = [...more, ...(messagesBySidRef.current[targetSid] || [])]
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
  }, [activeSid, messages, loadHistory, clearSessionNew, refreshSessionsStatus])

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

  // Available commands for autocomplete
  const COMMANDS = [{ name: "/clear", description: "清空当前对话" }]

  // Compute filtered commands
  const filteredCommands = input.startsWith("/")
    ? COMMANDS.filter((c) => c.name.startsWith(input))
    : []

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
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return
      if (!isStreaming && !isWaiting) return
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
    window.__TEAHOUSE_LOG__?.("_doSend", `sid=${sid} useTools=${useTools} text=${JSON.stringify(text.slice(0, 80))}`)

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
      toast.success("会话已清空")
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
        // Writer path (non-tools): still uses direct SSE streaming.
        const userMsg: RichMessage = { id: nextId(), role: "user", content: text, reasoning: "", status: "done" }
        const pendingAssistant: RichMessage = { id: nextId(), role: "assistant", content: "", reasoning: "", status: "pending", blocks: [] }
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
        setInput(filteredCommands[commandIndex].name + " ")
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
      <DiagnosticPanel
        open={showDiag}
        onClose={() => setShowDiag(false)}
        entries={diag.entries}
        enabled={diag.enabled}
        onEnable={diag.enable}
        onDisable={diag.disable}
        onClear={diag.clear}
        onCopy={diag.copy}
      />
      {/* Header */}
      <ChatHeader
        showDiag={showDiag}
        onToggleDiag={() => setShowDiag(v => !v)}
        diagEnabled={diag.enabled}
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
                <div key={msg.id} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                  {msg.role === "assistant" ? (
                    <AssistantBubble
                      message={msg}
                      isLatest={msg.id === lastAssistantId}
                      isGlobalGenerating={isGlobalGenerating}
                      isIdle={isIdle}
                    />
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
        filteredCommands={filteredCommands}
        commandIndex={commandIndex}
        onCommandHover={setCommandIndex}
        onCommandSelect={(name) => {
          setInput(name + " ")
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
              （共 {floorsStats.total_floors} 层{floorsStats.unsummarized > 0 && <span>，{floorsStats.unsummarized} 层未总结</span>}）
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
