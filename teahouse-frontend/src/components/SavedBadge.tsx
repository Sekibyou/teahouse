import { Check } from "lucide-react"
import { useTranslation } from "react-i18next"
import { cn } from "@/lib/utils"

/**
 * 「已保存」绿标 —— 用于"修改即生效"的控件（槽位下拉、通用设置滑块等），
 * 让用户确信不需要再找保存按钮。show 由调用方在写入成功后置 true、约 1.6s 后自行清除。
 */
export function SavedBadge({ show, className }: { show: boolean; className?: string }) {
  const { t } = useTranslation("common")
  if (!show) return null
  return (
    <span
      className={cn(
        "flex items-center gap-1 text-[11px] text-emerald-600 dark:text-emerald-400 animate-in fade-in duration-150",
        className
      )}
    >
      <Check className="h-3 w-3" />
      {t("saved")}
    </span>
  )
}
