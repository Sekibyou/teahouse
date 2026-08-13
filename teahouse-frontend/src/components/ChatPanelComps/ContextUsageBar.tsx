import type { ContextUsage } from "@/lib/types"

// 盲文点阵字符，索引 = 已点亮点数（0-6）
const DOT_CHARS = ["⠀", "⠁", "⠃", "⠇", "⠏", "⠟", "⠿"]
const BAR_LEN = 10

function brailleBar(pct: number): string {
  const clamped = Math.max(0, Math.min(100, pct))
  const totalDots = Math.floor((clamped * 60) / 100)
  const fullChars = Math.floor(totalDots / 6)
  const rem = totalDots % 6
  let s = DOT_CHARS[6].repeat(fullChars)
  if (rem > 0 && fullChars < BAR_LEN) s += DOT_CHARS[rem]
  const empty = BAR_LEN - s.length
  if (empty > 0) s += DOT_CHARS[0].repeat(empty)
  return s
}

const STATUS_CLASS: Record<string, string> = {
  normal: "text-muted-foreground",
  warning: "text-yellow-500",
  danger: "text-red-500",
}

export function ContextUsageBar({ usage }: { usage: ContextUsage | null }) {
  if (!usage || usage.threshold == null || usage.estimated_tokens == null) return null
  const est = usage.estimated_tokens
  const threshold = usage.threshold
  const pct = (est / threshold) * 100
  const estText = est >= 1000 ? (est / 1000).toFixed(1) : String(est)
  const thText = (threshold / 1000).toFixed(1)
  const cls = STATUS_CLASS[usage.status ?? "normal"] ?? STATUS_CLASS.normal
  return (
    <span className={`font-mono whitespace-nowrap ${cls}`}>
      {brailleBar(pct)} {estText}/{thText}k tokens
    </span>
  )
}
