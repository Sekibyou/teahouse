import { useState, useRef, useEffect, useCallback } from "react"
import { Send, Square, Loader2, ChevronDown, ChevronRight, Brain, Terminal, CheckCircle2, XCircle, ListTodo, Circle, CircleDot, CheckCheck } from "lucide-react"
import { Button } from "@/components/ui/button"
import { chatApi, gitApi, llmSlotsApi, llmModelsApi } from "@/lib/api"
import { getActiveInstance, useSessionStore } from "@/stores/sessionStore"
import { useGenerationStore } from "@/stores/generationStore"
import type { ChatMessage, SlotBindings, LLMModel } from "@/lib/types"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { toast } from "sonner"

type MsgStatus = "pending" | "reasoning" | "streaming" | "done"

interface ToolCallEvent {
  id: string
  name: string
  args: Record<string, unknown>
  result?: string
}

interface RichMessage {
  id: string
  role: "user" | "assistant"
  content: string
  reasoning: string
  status: MsgStatus
  toolCalls?: ToolCallEvent[]
}

let msgIdCounter = 0
function nextId() {
  return `msg-${++msgIdCounter}`
}

export function ChatPanel() {
  const [messages, setMessages] = useState<RichMessage[]>([])

  // Slot state — lightweight model info display
  const [slotModels, setSlotModels] = useState<Record<string, string | null>>({ director: null, writer: null })

  useEffect(() => {
    llmSlotsApi.getAll().then(res => {
      if (res.ok) {
        const slots = res.data!.slots
        // For each bound model, fetch its display name
        const modelIds = [slots.director, slots.writer].filter(Boolean) as string[]
        if (modelIds.length > 0) {
          llmModelsApi.list().then(mRes => {
            if (mRes.ok) {
              const modelMap = new Map(mRes.data!.models.map(m => [m.id, m.name]))
              setSlotModels({
                director: slots.director ? modelMap.get(slots.director) || slots.director : null,
                writer: slots.writer ? modelMap.get(slots.writer) || slots.writer : null,
              })
            }
          })
        }
      }
    })
  }, [messages.length > 0])  // reload on first message sent (hack: refresh when messages change from 0)

  // Restore messages from localStorage on mount
  useEffect(() => {
    try {
      const saved = localStorage.getItem("chat-messages")
      if (saved) {
        const parsed = JSON.parse(saved) as RichMessage[]
        if (Array.isArray(parsed) && parsed.length > 0) {
          setMessages(parsed)
          const maxId = parsed.reduce((max, m) => {
            const num = parseInt(m.id.replace("msg-", ""), 10)
            return num > max ? num : max
          }, 0)
          if (maxId > 0) msgIdCounter = maxId
        }
      }
    } catch {
      // localStorage 数据损坏则忽略
    }
  }, [])

  // Persist messages to localStorage on change
  useEffect(() => {
    try {
      localStorage.setItem("chat-messages", JSON.stringify(messages))
    } catch {
      // 序列化失败或存储满时忽略
    }
  }, [messages])
  const [input, setInput] = useState("")
  const [error, setError] = useState("")
  const [autoApproveCommit, setAutoApproveCommit] = useState(() => {
    const saved = localStorage.getItem("teahouse_auto_approve_commit")
    return saved === "true"
  })
  const scrollRef = useRef<HTMLDivElement>(null)
  const aborterRef = useRef<AbortController | null>(null)
  const latestToolCallsRef = useRef<ToolCallEvent[]>([])
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const [commandIndex, setCommandIndex] = useState(0)

  // 全局生成状态（单数据源）
  const genPhase = useGenerationStore((s) => s.phase)
  const genApprovalData = useGenerationStore((s) => s.approvalData)
  const isStreaming = genPhase === "generating"
  const pendingApproval = genPhase === "waiting_approval" ? genApprovalData : null

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

  // Auto-scroll when messages change
  useEffect(() => { scrollToBottom() }, [messages, scrollToBottom])

  const handleStop = useCallback(() => {
    aborterRef.current?.abort()
    useGenerationStore.getState().abort("user_interrupted")
  }, [])

  // 当 phase 变为 idle 时，将所有未收到结果的 tool call 标记为"(interrupted)"
  // 单向：只从"执行中"→"已中断"，不会因后续 phase 变化而恢复
  useEffect(() => {
    if (genPhase === "idle") {
      setMessages(prev => {
        let changed = false
        const next = prev.map(m => {
          if (m.role !== "assistant" || !m.toolCalls) return m
          const updatedCalls = m.toolCalls.map(tc => {
            if (tc.result === undefined) {
              changed = true
              return { ...tc, result: "(interrupted)" }
            }
            return tc
          })
          return changed ? { ...m, toolCalls: updatedCalls } : m
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

    _doSend(text, useTools)
  }

  // 核心发送逻辑（供 handleSend 和 sandbox 调用的共享函数）
  const _doSend = async (text: string, useTools: boolean) => {

    // /clear 命令：清空当前对话
    if (text === "/clear") {
      setMessages([])
      setInput("")
      try { localStorage.setItem("chat-messages", "[]") } catch {}
      toast.success("会话已清空")
      scrollToBottom()
      return
    }

    const userMsg: RichMessage = { id: nextId(), role: "user", content: text, reasoning: "", status: "done" }
    const assistantMsg: RichMessage = { id: nextId(), role: "assistant", content: "", reasoning: "", status: "pending", toolCalls: [] }

    // 中断上下文注入：如果上一条 assistant 未完成，插入 [system] 消息
    const lastMsg = messages[messages.length - 1]
    const sendMessages = [...messages]
    if (lastMsg && lastMsg.role === "assistant" && lastMsg.status !== "done") {
      const reason = useGenerationStore.getState().consumeAbortReason()
      if (reason === "user_interrupted") {
        sendMessages.push({ id: nextId(), role: "user", content: "[system] user interrupted", reasoning: "", status: "done" } as RichMessage)
      }
    }
    sendMessages.push(userMsg, assistantMsg)

    const newMessages = sendMessages
    setMessages(newMessages)
    setInput("")
    setError("")
    useGenerationStore.getState().startGenerating()
    latestToolCallsRef.current = []
    scrollToBottom()

    const abortController = new AbortController()
    aborterRef.current = abortController

    try {
      const activeInst = getActiveInstance()
      const shouldUseTools = useTools && activeInst !== null

      let stream: ReadableStream<Uint8Array>
      if (shouldUseTools) {
        stream = await chatApi.sendToolStream(
          newMessages.map((m) => ({ role: m.role, content: m.content || "" })),
          activeInst!.id,
          abortController.signal,
        )
      } else {
        stream = await chatApi.sendStream(
          newMessages.map((m) => ({ role: m.role, content: m.content || "" })),
          abortController.signal,
          "writer",  // Default non-tool chat to writer model
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
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantMsg.id ? { ...m, status: "done" as MsgStatus } : m
              )
            )
            return
          }

          try {
            const data = JSON.parse(dataStr)

            if (currentType === "tool_call") {
              const tc: ToolCallEvent = { id: data.id, name: data.name, args: data.args }
              latestToolCallsRef.current = [...latestToolCallsRef.current, tc]
              setMessages((prev) =>
                prev.map((m) => {
                  if (m.id !== assistantMsg.id) return m
                  const toolCalls = [...(m.toolCalls || []), tc]
                  return { ...m, toolCalls }
                })
              )
              scrollToBottom()
              return
            }

            if (currentType === "tool_result") {
              // Update tool call with result
              latestToolCallsRef.current = latestToolCallsRef.current.map((tc) =>
                tc.id === data.id ? { ...tc, result: data.result } : tc
              )
              setMessages((prev) =>
                prev.map((m) => {
                  if (m.id !== assistantMsg.id) return m
                  const toolCalls = (m.toolCalls || []).map((tc) =>
                    tc.id === data.id ? { ...tc, result: data.result } : tc
                  )
                  return { ...m, toolCalls }
                })
              )

              scrollToBottom()
              return
            }

            if (currentType === "approval_required") {
              if (autoApproveCommit) {
                // Auto-approve: send approve request immediately
                const inst = getActiveInstance()
                if (inst) {
                  try {
                    await gitApi.approveTool(inst.id, data.id, data.args)
                  } catch { /* ignore */ }
                }
                // Mark the tool call with auto-approved result so it shows in UI
                latestToolCallsRef.current = latestToolCallsRef.current.map((tc) =>
                  tc.id === data.id ? { ...tc, result: "（自动批准）" } : tc
                )
                setMessages((prev) =>
                  prev.map((m) => {
                    if (m.id !== assistantMsg.id) return m
                    const toolCalls = (m.toolCalls || []).map((tc) =>
                      tc.id === data.id ? { ...tc, result: "（自动批准）" } : tc
                    )
                    return { ...m, toolCalls }
                  })
                )
                scrollToBottom()
                return
              }
              useGenerationStore.getState().waitForApproval({
                id: data.id,
                name: data.name,
                args: data.args,
              })
              return
            }

            const chunkText = data.text || ""
            if (!chunkText) return

            if (data.type === "reasoning") {
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantMsg.id
                    ? { ...m, status: "reasoning" as MsgStatus, reasoning: m.reasoning + chunkText }
                    : m
                )
              )
            } else {
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantMsg.id
                    ? { ...m, status: "streaming" as MsgStatus, content: m.content + chunkText }
                    : m
                )
              )
            }
            scrollToBottom()
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
        prev.map((m) =>
          m.id === assistantMsg.id && m.status !== "done"
            ? { ...m, status: "done" as MsgStatus }
            : m
        )
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
        // 生成期间：直接插入用户消息，不中断当前执行
        const userMsg: RichMessage = { id: nextId(), role: "user", content: input.trim(), reasoning: "", status: "done" }
        setMessages(prev => [...prev, userMsg])
        setInput("")
        scrollToBottom()
      } else {
        handleSend()
      }
    }
  }

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="p-3 border-b border-border shrink-0">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">导演</h3>
          <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
            <label className="flex items-center gap-1 cursor-pointer" title="开启后 GitCommit 自动批准，不再弹窗确认">
              <input
                type="checkbox"
                checked={autoApproveCommit}
                onChange={e => {
                  setAutoApproveCommit(e.target.checked)
                  localStorage.setItem("teahouse_auto_approve_commit", String(e.target.checked))
                }}
                className="rounded border-border"
              />
              <span>自动提交</span>
            </label>
            <span className="flex items-center gap-1" title="导演/编排">导演：<span className="text-foreground font-medium">{slotModels.director || "未设置"}</span></span>
            <span className="flex items-center gap-1" title="正文写作">正文：<span className="text-foreground font-medium">{slotModels.writer || "未设置"}</span></span>
          </div>
        </div>
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-auto px-3 py-2 space-y-3">
        {messages.length === 0 && (
          <div className="text-center text-muted-foreground py-8">
            <p className="text-sm">发送消息开始对话</p>
          </div>
        )}

        {messages.map((msg) => (
          <div key={msg.id} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
            {msg.role === "assistant" ? (
              <AssistantBubble message={msg} />
            ) : (
              <div className="max-w-[85%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap break-words bg-primary text-primary-foreground">
                {msg.content}
              </div>
            )}
          </div>
        ))}

        {error && (
          <div className="text-center">
            <p className="text-xs text-red-500">{error}</p>
          </div>
        )}

        {/* GitCommit approval dialog — inline card in message area */}
        {pendingApproval && (
          <div className="rounded-lg border border-purple-500/30 bg-purple-500/5 p-4 space-y-3">
            <h4 className="text-sm font-semibold flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-purple-500" />
              确认 Git 提交
            </h4>
            <p className="text-xs text-muted-foreground">
              导演请求提交：<br />
              <span className="font-mono text-foreground text-sm">{formatCommitPreview(pendingApproval.args)}</span>
            </p>
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={async () => {
                  const data = pendingApproval
                  useGenerationStore.getState().resolveApproval(false)
                  const inst = getActiveInstance()
                  if (!inst) return
                  const res = await gitApi.rejectTool(inst.id, data.id, "")
                  if (!res.ok) toast.error("拒绝请求失败")
                }}
              >
                拒绝
              </Button>
              <Button
                variant="default"
                size="sm"
                onClick={async () => {
                  const data = pendingApproval
                  useGenerationStore.getState().resolveApproval(true)
                  const inst = getActiveInstance()
                  if (!inst) return
                  const res = await gitApi.approveTool(inst.id, data.id, data.args)
                  if (!res.ok) {
                    toast.error("批准提交失败")
                  }
                }}
              >
                确认提交
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Input */}
      <div className="p-3 border-t border-border shrink-0 relative">
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
        <div className="flex gap-2">
          <textarea
            ref={inputRef}
            className="flex-1 resize-none rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring min-h-[40px] max-h-[120px]"
            rows={1}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={pendingApproval ? "请先确认或拒绝提交请求..." : isStreaming ? "输入消息回车插入（不中断生成）..." : "输入消息... / 查看命令 (Enter 发送)"}
            disabled={pendingApproval !== null}
          />
          <Button
            size="icon"
            className="shrink-0"
            onClick={isStreaming ? handleStop : handleSend}
            disabled={pendingApproval !== null || (!isStreaming && !input.trim())}
            variant={isStreaming ? "destructive" : "default"}
            title={isStreaming ? "停止生成 (Esc)" : "发送 (Enter)"}
          >
            {isStreaming ? <Square className="h-4 w-4" /> : <Send className="h-4 w-4" />}
          </Button>
        </div>
      </div>
    </div>
  )
}

// ---- Assistant message bubble with thinking block ----

function AssistantBubble({ message }: { message: RichMessage }) {
  const [thinkingOpen, setThinkingOpen] = useState(false)
  const [toolCallsOpen, setToolCallsOpen] = useState(true)

  const { status, reasoning, content, toolCalls } = message
  const hasToolCalls = toolCalls && toolCalls.length > 0
  const allToolCallsDone = hasToolCalls && toolCalls!.every(tc => tc.result !== undefined)
  const isGenerating = status !== "done" && hasToolCalls && allToolCallsDone && !content

  // 如果全局状态为 idle，说明生成已结束（正常完成 / 页面刷新 / 用户停止）
  // 此时未收到结果的 tool call 应标记为"已中断"而非"执行中..."
  const globalPhase = useGenerationStore((s) => s.phase)
  const isIdle = globalPhase === "idle"

  return (
    <div className="max-w-[85%] space-y-1">
      {/* Pending: waiting */}
      {status === "pending" && !hasToolCalls && (
        <div className="rounded-lg px-3 py-2 bg-muted text-sm text-muted-foreground flex items-center gap-2">
          {isIdle ? (
            <>
              <XCircle className="h-3 w-3 text-muted-foreground/50" />
              已中断
            </>
          ) : (
            <>
              <Loader2 className="h-3 w-3 animate-spin" />
              等待中...
            </>
          )}
        </div>
      )}

      {/* Tool calls */}
      {hasToolCalls && (
        <div className="rounded-lg border border-border bg-muted/30 overflow-hidden">
          <button
            className="flex items-center gap-1.5 w-full px-3 py-1.5 text-xs text-muted-foreground hover:bg-muted/50 transition-colors"
            onClick={() => setToolCallsOpen(!toolCallsOpen)}
          >
            {toolCallsOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            <Terminal className="h-3 w-3" />
            <span>工具调用</span>
            <span className="text-[10px] ml-auto">{toolCalls.length} 次</span>
          </button>
          {toolCallsOpen && (
            <div className="border-t border-border divide-y divide-border">
              {toolCalls.map((tc, i) => (
                <div key={tc.id} className="px-3 py-2 text-xs space-y-1">
                  <div className="flex items-center gap-1.5 text-muted-foreground">
                    <Terminal className="h-3 w-3 shrink-0" />
                    <span className="font-mono font-medium text-foreground">{tc.name}</span>
                    <span className="font-mono opacity-60 truncate">
                      {formatToolArgs(tc)}
                    </span>
                  </div>
                  {tc.result === "(interrupted)" ? (
                    <div className="flex items-start gap-1.5 text-muted-foreground/50">
                      <XCircle className="h-3 w-3 mt-0.5 shrink-0" />
                      <span>已中断</span>
                    </div>
                  ) : tc.result !== undefined ? (
                    <div className="mt-1">
                      {tc.name === "TodoWrite" ? (
                        <TodoWriteResult args={tc.args} result={tc.result} />
                      ) : tc.result.startsWith("Error") ? (
                        <div className="flex items-start gap-1.5 text-red-500">
                          <XCircle className="h-3 w-3 mt-0.5 shrink-0" />
                          <span className="font-mono whitespace-pre-wrap">{tc.result}</span>
                        </div>
                      ) : (
                        <div className="flex items-start gap-1.5 text-muted-foreground">
                          <CheckCircle2 className="h-3 w-3 mt-0.5 shrink-0 text-green-500" />
                          <span className="font-mono whitespace-pre-wrap line-clamp-3">{tc.result}</span>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="flex items-center gap-1.5 text-muted-foreground">
                      {isIdle ? (
                        <>
                          <XCircle className="h-3 w-3 text-muted-foreground/50" />
                          <span>已中断</span>
                        </>
                      ) : (
                        <>
                          <Loader2 className="h-3 w-3 animate-spin" />
                          <span>执行中...</span>
                        </>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Generating: tool calls done, text not yet started */}
      {isGenerating && (
        <div className="rounded-lg px-3 py-2 bg-muted text-sm text-muted-foreground flex items-center gap-2">
          {isIdle ? (
            <>
              <XCircle className="h-3 w-3 text-muted-foreground/50" />
              <span>已中断</span>
            </>
          ) : (
            <>
              <Loader2 className="h-3 w-3 animate-spin" />
              <span>生成中...</span>
              <span className="inline-block w-2 h-4 bg-foreground/50 animate-pulse" />
            </>
          )}
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
                {isIdle ? (
                  <XCircle className="h-2.5 w-2.5 text-muted-foreground/50" />
                ) : (
                  <Loader2 className="h-2.5 w-2.5 animate-spin" />
                )}
                {isIdle ? "已中断" : "思考中..."}
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

      {/* Text content */}
      {(status === "streaming" || status === "done") && content && (
        <div className="rounded-lg px-3 py-2 bg-muted text-sm prose prose-sm dark:prose-invert prose-chat max-w-none break-words">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>
            {content}
          </ReactMarkdown>
          {status === "streaming" && !isIdle && (
            <span className="inline-block w-2 h-4 bg-foreground/50 ml-0.5 animate-pulse" />
          )}
        </div>
      )}

      {/* Streaming no content yet but past pending (shouldn't happen often) */}
      {status === "streaming" && !content && !reasoning && !hasToolCalls && (
        <div className="rounded-lg px-3 py-2 bg-muted text-sm text-muted-foreground flex items-center gap-2">
          {isIdle ? (
            <>
              <XCircle className="h-3 w-3 text-muted-foreground/50" />
              已中断
            </>
          ) : (
            <>
              <Loader2 className="h-3 w-3 animate-spin" />
              等待中...
            </>
          )}
        </div>
      )}
    </div>
  )
}

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
function formatToolArgs(tc: ToolCallEvent): string {
  const args = tc.args
  if (tc.name === "Read") return args.path as string
  if (tc.name === "Write") return args.path as string
  if (tc.name === "Edit") return args.path as string
  if (tc.name === "WriteLine") return args.path as string
  if (tc.name === "Glob") return args.pattern as string
  if (tc.name === "TodoWrite") {
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
