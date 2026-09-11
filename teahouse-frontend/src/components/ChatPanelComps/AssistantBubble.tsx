import { useState, memo, useEffect, useRef, type ReactNode } from "react"
import {
  Loader2, ChevronDown, ChevronRight, Brain, Terminal,
  CheckCircle2, XCircle, Copy, Check,
} from "lucide-react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import type { Components } from "react-markdown"
import { isMermaidLanguage, MermaidDiagram, isPendingMermaidLanguage, MermaidPending, maskUnclosedMermaidTail } from "@/components/MermaidDiagram"
import type { RichMessage } from "./types"
import { formatBlockArgs } from "./utils"
import { TodoWriteResult } from "./TodoWriteResult"
import { useTranslation } from "react-i18next"

// chat 文本块同样支持 ```mermaid 图表：识别 language-mermaid 的 code 块渲染为
// 图表；fenced 代码块会被 react-markdown 包进 <pre>，pre 覆盖识别 mermaid 时
// 透出 code 覆盖的结果（图表本体），不套代码框。其余代码块走默认样式。
// 流式中间态：围栏未闭合的残缺 mermaid 由 maskUnclosedMermaidTail 替换成哨兵
// （language-teahouse-mermaid-pending），此处渲染占位标记而非跑真实渲染。

// 给单个 fenced 代码块 / mermaid / 生成中占位 挂一个「复制源码」按钮（hover 显示）。
// 源码取自 react-markdown hast 树里 pre > code 的文本子节点，流式重渲染时稳定。
function codeBlockSource(codeNode: unknown): string | null {
  const c = codeNode as { children?: { type?: string; value?: string }[] } | undefined
  const txt = (c?.children ?? [])
    .filter((k) => k.type === "text")
    .map((k) => k.value ?? "")
    .join("")
  return txt ? txt : null
}

// 拼出复制到剪贴板的最终文本。普通代码块只复制代码本体；mermaid 必须带 ```mermaid
// 围栏边界，否则粘贴进 .md 后是裸行、渲染不成图。
function copyPayload(codeNode: unknown, className?: unknown): string | null {
  const inner = codeBlockSource(codeNode)
  if (inner == null) return null
  if (isMermaidLanguage(className)) return "```mermaid\n" + inner + "\n```\n"
  return inner
}

function CopySource({ source }: { source: string }) {
  const { t } = useTranslation("misc")
  const [copied, setCopied] = useState(false)
  const timer = useRef<number | null>(null)
  useEffect(() => () => { if (timer.current !== null) window.clearTimeout(timer.current) }, [])
  const onCopy = () => {
    navigator.clipboard?.writeText(source)
    setCopied(true)
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setCopied(false), 1600)
  }
  return (
    <button
      type="button"
      onClick={onCopy}
      title={copied ? t("assistant.copied") : t("assistant.copy")}
      className="absolute right-1.5 top-1.5 z-[1] flex h-6 items-center gap-1 rounded-md bg-muted/80 px-1.5 text-xs text-muted-foreground opacity-0 backdrop-blur-sm transition-opacity hover:bg-muted hover:text-foreground group-hover:opacity-100"
    >
      {copied ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3" />}
      {copied ? t("assistant.copied") : t("assistant.copy")}
    </button>
  )
}

// relative 壳：无源码时（空代码）直接透出内容，不占位。
function FencedShell({ source, visual }: { source: string | null; visual: ReactNode }) {
  if (source == null) return <>{visual}</>
  return (
    <div className="group relative">
      {visual}
      <CopySource source={source} />
    </div>
  )
}

const markdownComponents: Components = {
  code({ className, children }) {
    if (isMermaidLanguage(className)) {
      return <MermaidDiagram code={String(children).replace(/\n$/, "")} />
    }
    if (isPendingMermaidLanguage(className)) {
      return <MermaidPending />
    }
    return <code className={className}>{children}</code>
  },
  pre({ node, children }) {
    const codeNode = node?.children?.[0]
    const cls = (codeNode as { properties?: { className?: unknown } } | undefined)?.properties?.className
    const source = copyPayload(codeNode, cls)
    // mermaid / pending：code 覆盖已透出成品（图/占位），pre 不再包 <pre>，直接透出。
    // 其余 fenced 代码块：包回 <pre> 维持样式与滚动。
    const visual = isMermaidLanguage(cls) || isPendingMermaidLanguage(cls)
      ? children
      : <pre>{children}</pre>
    return <FencedShell source={source} visual={visual} />
  },
}

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
  const { t } = useTranslation("misc")
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
            <span>{t("assistant.thinkingChain")}</span>
            {status === "reasoning" && !isIdle && isLatest && (
              <span className="flex items-center gap-1 ml-auto">
                <Loader2 className="h-2.5 w-2.5 animate-spin" />
                {t("assistant.thinking")}
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
                  <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                    {maskUnclosedMermaidTail(block.text!) ?? block.text!}
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
                    </div>
                    {block.result === "(interrupted)" ? (
                      <div className="flex items-start gap-1.5 text-muted-foreground/50">
                        <XCircle className="h-3 w-3 mt-0.5 shrink-0" />
                        <span>{t("assistant.interrupted")}</span>
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
                            <span>{t("assistant.interrupted")}</span>
                          </>
                        ) : (
                          <>
                            <Loader2 className="h-3 w-3 animate-spin" />
                            <span>{t("assistant.waiting")}</span>
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
