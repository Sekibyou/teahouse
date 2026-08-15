import { useState, memo } from "react"
import {
  Loader2, ChevronDown, ChevronRight, Brain, Terminal,
  CheckCircle2, XCircle,
} from "lucide-react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import type { RichMessage } from "./types"
import { formatBlockArgs } from "./utils"
import { TodoWriteResult } from "./TodoWriteResult"

// ---- Assistant message bubble with thinking block ----
// memo + 自定义浅比较：消息对象引用不变或 isLatest 不变时跳过重渲染，
// 配合 updateMessage 只替换单条，让流式更新不再触发全列表重建。
export const AssistantBubble = memo(function AssistantBubble({
  message,
  isLatest,
  isIdle,
}: {
  message: RichMessage
  isLatest: boolean
  isGlobalGenerating: boolean
  isIdle: boolean
}) {
  const [thinkingOpen, setThinkingOpen] = useState(false)

  const { status, reasoning, content, blocks } = message
  const hasBlocks = blocks && blocks.length > 0

  return (
    <div className="max-w-[85%] space-y-1">
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
            {status === "reasoning" && !isIdle && isLatest && (
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

      {/* Blocks: text + tool_call interleaved in generation order */}
      {hasBlocks && (
        <>
          {blocks!.map((block, i) => {
            if (block.type === "text" && block.text) {
              return (
                <div key={`t-${i}`} className="rounded-lg px-3 py-2 bg-muted text-base prose dark:prose-invert prose-chat max-w-none break-words">
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

      {/* Fallback: plain text message (no blocks) */}
      {!hasBlocks && content && (
        <div className="rounded-lg px-3 py-2 text-base bg-muted whitespace-pre-wrap break-words">
          {content}
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
