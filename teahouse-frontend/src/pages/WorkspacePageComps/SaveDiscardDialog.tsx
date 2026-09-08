import { Button } from "@/components/ui/button"
import { useEffect } from "react"

export interface SaveDiscardDialogProps {
  open: boolean
  title: string
  message: string
  /** 保存并离开 */
  saveText: string
  /** 丢弃并离开 */
  discardText: string
  /** 取消 */
  cancelText: string
  onSave: () => void
  onDiscard: () => void
  onCancel: () => void
}

/** 离开一个带未保存更改的文件时的三选项守卫：保存并离开 / 丢弃并离开 / 取消。
 *  保存与丢弃都会触发离开动作，取消则留在当前文件。Enter 不绑定任何主操作，避免误写盘；
 *  Esc / 点背景 = 取消。 */
export function SaveDiscardDialog({
  open,
  title,
  message,
  saveText,
  discardText,
  cancelText,
  onSave,
  onDiscard,
  onCancel,
}: SaveDiscardDialogProps) {
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onCancel() }
    }
    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [open, onCancel])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50"
      onClick={onCancel}
    >
      <div
        className="bg-background rounded-lg shadow-lg w-full max-w-sm mx-4 p-6 space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="font-semibold text-base">{title}</h3>
        <p className="text-sm text-muted-foreground">{message}</p>
        <div className="flex justify-end gap-2">
          <Button variant="destructive" size="sm" onClick={onDiscard}>
            {discardText}
          </Button>
          <Button variant="outline" size="sm" onClick={onCancel}>
            {cancelText}
          </Button>
          <Button variant="default" size="sm" onClick={onSave}>
            {saveText}
          </Button>
        </div>
      </div>
    </div>
  )
}
