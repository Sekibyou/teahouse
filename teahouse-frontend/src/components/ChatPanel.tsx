import { useState, useRef, useEffect, useCallback } from "react"
import { Send, Square, Loader2, ChevronDown, ChevronRight, Brain, Terminal, CheckCircle2, XCircle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { chatApi } from "@/lib/api"
import { getActiveInstance } from "@/stores/sessionStore"
import type { ChatMessage } from "@/lib/types"

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

const MODIFYING_TOOLS = new Set(["Write", "Edit", "WriteLine"])

interface ChatPanelProps {
  onFileChanged?: (filePath: string) => void
}

export function ChatPanel({ onFileChanged }: ChatPanelProps) {
  const [messages, setMessages] = useState<RichMessage[]>([])
  const [input, setInput] = useState("")
  const [error, setError] = useState("")
  const [isStreaming, setIsStreaming] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const aborterRef = useRef<AbortController | null>(null)
  const latestToolCallsRef = useRef<ToolCallEvent[]>([])

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
  }, [])

  const handleSend = async (useTools: boolean = true) => {
    const text = input.trim()
    if (!text) return

    const userMsg: RichMessage = { id: nextId(), role: "user", content: text, reasoning: "", status: "done" }
    const assistantMsg: RichMessage = { id: nextId(), role: "assistant", content: "", reasoning: "", status: "pending", toolCalls: [] }
    const newMessages = [...messages, userMsg, assistantMsg]
    setMessages(newMessages)
    setInput("")
    setError("")
    setIsStreaming(true)
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
        )
      }

      const reader = stream.getReader()
      const decoder = new TextDecoder()
      let buffer = ""
      let currentType: string | null = null

      const processLine = (line: string) => {
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

              // Notify parent if a file-modifying tool was used
              if (onFileChanged) {
                const matched = latestToolCallsRef.current.find((tc) => tc.id === data.id)
                if (matched && MODIFYING_TOOLS.has(matched.name)) {
                  const filePath = matched.args.path as string
                  if (filePath) {
                    onFileChanged(filePath)
                  }
                }
              }

              scrollToBottom()
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
          processLine(line)
        }
      }
      // Process remaining buffer
      if (buffer.trim()) {
        for (const line of buffer.split("\n")) {
          processLine(line)
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
      setIsStreaming(false)
      aborterRef.current = null
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="p-3 border-b border-border shrink-0">
        <h3 className="text-sm font-semibold">AI 助手</h3>
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
      </div>

      {/* Input */}
      <div className="p-3 border-t border-border shrink-0">
        <div className="flex gap-2">
          <textarea
            className="flex-1 resize-none rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring min-h-[40px] max-h-[120px]"
            rows={1}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="输入消息... (Enter 发送)"
          />
          <Button
            size="icon"
            className="shrink-0"
            onClick={isStreaming ? handleStop : handleSend}
            disabled={!isStreaming && !input.trim()}
            variant={isStreaming ? "destructive" : "default"}
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

  return (
    <div className="max-w-[85%] space-y-1">
      {/* Pending: waiting */}
      {status === "pending" && !hasToolCalls && (
        <div className="rounded-lg px-3 py-2 bg-muted text-sm text-muted-foreground flex items-center gap-2">
          <Loader2 className="h-3 w-3 animate-spin" />
          等待中...
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
                  {tc.result !== undefined && (
                    <div className="mt-1">
                      {tc.result.startsWith("Error") ? (
                        <div className="flex items-start gap-1.5 text-red-500">
                          <XCircle className="h-3 w-3 mt-0.5 shrink-0" />
                          <span className="font-mono whitespace-pre-wrap">{tc.result}</span>
                        </div>
                      ) : (
                        <div className="flex items-start gap-1.5 text-green-600 dark:text-green-400">
                          <CheckCircle2 className="h-3 w-3 mt-0.5 shrink-0" />
                          <span className="font-mono whitespace-pre-wrap line-clamp-3">{tc.result}</span>
                        </div>
                      )}
                    </div>
                  )}
                  {tc.result === undefined && (
                    <div className="flex items-center gap-1.5 text-muted-foreground">
                      <Loader2 className="h-3 w-3 animate-spin" />
                      <span>执行中...</span>
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
          <Loader2 className="h-3 w-3 animate-spin" />
          <span>生成中...</span>
          <span className="inline-block w-2 h-4 bg-foreground/50 animate-pulse" />
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
                <Loader2 className="h-2.5 w-2.5 animate-spin" />
                思考中...
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
        <div className="rounded-lg px-3 py-2 bg-muted text-sm whitespace-pre-wrap break-words">
          {content}
          {status === "streaming" && (
            <span className="inline-block w-2 h-4 bg-foreground/50 ml-0.5 animate-pulse" />
          )}
        </div>
      )}

      {/* Streaming no content yet but past pending (shouldn't happen often) */}
      {status === "streaming" && !content && !reasoning && !hasToolCalls && (
        <div className="rounded-lg px-3 py-2 bg-muted text-sm text-muted-foreground flex items-center gap-2">
          <Loader2 className="h-3 w-3 animate-spin" />
          等待中...
        </div>
      )}
    </div>
  )
}

/** Format tool call args for compact display */
function formatToolArgs(tc: ToolCallEvent): string {
  const args = tc.args
  if (tc.name === "Read") return args.path as string
  if (tc.name === "Write") return args.path as string
  if (tc.name === "Edit") return args.path as string
  if (tc.name === "WriteLine") return args.path as string
  if (tc.name === "Glob") return args.pattern as string
  return JSON.stringify(args)
}
