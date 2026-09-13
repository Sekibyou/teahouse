import { CheckCheck, CircleDot, Circle, XCircle } from "lucide-react"
import { useTranslation } from "react-i18next"

/** 把 TodoWrite 的结果渲染成一份可视化任务清单。 */
export function TodoWriteResult({ args, result }: { args: Record<string, unknown>; result: string }) {
  const { t } = useTranslation("misc")

  if (result.startsWith("Error")) {
    return (
      <div className="flex items-start gap-1.5 text-red-500">
        <XCircle className="h-3 w-3 mt-0.5 shrink-0" />
        <span className="font-mono whitespace-pre-wrap">{result}</span>
      </div>
    )
  }

  const todos = (args.todos as Array<{ content: string; status: string }>) || []
  const counts = { completed: 0, in_progress: 0, pending: 0 }
  for (const todo of todos) {
    if (todo.status === "completed") counts.completed++
    else if (todo.status === "in_progress") counts.in_progress++
    else counts.pending++
  }
  const stat = t("assistant.tools.todoStat", {
    done: counts.completed,
    active: counts.in_progress,
    pending: counts.pending,
  })

  if (todos.length === 0) {
    return <div className="text-muted-foreground">{stat}</div>
  }

  return (
    <div>
      <div className="space-y-0.5">
        {todos.map((todo, i) => {
          const icon =
            todo.status === "completed" ? (
              <CheckCheck className="h-3 w-3 text-green-500 shrink-0 mt-0.5" />
            ) : todo.status === "in_progress" ? (
              <CircleDot className="h-3 w-3 text-amber-500 shrink-0 mt-0.5" />
            ) : (
              <Circle className="h-3 w-3 text-muted-foreground/40 shrink-0 mt-0.5" />
            )
          return (
            <div
              key={i}
              className={`flex items-start gap-1.5 ${
                todo.status === "completed"
                  ? "text-muted-foreground/50 line-through"
                  : todo.status === "in_progress"
                    ? "text-foreground font-medium"
                    : "text-muted-foreground"
              }`}
            >
              {icon}
              <span>{todo.content}</span>
            </div>
          )
        })}
      </div>
      <div className="mt-1.5 pt-1.5 border-t border-border/50 text-muted-foreground">{stat}</div>
    </div>
  )
}
