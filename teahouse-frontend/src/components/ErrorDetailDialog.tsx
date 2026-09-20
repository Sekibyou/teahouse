import { useEffect, useState } from "react"
import { useLocation } from "react-router-dom"
import { AlertTriangle, Check, Copy, X } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { useDialogBackClose } from "@/hooks/useDialogBackClose"
import { useErrorDetailStore } from "@/stores/errorDetailStore"
import { sourceLabel } from "@/lib/notifyError"

/**
 * 复制到剪贴板。https / localhost 走标准 clipboard API；**http 部署没有该 API**
 * （VPS 未开 TLS 时就是这种），退回 textarea + execCommand。
 */
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    /* 权限被拒等 → 走下面的兜底路径 */
  }
  try {
    const ta = document.createElement("textarea")
    ta.value = text
    ta.style.position = "fixed"
    ta.style.opacity = "0"
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand("copy")
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}

/**
 * 错误详情弹窗（全局唯一，挂在 MainLayout）。
 *
 * 存在的理由：长错误（上游 API 原文、traceback、git stderr）塞进 toast 会被截断、
 * 选不中、几秒后消失——作者拿不到可复制的完整报错。这里给出全文 + 一键复制。
 * 触发入口统一是 `notifyError()`（`@/lib/notifyError`）。
 */
export function ErrorDetailDialog() {
  const { t } = useTranslation("misc")
  const error = useErrorDetailStore((s) => s.error)
  const closeError = useErrorDetailStore((s) => s.closeError)
  const location = useLocation()
  const [copyState, setCopyState] = useState<"idle" | "ok" | "fail">("idle")

  useDialogBackClose(!!error, closeError, {
    route: location.pathname,
    kind: "error-detail",
    name: "错误详情",
  })

  // 换一条新错误时重置复制反馈，避免"已复制"残留到另一条错误上。
  useEffect(() => setCopyState("idle"), [error])

  if (!error) return null

  const source = sourceLabel(error.source)

  const handleCopy = async () => {
    setCopyState((await copyToClipboard(error.detail)) ? "ok" : "fail")
  }

  return (
    <div
      className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50"
      onClick={closeError}
    >
      <div
        className="bg-background rounded-lg shadow-lg w-full max-w-2xl mx-4 flex flex-col max-h-[80vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4 py-3 border-b border-border shrink-0">
          <AlertTriangle className="h-4 w-4 text-destructive shrink-0" />
          <h3 className="font-semibold text-base">{t("errorDetail.title")}</h3>
          {source && (
            <span className="text-xs text-muted-foreground truncate min-w-0">· {source}</span>
          )}
          <button className="ml-auto text-muted-foreground hover:text-foreground shrink-0" onClick={closeError}>
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* 全文。break-all 保证超长 JSON 不撑出横向滚动，且整段可手动选中。 */}
        <pre className="flex-1 min-h-0 overflow-auto scrollbar-thin px-4 py-3 text-xs font-mono whitespace-pre-wrap break-all select-text">
          {error.detail}
        </pre>

        <div className="flex items-center gap-2 px-4 py-3 border-t border-border shrink-0">
          {copyState === "fail" && (
            <span className="text-xs text-destructive mr-auto">{t("errorDetail.copyFail")}</span>
          )}
          <div className="ml-auto flex gap-2">
            <Button variant="outline" size="sm" onClick={handleCopy}>
              {copyState === "ok" ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              {copyState === "ok" ? t("errorDetail.copied") : t("errorDetail.copy")}
            </Button>
            <Button size="sm" onClick={closeError}>
              {t("errorDetail.close")}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
