import { toast } from "sonner"
import i18n from "@/i18n/config"
import { useErrorDetailStore } from "@/stores/errorDetailStore"

/** 超过这个长度（或含换行）就认为 toast 装不下，需要详情弹窗。 */
const TOAST_MAX = 120

/** toast 里显示的预览长度。 */
const PREVIEW_MAX = 100

/** 后端的来源标识 → 可读名。未登记的标识原样显示。 */
const SOURCE_LABELS: Record<string, string> = { engine: "sourceEngine" }

/** 该错误文本是否超出 toast 的承载能力（需要走详情弹窗）。 */
export function isLongError(detail: string): boolean {
  const text = (detail || "").trim()
  return text.length > TOAST_MAX || text.includes("\n")
}

/** 打开错误详情弹窗（供已有内联报错处挂「详情」按钮用）。 */
export function showErrorDetail(detail: string, source?: string): void {
  const text = (detail || "").trim()
  if (!text) return
  useErrorDetailStore.getState().showError({ detail: text, source })
}

/**
 * 统一的错误提示入口。
 *
 * - 短错误 → 一条普通 toast（与直接 `toast.error(text)` 观感一致）。
 * - 长错误（多行 / 超长，如上游 API 原文、traceback、git stderr）→ 单行截断的 toast +
 *   「查看详情」按钮，全文进 `<ErrorDetailDialog />`（可滚动、可一键复制）。
 *   否则长错误在 toast 里既被截断、又选不中、几秒后消失，等于看不到。
 *
 * @param detail 完整错误文本。后端给什么就传什么（已含上下文），不要在这里改写。
 * @param source 来源标识（后端 `error` 事件的 source / 调用点自报），仅用于弹窗标题。
 */
export function notifyError(detail: string, source?: string): void {
  const text = (detail || "").trim()
  if (!text) return

  const oneLine = text.replace(/\s*\n\s*/g, " ⏎ ").trim()
  if (!isLongError(text)) {
    toast.error(text)
    return
  }

  const preview = oneLine.length > PREVIEW_MAX ? oneLine.slice(0, PREVIEW_MAX) + "…" : oneLine
  toast.error(preview, {
    duration: 8000,
    action: {
      label: i18n.t("misc:errorDetail.viewDetails"),
      onClick: () => showErrorDetail(text, source),
    },
  })
}

/** 弹窗标题用的来源名（未知标识原样返回）。 */
export function sourceLabel(source?: string): string {
  if (!source) return ""
  const key = SOURCE_LABELS[source]
  return key ? i18n.t(`misc:errorDetail.${key}`) : source
}
