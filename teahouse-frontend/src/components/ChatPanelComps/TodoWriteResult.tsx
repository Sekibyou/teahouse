import { CheckCheck, CircleDot, Circle, XCircle, CheckCircle2 } from "lucide-react"

/** Render a TodoWrite result as a visual task list */
export function TodoWriteResult({ args, result }: { args: Record<string, unknown>; result: string }) {
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
