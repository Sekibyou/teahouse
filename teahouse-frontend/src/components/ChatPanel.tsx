import { useState, useRef, useEffect, useCallback, memo } from "react"
import { Send, Square, Loader2, ChevronDown, ChevronRight, Brain, Terminal, CheckCircle2, XCircle, Circle, CircleDot, CheckCheck, GitBranch as GitBranchIcon, Edit3, Maximize2, Minimize2, Puzzle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { chatApi, llmSlotsApi, llmModelsApi, instancesApi, gitApi, pluginsApi, API_BASE_URL } from "@/lib/api"
import { getActiveInstance, useSessionStore } from "@/stores/sessionStore"
import { useGenerationStore } from "@/stores/generationStore"
import { useGitStore } from "@/stores/gitStore"
import { useSettingsDialogStore } from "@/stores/settingsDialogStore"
import type { FloorsStats } from "@/lib/types"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { toast } from "sonner"
import { GitDialog } from "@/components/GitDialog"

type MsgStatus = "pending" | "reasoning" | "streaming" | "done" | "queued"

interface ContentBlock {
  type: "text" | "tool_call"
  text?: string                // type=text 时的文字片段
  id?: string                  // type=tool_call 时的 call id
  name?: string                // type=tool_call 时的工具名
  args?: Record<string, unknown>
  result?: string
  /** BatchExecute 展开显示元数据：{path, index, total}（仅用于标注，不进 LLM） */
  batch?: { path: string; index: number; total: number }
}

interface RichMessage {
  id: string
  role: "user" | "assistant"
  content: string              // 完整文字内容（向后兼容）
  reasoning: string
  status: MsgStatus
  /** 交错的内容块：text + tool_call 按生成顺序排列 */
  blocks?: ContentBlock[]
}

let msgIdCounter = 0
function nextId() {
  return `msg-${++msgIdCounter}`
}

/**
 * 合并连续相同 role 的消息为单条（用换行分隔）。
 * Anthropic API 会在服务端自动合并；OpenAI 原生不强制交替；
 * 但严格第三方提供商（Kimi、Qwen 等）要求严格交替，合并后满足所有 API。
 */
function mergeConsecutiveSameRole(msgs: RichMessage[]): RichMessage[] {
  const result: RichMessage[] = []
  for (const m of msgs) {
    const last = result[result.length - 1]
    const lastHasBlocks = last?.blocks && last.blocks.length > 0
    const curHasBlocks = m.blocks && m.blocks.length > 0
    if (last && last.role === m.role && !lastHasBlocks && !curHasBlocks) {
      last.content = last.content ? last.content + "\n" + m.content : m.content
    } else {
      result.push({ ...m })
    }
  }
  return result
}

/**
 * 更新单条消息：只替换目标索引那条（保持其它引用不变），
 * 配合 AssistantBubble 的 memo 让无关消息跳过重渲染。
 */
function updateMessage(
  prev: RichMessage[],
  id: string,
  updater: (m: RichMessage) => RichMessage
): RichMessage[] | null {
  const idx = prev.findIndex((m) => m.id === id)
  if (idx === -1) return null
  const target = prev[idx]
  const nextMsg = updater(target)
  if (nextMsg === target) return null
  const next = prev.slice()
  next[idx] = nextMsg
  return next
}

export function ChatPanel({ onGitRefresh }: { onGitRefresh?: () => void }) {
  const [messages, setMessages] = useState<RichMessage[]>([])

  // 每个实例独立的 localStorage key
  const activeInst = useSessionStore((s) => s.activeInstance)
  const instId = activeInst?.id
  const instName = activeInst?.name
  const chatKey = instId ? `chat-messages-${instId}` : null

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

      es.onerror = () => {
        es.close()
        floorsESRef.current = null
        if (!stopped) setTimeout(connect, 3000)
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

  const loadHistory = useCallback((replace: boolean) => {
    if (!instId || loadingMoreRef.current) return
    loadingMoreRef.current = true
    const offset = replace ? 0 : (historyCursorRef.current ?? 0)
    instancesApi.getSessionMemory(instId, { limit: PAGE_SIZE, offset }).then(res => {
      if (!res.ok) return
      const recs = res.data?.records || []
      const total = res.data?.total ?? 0
      if (replace) {
        const first = recs.map(r => recordToRichMessage(r as any))
        setMessages(first)
        historyCursorRef.current = first.length
        historyLoadedRef.current = first.length >= total
      } else if (recs.length > 0) {
        const more = recs.map(r => recordToRichMessage(r as any))
        setMessages(prev => [...more, ...prev])
        historyCursorRef.current = (historyCursorRef.current ?? 0) + more.length
        if (more.length < PAGE_SIZE || (historyCursorRef.current ?? 0) >= total) {
          historyLoadedRef.current = true
        }
      } else {
        historyLoadedRef.current = true
      }
    }).catch(() => {}).finally(() => { loadingMoreRef.current = false })
  }, [instId])

  // Initial load (on mount / instance change): replace with the latest window.
  useEffect(() => {
    setMessages([])
    historyCursorRef.current = null
    historyLoadedRef.current = false
    loadHistory(true)
  }, [instId, loadHistory])

  // Lazy-load earlier history when the user scrolls near the top.
  const handleHistoryScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget
    if (el.scrollTop < 60 && !historyLoadedRef.current && !loadingMoreRef.current) {
      loadHistory(false)
    }
  }, [loadHistory])

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
  const aborterRef = useRef<AbortController | null>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const [commandIndex, setCommandIndex] = useState(0)

  // 全局生成状态（单数据源）
  const genPhase = useGenerationStore((s) => s.phase)
  const genApprovalData = useGenerationStore((s) => s.approvalData)
  const isStreaming = genPhase === "generating"
  const pendingApproval = genPhase === "waiting_approval" ? genApprovalData : null

  // 供 AssistantBubble 使用：全局布尔稳定，时钟/token 高频抖动但只传给最新活跃气泡
  const isGlobalGenerating = genPhase === "generating"
  const isIdle = genPhase === "idle"
  const elapsed = useGenerationStore((s) => s.elapsed)
  const tokenCount = useGenerationStore((s) => s.tokenCount)

  // Refresh git + drain queued messages when generation ends
  const prevGenPhaseRef = useRef(genPhase)
  const messagesRef = useRef(messages)
  messagesRef.current = messages
  useEffect(() => {
    const prev = prevGenPhaseRef.current
    prevGenPhaseRef.current = genPhase
    if ((prev === "generating" || prev === "waiting_approval") && genPhase === "idle") {
      if (instId) {
        useGitStore.getState().fetchGitStatus(instId)
      }
      // 消费排队消息：生成结束后如果有排队消息，自动发起新请求
      const hasQueued = messagesRef.current.some(m => m.role === "user" && m.status === "queued")
      if (hasQueued) {
        _doSend("", true)
      }
    }
  }, [genPhase, instId])

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

  // 生成计时器：每秒 tick
  useEffect(() => {
    if (!isStreaming) return
    const timer = setInterval(() => {
      useGenerationStore.getState().tickElapsed()
    }, 250)
    return () => clearInterval(timer)
  }, [isStreaming])

  const handleStop = useCallback(() => {
    aborterRef.current?.abort()
    useGenerationStore.getState().abort("user_interrupted")
    // 不在这里清空排队消息——_doSend 的 setTimeout 检查会消费它们
  }, [])

  // 当 phase 变为 idle 时，将所有未收到结果的 tool_call block 标记为"(interrupted)"
  // 同时将该 assistant 消息的 status 标记为 done，防止下一轮被当作中断上下文重复注入
  useEffect(() => {
    if (genPhase === "idle") {
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
  }, [genPhase])

  // ESC 快捷键：停止生成
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return
      const phase = useGenerationStore.getState().phase
      if (phase !== "generating") return
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
  const _doSend = async (text: string, useTools: boolean) => {

    // /clear 命令：清空当前对话
    if (text === "/clear") {
      setMessages([])
      setInput("")
      historyCursorRef.current = null
      historyLoadedRef.current = true
      // 清空后端实例目录里的持久化会话记忆（.sessions/）
      const inst = getActiveInstance()
      if (inst) {
        instancesApi.clearSessionMemory(inst.id).catch(() => {})
      }
      toast.success("会话已清空")
      scrollToBottom()
      return
    }

    // 消费排队消息：读取当前 messages，将 queued → done，构建 sendMessages
    const currentMessages = messages
    const queuedMsgs = currentMessages.filter(m => m.role === "user" && m.status === "queued")
    const hasQueued = queuedMsgs.length > 0

    // 没有排队消息且 text 为空 → 无需发送
    if (!hasQueued && !text.trim()) return

    // 构建发送用的消息数组（queued → done）
    const sendMessages: RichMessage[] = currentMessages.map(m =>
      (m.role === "user" && m.status === "queued") ? { ...m, status: "done" as MsgStatus } : m
    )

    // 如果有排队消息，它们作为 user 输入（不再新建 userMsg）
    // 如果没有排队消息，用 text 参数新建 userMsg
    const userMsg: RichMessage | null = hasQueued
      ? null
      : { id: nextId(), role: "user", content: text, reasoning: "", status: "done" }
    // `let` so the SSE loop can close this turn and open a fresh assistant bubble
    // when the backend signals a tool-round boundary (assistant_done).
    let assistantMsg: RichMessage = { id: nextId(), role: "assistant", content: "", reasoning: "", status: "pending", blocks: [] }

    // 中断上下文注入：找到最后一条未完成的 assistant，在其后插入 [system] 消息
    const lastAssistantIndex = (() => {
      for (let i = sendMessages.length - 1; i >= 0; i--) {
        if (sendMessages[i].role === "assistant" && sendMessages[i].status !== "done") return i
      }
      return -1
    })()
    if (lastAssistantIndex !== -1) {
      const reason = useGenerationStore.getState().consumeAbortReason()
      if (reason === "user_interrupted") {
        sendMessages.splice(lastAssistantIndex + 1, 0, { id: nextId(), role: "user", content: "[system] user interrupted", reasoning: "", status: "done" } as RichMessage)
      }
    }
    if (userMsg) sendMessages.push(userMsg)
    sendMessages.push(assistantMsg)

    // 合并连续相同 role 的消息（兼容 Anthropic / 严格 OpenAI 提供商）
    const mergedMessages = mergeConsecutiveSameRole(sendMessages)

    setMessages(mergedMessages)
    setInput("")
    setError("")
    useGenerationStore.getState().startGenerating()
    scrollToBottom()

    const abortController = new AbortController()
    aborterRef.current = abortController

    try {
      const activeInst = getActiveInstance()
      const shouldUseTools = useTools && activeInst !== null

      // Phase 2: the backend owns conversation memory (.sessions/). For the
      // director (tools path) we send only this round's new input; the backend
      // rebuilds full context from its own session store. The non-tools writer
      // path still sends the assembled history (its context isn't session-based).
      let apiMessages: Record<string, unknown>[] = []
      if (shouldUseTools) {
        const queuedUserMsgs = currentMessages.filter(m => m.role === "user" && m.status === "queued")
        const pendingContent = hasQueued
          ? (queuedUserMsgs[queuedUserMsgs.length - 1]?.content || text)
          : text
        apiMessages = pendingContent ? [{ role: "user", content: pendingContent }] : []
      } else {
        apiMessages = mergedMessages.map((m) => {
          const msg: Record<string, unknown> = { role: m.role, content: m.content || "" }
          if (m.blocks && m.blocks.length > 0) {
            msg.blocks = m.blocks
          }
          if (m.reasoning) {
            msg.reasoning = m.reasoning
          }
          return msg
        })
      }

      let stream: ReadableStream<Uint8Array>
      if (shouldUseTools) {
        stream = await chatApi.sendToolStream(
          apiMessages,
          activeInst!.id,
          abortController.signal,
        )
      } else {
        stream = await chatApi.sendStream(
          apiMessages,
          abortController.signal,
          "writer",
        )
      }

      const reader = stream.getReader()
      const decoder = new TextDecoder()
      let buffer = ""
      let currentType: string | null = null

      const processLine = async (line: string) => {
        if (line.startsWith("event: ")) {
          currentType = line.slice(7).trim()
          return
        }
        if (line.startsWith("data: ")) {
          const dataStr = line.slice(6).trim()
          if (!dataStr) return

          if (currentType === "done") {
            setMessages((prev) => {
              const target = prev.find((m) => m.id === assistantMsg.id)
              // A bubble opened by assistant_done but that never received any
              // content/reasoning is a spurious empty turn (e.g. the last tool
              // round had no trailing text). Drop it instead of leaving an empty bubble.
              if (target && target.status !== "done" && !target.content && !target.reasoning && (!target.blocks || target.blocks.length === 0)) {
                return prev.filter((m) => m.id !== assistantMsg.id)
              }
              return (
                updateMessage(prev, assistantMsg.id, (m) =>
                  m.status === "done" ? m : { ...m, status: "done" }
                ) || prev
              )
            })
            return
          }

          try {
            const data = JSON.parse(dataStr)

            if (currentType === "assistant_done") {
              // Tool-round boundary: close the current bubble as a completed turn
              // and start a fresh assistant message. Mirrors how the same data is
              // replayed from .sessions/ (one record per tool round), so realtime
              // and refresh render the chain-of-thought spread across turns.
              setMessages((prev) => {
                const closed = prev.map((m) =>
                  m.id === assistantMsg.id && m.status !== "done"
                    ? { ...m, status: "done" as MsgStatus }
                    : m
                )
                const nextAssistant: RichMessage = { id: nextId(), role: "assistant", content: "", reasoning: "", status: "pending", blocks: [] }
                assistantMsg = nextAssistant
                return [...closed, nextAssistant]
              })
              return
            }

            if (currentType === "tool_call") {
              // 首次事件：从"等待中"切换到活跃
              setMessages((prev) =>
                updateMessage(prev, assistantMsg.id, (m) =>
                  m.status === "pending" ? { ...m, status: "streaming" } : m
                ) || prev
              )
              // 估算 token 数
              useGenerationStore.getState().addTokens(
                Math.ceil((data.name + JSON.stringify(data.args || {})).length / 4)
              )
              // 追加 tool_call block
              setMessages((prev) =>
                updateMessage(prev, assistantMsg.id, (m) => ({
                  ...m,
                  blocks: [
                    ...(m.blocks || []),
                    {
                      type: "tool_call" as const,
                      id: data.id,
                      name: data.name,
                      args: data.args,
                      ...(data._batch_meta ? { batch: data._batch_meta } : {}),
                    },
                  ],
                })) || prev
              )
              return
            }

            if (currentType === "tool_result") {
              // 估算 tool result 的 token 数
              useGenerationStore.getState().addTokens(
                Math.ceil((data.result || "").length / 4)
              )
              // 更新对应 tool_call block 的 result
              setMessages((prev) =>
                updateMessage(prev, assistantMsg.id, (m) => ({
                  ...m,
                  blocks: (m.blocks || []).map((b) =>
                    b.type === "tool_call" && b.id === data.id ? { ...b, result: data.result } : b
                  ),
                })) || prev
              )
              return
            }

            if (currentType === "approval_required") {
              if (autoApproveCommitRef.current) {
                const inst = getActiveInstance()
                if (inst) {
                  try {
                    const res = await gitApi.approveTool(inst.id, data.id, data.args)
                    if (res.ok) {
                      // 标记对应 block result
                      setMessages((prev) =>
                        updateMessage(prev, assistantMsg.id, (m) => ({
                          ...m,
                          blocks: (m.blocks || []).map((b) =>
                            b.type === "tool_call" && b.id === data.id
                              ? { ...b, result: "（自动批准）" }
                              : b
                          ),
                        })) || prev
                      )
                      return
                    }
                  } catch { /* network error — fall through to manual approval */ }
                }
                // Auto-approve failed — fall through to manual approval
                toast.error("自动提交失败，请手动确认")
              }
              useGenerationStore.getState().waitForApproval({
                id: data.id,
                name: data.name,
                args: data.args,
              })
              return
            }

            const chunkText = data.text || ""
            // Empty chunk or tool_args (hidden): transition off "pending" + count tokens
            if (!chunkText || data.tool_args) {
              if (chunkText) {
                useGenerationStore.getState().addTokens(Math.ceil(chunkText.length / 4))
              }
              setMessages((prev) =>
                updateMessage(prev, assistantMsg.id, (m) =>
                  m.status === "pending" ? { ...m, status: "streaming" } : m
                ) || prev
              )
              if (data.tool_args) return
              if (!chunkText) return
            }

            if (data.type === "reasoning") {
              setMessages((prev) =>
                updateMessage(prev, assistantMsg.id, (m) => ({
                  ...m,
                  status: "reasoning",
                  reasoning: m.reasoning + chunkText,
                })) || prev
              )
            } else {
              useGenerationStore.getState().addTokens(Math.ceil(chunkText.length / 4))
              setMessages((prev) => {
                const target = prev.find((m) => m.id === assistantMsg.id)
                if (!target) return prev
                const blocks = [...(target.blocks || [])]
                // 如果最后一块是 text，追加到它；否则新建 text block
                const last = blocks[blocks.length - 1]
                if (last && last.type === "text") {
                  blocks[blocks.length - 1] = { ...last, text: (last.text || "") + chunkText }
                } else {
                  blocks.push({ type: "text", text: chunkText })
                }
                return updateMessage(prev, assistantMsg.id, (m) => ({
                  ...m,
                  blocks,
                  content: m.content + chunkText,
                  status: "streaming",
                })) || prev
              })
            }
          } catch {
            // skip malformed JSON
          }
        }
      }

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split("\n")
        buffer = lines.pop() || ""
        for (const line of lines) {
          await processLine(line)
        }
      }
      // Process remaining buffer
      if (buffer.trim()) {
        for (const line of buffer.split("\n")) {
          await processLine(line)
        }
      }

      // Mark done
      setMessages((prev) =>
        updateMessage(prev, assistantMsg.id, (m) =>
          m.status !== "done" ? { ...m, status: "done" } : m
        ) || prev
      )
    } catch (err) {
      // Ignore abort errors (user clicked stop)
      if (err instanceof DOMException && err.name === "AbortError") {
        return
      }
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantMsg.id
            ? { ...m, status: "done" as MsgStatus }
            : m
        )
      )
      setError(err instanceof Error ? err.message : "请求失败")
    } finally {
      useGenerationStore.getState().finishGenerating()
      aborterRef.current = null
    }
  }

  // 监听沙盒 Teahouse.send() 消息，自动发送到导演
  useEffect(() => {
    const interval = setInterval(() => {
      const msg = useSessionStore.getState().pendingMessage
      if (msg && !isStreaming) {
        useSessionStore.getState().setPendingMessage(null)
        setInput(msg)
        // 同步触发发送
        _doSend(msg, true)
      }
    }, 300)
    return () => clearInterval(interval)
  }, [isStreaming])

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
      if (isStreaming && input.trim()) {
        // 生成期间：排队消息，灰色气泡显示，等生成结束后自动发送
        const userMsg: RichMessage = { id: nextId(), role: "user", content: input.trim(), reasoning: "", status: "queued" }
        setMessages(prev => [...prev, userMsg])
        setInput("")
        setExpandedInput(false)
        scrollToBottom()
      } else {
        handleSend()
      }
    }
  }

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="p-3 border-b border-border shrink-0 space-y-2">
        {/* Row 1: 导演 + enabled plugin count + model names */}
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">导演</h3>
          <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
            <button
              className="flex items-center gap-1 hover:text-foreground transition-colors"
              onClick={() => openSettings("plugins")}
              title="打开设置→插件管理"
            >
              <Puzzle className="h-3 w-3" />
              <span className="text-foreground font-medium">{enabledPluginCount}</span>
            </button>
            <button
              className="flex items-center gap-1 hover:text-foreground transition-colors"
              onClick={() => openSettings("slots")}
              title="打开设置→槽位指定"
            >
              导演：<span className="text-foreground font-medium">{slotModels.director || "未设置"}</span>
            </button>
            <button
              className="flex items-center gap-1 hover:text-foreground transition-colors"
              onClick={() => openSettings("slots")}
              title="打开设置→槽位指定"
            >
              正文：<span className="text-foreground font-medium">{slotModels.writer || "未设置"}</span>
            </button>
          </div>
        </div>
        {/* Row 2: git info + auto-commit switch */}
        <div className="flex items-center justify-between">
          <div
            className="flex items-center gap-1.5 cursor-pointer hover:bg-muted/50 rounded px-1.5 py-0.5 -ml-1.5 transition-colors flex-1 min-w-0 mr-4"
            onClick={() => setShowGitDialog(true)}
            title="打开版本控制"
          >
            <GitBranchIcon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <span className="text-[10px] font-mono bg-muted px-1.5 py-0.5 rounded text-muted-foreground shrink-0">
              {currentBranch}
            </span>
            {latestCommitMsg && (
              <span className="text-[10px] text-muted-foreground truncate">
                {latestCommitMsg.length > 30 ? latestCommitMsg.slice(0, 30) + "…" : latestCommitMsg}
              </span>
            )}
            {changeCounts.deleted > 0 && (
              <span className="text-[9px] bg-red-500/15 text-red-600 dark:text-red-400 font-medium px-1 py-0.5 rounded leading-none shrink-0">
                -{changeCounts.deleted}
              </span>
            )}
            {changeCounts.modified > 0 && (
              <span className="text-[9px] bg-yellow-500/15 text-yellow-600 dark:text-yellow-400 font-medium px-1 py-0.5 rounded leading-none shrink-0">
                ~{changeCounts.modified}
              </span>
            )}
            {changeCounts.added > 0 && (
              <span className="text-[9px] bg-green-500/15 text-green-600 dark:text-green-400 font-medium px-1 py-0.5 rounded leading-none shrink-0">
                +{changeCounts.added}
              </span>
            )}
            <Edit3 className="h-3 w-3 text-muted-foreground shrink-0" />
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <span className="text-[10px] text-muted-foreground">自动提交</span>
            <Switch
              checked={autoApproveCommit}
              onCheckedChange={(checked) => {
                setAutoApproveCommit(checked)
                localStorage.setItem("teahouse_auto_approve_commit", String(checked))
              }}
            />
            <span className="text-[10px] text-muted-foreground w-5 text-right">
              {autoApproveCommit ? "ON" : "OFF"}
            </span>
          </div>
        </div>
      </div>

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
          return messages.map((msg) => (
          <div key={msg.id} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
            {msg.role === "assistant" ? (
              <AssistantBubble
                message={msg}
                isLatest={msg.id === lastAssistantId}
                isGlobalGenerating={isGlobalGenerating}
                isIdle={isIdle}
                // 时钟/token 只传给最新气泡：其它气泡靠 memo 跳过重渲染，
                // 即使已订阅的 elapsed/tokenCount 每秒在变也不牵连它们。
                elapsed={msg.id === lastAssistantId ? elapsed : 0}
                tokenCount={msg.id === lastAssistantId ? tokenCount : 0}
              />
            ) : msg.status === "queued" ? (
              <div className="max-w-[85%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap break-words bg-muted/50 text-muted-foreground border border-dashed border-border">
                {msg.content}
              </div>
            ) : (
              <div className="max-w-[85%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap break-words bg-primary text-primary-foreground">
                {msg.content}
              </div>
            )}
          </div>
        ))
        })()}

        {error && (
          <div className="text-center">
            <p className="text-xs text-red-500">{error}</p>
          </div>
        )}
      </div>

      {/* Input */}
      <div className={`border-t border-border relative ${expandedInput ? "flex-[0.8] min-h-0 flex flex-col p-3" : "shrink-0 p-3"}`}>
        {filteredCommands.length > 0 && (
          <div className="absolute bottom-full left-3 right-3 mb-1 rounded-md border border-border bg-popover shadow-lg overflow-hidden">
            {filteredCommands.map((cmd, i) => (
              <button
                key={cmd.name}
                className={`w-full px-3 py-1.5 text-left text-sm flex items-center gap-2 transition-colors ${
                  i === commandIndex ? "bg-accent text-accent-foreground" : "text-popover-foreground"
                }`}
                onMouseEnter={() => setCommandIndex(i)}
                onMouseDown={(e) => {
                  e.preventDefault()
                  setInput(cmd.name + " ")
                  setCommandIndex(0)
                  inputRef.current?.focus()
                }}
              >
                <span className="font-mono text-primary">{cmd.name}</span>
                <span className="text-xs text-muted-foreground">{cmd.description}</span>
              </button>
            ))}
          </div>
        )}
        {pendingApproval ? (
          <div className="rounded-lg border border-purple-500/30 bg-purple-500/5 p-3 space-y-2">
            <div className="flex items-center justify-between">
              <h4 className="text-sm font-semibold flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 text-purple-500" />
                确认 Git 提交
              </h4>
            </div>
            <p className="text-xs text-muted-foreground">
              <span className="font-mono text-foreground text-sm">{formatCommitPreview(pendingApproval.args)}</span>
            </p>
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={approving}
                onClick={async () => {
                  const data = pendingApproval
                  setApproving(true)
                  const inst = getActiveInstance()
                  if (!inst) { setApproving(false); return }
                  const res = await gitApi.rejectTool(inst.id, data.id, "")
                  setApproving(false)
                  if (!res.ok) {
                    toast.error("拒绝请求失败")
                    return
                  }
                  useGenerationStore.getState().resolveApproval(false)
                }}
              >
                拒绝
              </Button>
              <Button
                variant="default"
                size="sm"
                disabled={approving}
                onClick={async () => {
                  const data = pendingApproval
                  setApproving(true)
                  const inst = getActiveInstance()
                  if (!inst) { setApproving(false); return }
                  const res = await gitApi.approveTool(inst.id, data.id, data.args)
                  setApproving(false)
                  if (!res.ok) {
                    toast.error("批准提交失败")
                    return
                  }
                  useGenerationStore.getState().resolveApproval(true)
                }}
              >
                {approving ? "提交中..." : "确认提交"}
              </Button>
            </div>
          </div>
        ) : (
          <div className={`flex gap-2 ${expandedInput ? "flex-1 min-h-0" : "items-end"}`}>
            <Button
              size="icon"
              variant="ghost"
              className="shrink-0 self-end text-muted-foreground hover:text-foreground h-10 w-10"
              onClick={() => setExpandedInput(v => !v)}
              title={expandedInput ? "收起小输入框" : "展开大输入框（占高度 80%）"}
            >
              {expandedInput ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
            </Button>
            <textarea
              ref={inputRef}
              className={`flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring ${
                expandedInput
                  ? "min-h-0 resize-y"
                  : "resize-none min-h-[40px] max-h-[120px]"
              }`}
              rows={1}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={isStreaming ? "输入消息回车插入（不中断生成）..." : "输入消息... / 查看命令 (Enter 发送)"}
            />
            <Button
              size="icon"
              className="shrink-0 self-end h-10 w-10"
              onClick={isStreaming ? handleStop : handleSend}
              disabled={!isStreaming && !input.trim()}
              variant={isStreaming ? "destructive" : "default"}
              title={isStreaming ? "停止生成 (Esc)" : "发送 (Enter)"}
            >
            {isStreaming ? <Square className="h-4 w-4" /> : <Send className="h-4 w-4" />}
          </Button>
          </div>
        )}
      </div>

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

// ---- Assistant message bubble with thinking block ----
// memo + 自定义浅比较：消息对象引用不变或 isLatest 不变时跳过重渲染，
// 配合 updateMessage 只替换单条，让流式更新不再触发全列表重建。
const AssistantBubble = memo(function AssistantBubble({
  message,
  isLatest,
  isGlobalGenerating,
  isIdle,
  elapsed,
  tokenCount,
}: {
  message: RichMessage
  isLatest: boolean
  isGlobalGenerating: boolean
  isIdle: boolean
  elapsed: number
  tokenCount: number
}) {
  const [thinkingOpen, setThinkingOpen] = useState(false)

  const { status, reasoning, content, blocks } = message
  const hasBlocks = blocks && blocks.length > 0

  // 此消息是当前正在生成的最新 assistant（非 done 非 pending，全局 streaming，且是最后一个 assistant）
  const isActiveMessage = isLatest && status !== "done" && status !== "pending" && isGlobalGenerating

  return (
    <div className="max-w-[85%] space-y-1">
      {/* Pending: waiting — no events received yet */}
      {status === "pending" && isGlobalGenerating && (
        <div className="rounded-lg px-3 py-2 bg-muted text-sm text-muted-foreground flex items-center gap-2">
          <Loader2 className="h-3 w-3 animate-spin" />
          等待中...
        </div>
      )}

      {/* Thinking / reasoning block */}
      {(status === "reasoning" || (reasoning && status !== "pending")) && (
        <div className="rounded-lg border border-border bg-muted/30 overflow-hidden">
          <button
            className="flex items-center gap-1.5 w-full px-3 py-1.5 text-xs text-muted-foreground hover:bg-muted/50 transition-colors"
            onClick={() => setThinkingOpen(!thinkingOpen)}
          >
            {thinkingOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            <Brain className="h-3 w-3" />
            <span>思维链</span>
            {status === "reasoning" && (
              <span className="flex items-center gap-1 ml-auto">
                {isIdle || !isLatest ? (
                  <XCircle className="h-2.5 w-2.5 text-muted-foreground/50" />
                ) : (
                  <Loader2 className="h-2.5 w-2.5 animate-spin" />
                )}
                {isIdle || !isLatest ? "已中断" : "思考中..."}
              </span>
            )}
          </button>
          {thinkingOpen && reasoning && (
            <div className="px-3 py-2 text-xs text-muted-foreground whitespace-pre-wrap border-t border-border max-h-48 overflow-y-auto scrollbar-thin">
              {reasoning}
            </div>
          )}
        </div>
      )}

      {/* Blocks: text + tool_call interleaved in generation order */}
      {hasBlocks && (
        <>
          {blocks!.map((block, i) => {
            if (block.type === "text" && block.text) {
              return (
                <div key={`t-${i}`} className="rounded-lg px-3 py-2 bg-muted text-sm prose prose-sm dark:prose-invert prose-chat max-w-none break-words">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {block.text!}
                  </ReactMarkdown>
                </div>
              )
            }
            if (block.type === "tool_call") {
              return (
                <div key={`tc-${i}`} className="rounded-lg border border-border bg-muted/30 overflow-hidden">
                  <div className="px-3 py-2 text-xs space-y-1">
                    <div className="flex items-center gap-1.5 text-muted-foreground">
                      <Terminal className="h-3 w-3 shrink-0" />
                      <span className="font-mono font-medium text-foreground">{block.name}</span>
                      <span className="font-mono opacity-60 truncate">{formatBlockArgs(block)}</span>
                      {block.batch && (
                        <span className="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 font-mono text-[10px] text-primary">
                          BatchExecute {block.batch.index}/{block.batch.total}
                        </span>
                      )}
                    </div>
                    {block.result === "(interrupted)" ? (
                      <div className="flex items-start gap-1.5 text-muted-foreground/50">
                        <XCircle className="h-3 w-3 mt-0.5 shrink-0" />
                        <span>已中断</span>
                      </div>
                    ) : block.result !== undefined ? (
                      <div className="mt-1">
                        {block.name === "TodoWrite" ? (
                          <TodoWriteResult args={block.args || {}} result={block.result} />
                        ) : block.result.startsWith("Error") ? (
                          <div className="flex items-start gap-1.5 text-red-500">
                            <XCircle className="h-3 w-3 mt-0.5 shrink-0" />
                            <span className="font-mono whitespace-pre-wrap">{block.result}</span>
                          </div>
                        ) : (
                          <div className="flex items-start gap-1.5 text-muted-foreground">
                            <CheckCircle2 className="h-3 w-3 mt-0.5 shrink-0 text-green-500" />
                            <span className="font-mono whitespace-pre-wrap line-clamp-3">{block.result}</span>
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="flex items-center gap-1.5 text-muted-foreground">
                        {isIdle || !isLatest ? (
                          <>
                            <XCircle className="h-3 w-3 text-muted-foreground/50" />
                            <span>已中断</span>
                          </>
                        ) : (
                          <>
                            <Loader2 className="h-3 w-3 animate-spin" />
                            <span>等待中...</span>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )
            }
            return null
          })}
        </>
      )}

      {/* Active generating indicator — at end of current assistant bubble */}
      {isActiveMessage && (
        <div className="rounded-lg px-3 py-2 bg-muted text-sm text-muted-foreground flex items-center gap-2">
          <Loader2 className="h-3 w-3 animate-spin" />
          <span>生成中...</span>
          <span className="text-[10px] text-muted-foreground/60">
            {elapsed > 0 && `${elapsed}s`}
            {tokenCount > 0 && `, ${tokenCount >= 1000 ? (tokenCount / 1000).toFixed(1) + "k" : tokenCount} tokens`}
          </span>
          <span className="inline-block w-2 h-4 bg-foreground/50 animate-pulse" />
        </div>
      )}
    </div>
  )
}, (prevProps, nextProps) =>
  prevProps.message === nextProps.message &&
  prevProps.isLatest === nextProps.isLatest &&
  prevProps.isGlobalGenerating === nextProps.isGlobalGenerating &&
  prevProps.isIdle === nextProps.isIdle
)

function formatCommitPreview(args: Record<string, unknown>): string {
  const type = args.type as string
  const msg = args.message as string
  if (type === "floor") return `[楼层] 第 ${args.number} 层：${msg}`
  if (type === "summary") {
    if (args.start === args.end) return `[总结] 第 ${args.start} 层：${msg}`
    return `[总结] 第 ${args.start}~${args.end} 层：${msg}`
  }
  return `[其他] ${msg}`
}

/** Format tool call args for compact display */
function formatBlockArgs(block: { args?: Record<string, unknown>; name?: string }): string {
  const args = block.args || {}
  const name = block.name || ""
  if (name === "Read") return args.path as string
  if (name === "Write") return args.path as string
  if (name === "Edit") return args.path as string
  if (name === "WriteLine") return args.path as string
  if (name === "Glob") return args.pattern as string
  if (name === "TodoWrite") {
    const todos = (args.todos as Array<{ status: string }>) || []
    if (todos.length === 0) return "（空清单）"
    const done = todos.filter((t) => t.status === "completed").length
    const active = todos.find((t) => t.status === "in_progress")
    const parts = [`${todos.length} 项`]
    if (done > 0) parts.push(`${done} 项已完成`)
    if (active) parts.push(`进行中: ${(active as { activeForm: string }).activeForm}`)
    return parts.join("，")
  }
  return JSON.stringify(args)
}

/** Render a TodoWrite result as a visual task list */
function TodoWriteResult({ args, result }: { args: Record<string, unknown>; result: string }) {
  if (result.startsWith("Error")) {
    return (
      <div className="flex items-start gap-1.5 text-red-500">
        <XCircle className="h-3 w-3 mt-0.5 shrink-0" />
        <span className="font-mono whitespace-pre-wrap">{result}</span>
      </div>
    )
  }
  const todos = (args.todos as Array<{ content: string; status: string }>) || []
  if (todos.length === 0) {
    return (
      <div className="flex items-start gap-1.5 text-green-600 dark:text-green-400">
        <CheckCircle2 className="h-3 w-3 mt-0.5 shrink-0" />
        <span className="font-mono whitespace-pre-wrap line-clamp-3">{result}</span>
      </div>
    )
  }
  return (
    <div>
      <div className="space-y-0.5">
        {todos.map((t, i) => {
          const icon =
            t.status === "completed" ? (
              <CheckCheck className="h-3 w-3 text-green-500 shrink-0 mt-0.5" />
            ) : t.status === "in_progress" ? (
              <CircleDot className="h-3 w-3 text-amber-500 shrink-0 mt-0.5" />
            ) : (
              <Circle className="h-3 w-3 text-muted-foreground/40 shrink-0 mt-0.5" />
            )
          return (
            <div
              key={i}
              className={`flex items-start gap-1.5 ${
                t.status === "completed"
                  ? "text-muted-foreground/50 line-through"
                  : t.status === "in_progress"
                    ? "text-foreground font-medium"
                    : "text-muted-foreground"
              }`}
            >
              {icon}
              <span>{t.content}</span>
            </div>
          )
        })}
      </div>
      <div className="mt-1.5 pt-1.5 border-t border-border/50 text-[10px] text-muted-foreground font-mono">
        {result}
      </div>
    </div>
  )
}
