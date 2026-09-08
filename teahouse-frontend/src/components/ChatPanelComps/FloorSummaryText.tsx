import { useTranslation } from "react-i18next"
import type { FloorsStats } from "@/lib/types"

// 楼层统计 + 归档界总结，拼成一段连续行内文本（单个逻辑字符串）。
// 楼层括号文本与总结文本之间不设 flex gap —— 否则会在"…层未总结）"与
// "| 上次总结…"之间插入空隙，视觉上断裂成两块。宽度不足自然换行即可。
export function FloorSummaryText({ stats }: { stats: FloorsStats | null }) {
  const { t } = useTranslation("chat")
  if (!stats || stats.latest_floor == null) return null
  return (
    <span className="min-w-0">
      {t("latestFloor")}
      <span className="text-foreground font-mono">{String(stats.latest_floor).padStart(3, "0")}</span>
      {t("ofFloors", { n: stats.total_confirmed })}
      {stats.total_drafts > 0 && <span>{t("plusDrafts", { n: stats.total_drafts })}</span>}
      {stats.unsummarized > 0 && <span>{t("unsummarized", { n: stats.unsummarized })}</span>}）
      {stats.last_summary_start != null ? (
        <span>
          {t("lastSummary")}
          <span className="text-foreground font-mono">
            {stats.last_summary_start === stats.last_summary_end
              ? t("lastSummarySingle", { n: stats.last_summary_start })
              : t("lastSummaryRange", { a: stats.last_summary_start, b: stats.last_summary_end })}
          </span>
        </span>
      ) : (
        <span>{t("noSummaryYet")}</span>
      )}
    </span>
  )
}
