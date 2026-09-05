import { Button } from "@/components/ui/button"
import { useTranslation } from "react-i18next"
import { useEffect } from "react"

export interface ConfirmDialogProps {
  open: boolean
  title: string
  message: string
  confirmText?: string
  cancelText?: string
  variant?: "default" | "destructive"
  onConfirm: () => void
  onCancel: () => void
  /** Enter 触发确认（默认关）。用于无输入框的纯确认场景（如删除）。 */
  confirmOnEnter?: boolean
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmText,
  cancelText,
  variant = "default",
  onConfirm,
  onCancel,
  confirmOnEnter = false,
}: ConfirmDialogProps) {
  const { t } = useTranslation("misc")
  const confirmLabel = confirmText ?? t("common:ok")
  const cancelLabel = cancelText ?? t("common:cancel")

  useEffect(() => {
    if (!open || !confirmOnEnter) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Enter") { e.preventDefault(); onConfirm() }
      else if (e.key === "Escape") { e.preventDefault(); onCancel() }
    }
    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [open, confirmOnEnter, onConfirm, onCancel])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50"
      onClick={onCancel}
    >
      <div
        className="bg-background rounded-lg shadow-lg w-full max-w-sm mx-4 p-6 space-y-4"
        onClick={e => e.stopPropagation()}
      >
        <h3 className="font-semibold text-base">{title}</h3>
        <p className="text-sm text-muted-foreground">{message}</p>
        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onCancel}>
            {cancelLabel}
          </Button>
          <Button
            variant={variant === "destructive" ? "destructive" : "default"}
            size="sm"
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  )
}
