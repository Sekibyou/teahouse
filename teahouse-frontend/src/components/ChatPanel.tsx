import { useState, useRef, useEffect, useCallback } from "react"
import { Send, Loader2, ChevronDown, ChevronRight, Brain } from "lucide-react"
import { Button } from "@/components/ui/button"
import { chatApi } from "@/lib/api"
import type { ChatMessage } from "@/lib/types"

type MsgStatus = "pending" | "reasoning" | "streaming" | "done"

interface RichMessage {
  id: string
  role: "user" | "assistant"
  content: string
  reasoning: string
  status: MsgStatus
}

let msgIdCounter = 0
function nextId() {
  return `msg-${++msgIdCounter}`
}

export function ChatPanel() {
  const [messages, setMessages] = useState<RichMessage[]>([])
  const [input, setInput] = useState("")
  const [error, setError] = useState("")
  const scrollRef = useRef<HTMLDivElement>(null)
  const aborterRef = useRef<AbortController | null>(null)

  const scrollToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      if (scrollRef.current) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight
      }
    })
  }, [])

  // Auto-scroll when messages change
  useEffect(() => { scrollToBottom() }, [messages, scrollToBottom])

  const handleSend = async () => {
    const text = input.trim()
    if (!text) return

    const userMsg: RichMessage = { id: nextId(), role: "user", content: text, reasoning: "", status: "done" }
    const assistantMsg: RichMessage = { id: nextId(), role: "assistant", content: "", reasoning: "", status: "pending" }
    const newMessages = [...messages, userMsg, assistantMsg]
    setMessages(newMessages)
    setInput("")
    setError("")
    scrollToBottom()

    try {
      const stream = await chatApi.sendStream(
        newMessages.map((m) => ({ role: m.role, content: m.content || "" }))
      )
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
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantMsg.id
            ? { ...m, status: "done" as MsgStatus }
            : m
        )
      )
      setError(err instanceof Error ? err.message : "请求失败")
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
            onClick={handleSend}
            disabled={!input.trim()}
          >
            <Send className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  )
}

// ---- Assistant message bubble with thinking block ----

function AssistantBubble({ message }: { message: RichMessage }) {
  const [thinkingOpen, setThinkingOpen] = useState(false)

  const { status, reasoning, content } = message

  return (
    <div className="max-w-[85%] space-y-1">
      {/* Pending: waiting */}
      {status === "pending" && (
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
      {status === "streaming" && !content && !reasoning && (
        <div className="rounded-lg px-3 py-2 bg-muted text-sm text-muted-foreground flex items-center gap-2">
          <Loader2 className="h-3 w-3 animate-spin" />
          等待中...
        </div>
      )}
    </div>
  )
}
