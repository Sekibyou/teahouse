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
              {m.content}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
