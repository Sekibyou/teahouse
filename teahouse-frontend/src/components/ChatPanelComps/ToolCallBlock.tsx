import { useState } from "react"
import { useTranslation } from "react-i18next"
import { CheckCircle2, ChevronDown, ChevronRight, Loader2, XCircle } from "lucide-react"
import type { ContentBlock } from "./types"
import { toolSummary } from "./toolDisplay"
import { TodoWriteResult } from "./TodoWriteResult"
import { BatchGenerateResult } from "./BatchGenerateResult"

/** 有专属清单渲染的工具：既不出摘要行，也不提供展开原文。 */
const CHECKLIST_TOOLS = new Set(["TodoWrite", "BatchGenerate"])

/** 展开后的原文：diff 逐行 +/- 着色，其余保持等宽换行。 */
function RawResult({ text, kind, clamp }: { text: string; kind?: "diff"; clamp: boolean }) {
  const box = clamp
    ? "line-clamp-3"
    : "max-h-80 overflow-y-auto scrollbar-thin"
  if (kind === "diff") {
    return (
      <div className={`font-mono whitespace-pre-wrap break-all ${box}`}>
        {text.split("\n").map((line, i) => {
          const cls =
            line.startsWith("+++") || line.startsWith("---")
              ? "text-muted-foreground/70"
              : line.startsWith("@@")
                ? "text-sky-600 dark:text-sky-400"
                : line.startsWith("+")
                  ? "text-green-600 dark:text-green-400"
                  : line.startsWith("-")
                    ? "text-red-600 dark:text-red-400"
                    : ""
          return <div key={i} className={cls}>{line || " "}</div>
        })}
      </div>
    )
  }
  return <div className={`font-mono whitespace-pre-wrap break-all ${box}`}>{text}</div>
}

/**
 * 一条工具调用气泡。
 *
 * 标题行 = 工具图标 + 工具名 + 该工具最重要的标识（路径 / skill 名 / 提交信息…）。
 * 正文 = 一行有意义的摘要（读了多少行多少字、匹配多少文件、提交 hash…），
 * 点击标题行可展开完整原始结果（成功的只读工具此前被 line-clamp 压到 3 行、
 * 无从查看，这里补上出口）。
 *
 * 未特化的工具（插件工具、未知工具）`summary` 为 null，退回默认渲染：
 * 原始结果截断三行 + 可展开。错误与执行中的呈现与既有行为一致。
 */
export function ToolCallBlock({ block, isIdle }: { block: ContentBlock; isIdle: boolean }) {
  const { t } = useTranslation("misc")
  const [open, setOpen] = useState(false)

  const result = block.result
  const { icon: Icon, target, summary, rawKind } = toolSummary(block.name || "", block.args, result, t)

  const interrupted = result === "(interrupted)"
  const hasResult = result !== undefined && !interrupted
  const isError = hasResult && result!.startsWith("Error")
  // 错误已完整展示、清单类工具有自己的渲染，两者都无需展开原文。
  const canExpand = hasResult && !isError && !CHECKLIST_TOOLS.has(block.name || "")

  // 错误未被摘要覆盖，故仅在"有摘要、或默认渲染"时才有可折叠的正文可点开。
  // 标题行允许换行（items-start + 标识 break-all）：标识（路径/变量名列表/提交信息）
  // 可能极长，用 truncate 在 fit-content 的 flex 里截不住、只会把气泡撑宽。
  const headerClass = "flex w-full items-start gap-1.5 text-left text-muted-foreground"

  const header = (
    <>
      <Icon className="h-3 w-3 mt-0.5 shrink-0" />
      <span className="font-mono font-medium text-foreground shrink-0">{block.name}</span>
      {target && <span className="min-w-0 font-mono text-muted-foreground/70 break-all">{target}</span>}
      {canExpand && (
        <span className="ml-auto mt-0.5 shrink-0 text-muted-foreground/50">
          {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        </span>
      )}
    </>
  )

  return (
    <div className="max-w-full rounded-lg border border-border bg-muted/30 overflow-hidden">
      <div className="px-3 py-2 text-xs space-y-1">
        {canExpand ? (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className={`${headerClass} hover:text-foreground transition-colors`}
          >
            {header}
          </button>
        ) : (
          <div className={headerClass}>{header}</div>
        )}

        {/* 正文 */}
        {interrupted ? (
          <div className="flex items-start gap-1.5 text-muted-foreground/50">
            <XCircle className="h-3 w-3 mt-0.5 shrink-0" />
            <span>{t("assistant.interrupted")}</span>
          </div>
        ) : !hasResult ? (
          <div className="flex items-center gap-1.5 text-muted-foreground">
            {isIdle ? (
              <>
                <XCircle className="h-3 w-3 text-muted-foreground/50" />
                <span>{t("assistant.interrupted")}</span>
              </>
            ) : (
              <>
                <Loader2 className="h-3 w-3 animate-spin" />
                <span>{block.running ? t("assistant.running") : t("assistant.waiting")}</span>
              </>
            )}
          </div>
        ) : isError ? (
          <div className="flex items-start gap-1.5 text-red-500">
            <XCircle className="h-3 w-3 mt-0.5 shrink-0" />
            <RawResult text={result!} clamp={false} />
          </div>
        ) : block.name === "TodoWrite" ? (
          <TodoWriteResult args={block.args || {}} result={result!} />
        ) : block.name === "BatchGenerate" ? (
          <BatchGenerateResult result={result!} />
        ) : (
          <div className="space-y-1">
            <div className="flex items-start gap-1.5 text-muted-foreground">
              <CheckCircle2 className="h-3 w-3 mt-0.5 shrink-0 text-green-500" />
              {summary !== null ? (
                <span>{summary}</span>
              ) : (
                <RawResult text={result!} kind={rawKind} clamp={!open} />
              )}
            </div>
            {summary !== null && open && (
              <div className="rounded-md border border-border/60 bg-background/50 px-2 py-1.5 text-muted-foreground/90">
                <RawResult text={result!} kind={rawKind} clamp={false} />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
