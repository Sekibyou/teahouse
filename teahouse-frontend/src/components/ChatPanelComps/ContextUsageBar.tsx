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
  normal: "text-foreground",
  warning: "text-yellow-500",
  danger: "text-red-500",
}

export function ContextUsageBar({ usage, textFirst = false }: { usage: ContextUsage | null; textFirst?: boolean }) {
  if (!usage || usage.threshold == null || usage.used_tokens == null) return null
  const used = usage.used_tokens
  const threshold = usage.threshold
  const pct = (used / threshold) * 100
  const estText = used >= 1000 ? (used / 1000).toFixed(1) : String(used)
  const thText = (threshold / 1000).toFixed(1)
  const barCls = STATUS_CLASS[usage.status ?? "normal"] ?? STATUS_CLASS.normal
  const braille = (
    <span className="relative leading-none">
      <span className="text-border">{brailleBar(100)}</span>
      <span className={`absolute inset-0 ${barCls}`}>{brailleBar(pct)}</span>
    </span>
  )
  const text = (
    <span>
      {/* `~` marks the chars/3 fallback, which can be off by a wide margin —
          before any call has reported usage there is nothing real to show. */}
      {usage.estimated ? "~" : ""}
      {estText}/{thText}k tokens
    </span>
  )
  return (
    <span className="font-mono whitespace-nowrap inline-flex items-center gap-1 text-foreground">
      {textFirst ? (
        <>
          {text}
          {braille}
        </>
      ) : (
        <>
          {braille}
          {text}
        </>
      )}
    </span>
  )
}
