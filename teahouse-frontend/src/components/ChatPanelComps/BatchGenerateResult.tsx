import { CheckCheck, CircleDot, XCircle } from "lucide-react"
import { useTranslation } from "react-i18next"
import { parseBatchSteps } from "./toolDisplay"

/**
 * 把 BatchGenerate 的结果渲染成一份逐条清单 —— 与 TodoWrite 的清单同构，因为
 * 两者都是"多任务执行"，需要一眼看出哪几步成了、哪几步没成。汇总在标题行。
 */
const STATUS_KEY: Record<string, string> = {
  ok: "batchOk",
  "部分": "batchPartial",
  "失败": "batchFailed",
}

export function BatchGenerateResult({ result }: { result: string }) {
  const { t } = useTranslation("misc")
  const steps = parseBatchSteps(result)
  if (steps.length === 0) return null

  return (
    <div className="space-y-0.5">
      {steps.map((step, i) => {
        const icon =
          step.status === "ok" ? (
            <CheckCheck className="h-3 w-3 text-green-500 shrink-0 mt-0.5" />
          ) : step.status === "部分" ? (
            <CircleDot className="h-3 w-3 text-amber-500 shrink-0 mt-0.5" />
          ) : (
            <XCircle className="h-3 w-3 text-red-500 shrink-0 mt-0.5" />
          )
        const tone =
          step.status === "失败"
            ? "text-red-500"
            : step.status === "部分"
              ? "text-amber-600 dark:text-amber-400"
              : "text-muted-foreground"
        return (
          <div key={i} className={`flex items-start gap-1.5 ${tone}`}>
            {icon}
            <span className="shrink-0">{t(`assistant.tools.${STATUS_KEY[step.status]}`)}</span>
            <span className="font-mono break-all">{step.path}</span>
            {step.note && <span className="opacity-70 break-all">— {step.note}</span>}
          </div>
        )
      })}
    </div>
  )
}
