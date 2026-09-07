import { type ReactNode } from "react"
import type { PayloadMessage } from "@/utils/payloadView"

interface PayloadViewerProps {
  messages: PayloadMessage[]
  meta: Array<[string, string]>
}

const ROLE_LABEL: Record<string, string> = {
  user: "User",
  assistant: "Assistant",
  system: "System",
  tool: "Tool",
}

// 徽标底色：assistant 用主色弱化，其余走中性，避免喧宾夺主
function roleBadgeClass(role: string): string {
  const r = role.toLowerCase()
  if (r === "assistant") return "bg-primary/10 text-primary border border-primary/20"
  if (r === "user") return "bg-muted text-foreground border border-border"
  if (r === "tool") return "bg-muted text-muted-foreground border border-border"
  return "bg-muted text-muted-foreground border border-border"
}

// 逐字符扫描，把 `${...}` 与 `{{...}}` 占位符（括号深度配平，内嵌不提前截断）
// 包成标红 span。payload 里残留占位符通常意味着解析失败，需重点标注——无需
// 细分语法、不做 markdown 解析，仅标红即可。与 MarkdownRenderer 的 scanBrace 语义一致。
function highlightPlaceholders(text: string): ReactNode[] {
  if (!text) return [text]
  const out: ReactNode[] = []
  let last = 0
  let i = 0
  const n = text.length
  while (i < n) {
    const starts = (text[i] === "$" && text[i + 1] === "{") || (text[i] === "{" && text[i + 1] === "{")
    if (starts) {
      let depth = 0
      let end = i
      while (end < n) {
        if (text[end] === "{") depth++
        else if (text[end] === "}") {
          depth--
          if (depth === 0) {
            end++
            break
          }
        }
        end++
      }
      if (depth === 0) {
        if (i > last) out.push(text.slice(last, i))
        out.push(
          <span key={i} className="text-red-600 dark:text-red-400 font-medium">
            {text.slice(i, end)}
          </span>,
        )
        last = end
        i = end
        continue
      }
    }
    i++
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

export function PayloadViewer({ messages, meta }: PayloadViewerProps) {
  return (
    <div className="px-4 py-4">
      <div className="mx-auto max-w-3xl flex flex-col gap-3">
        {meta.length > 0 && (
          <div className="flex flex-wrap gap-x-4 gap-y-1 px-1 text-xs text-muted-foreground font-mono">
            {meta.map(([k, v]) => (
              <span key={k} className="whitespace-nowrap">
                <span className="text-muted-foreground/70">{k}=</span>
                {v}
              </span>
            ))}
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className="rounded-md border border-border bg-background overflow-hidden">
            <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border bg-muted/30">
              <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs ${roleBadgeClass(m.role)}`}>
                {ROLE_LABEL[m.role.toLowerCase()] ?? (m.role || "message")}
              </span>
              <span className="text-xs text-muted-foreground">#{i}</span>
            </div>
            <div className="px-3 py-2.5 text-sm leading-relaxed whitespace-pre-wrap break-words">
              {highlightPlaceholders(m.content)}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
