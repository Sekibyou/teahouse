import { useState, useRef, useEffect, useCallback } from "react"
import { Button } from "@/components/ui/button"
import { X, Copy, Trash2, Monitor } from "lucide-react"

interface LogEntry {
  ts: number
  source: "session_event" | "session_user_msg" | "session_done" | "session_destroyed" | "session_created" | "_doSend" | "loadHistory" | "switchSession" | "render"
  detail: string
}

/**
 * Diagnostic event log panel for debugging streaming issues.
 *
 * USAGE: Set `window.__TEAHOUSE_DIAG__ = true` in the browser console
 * to start collecting events, then click the "🩺" button in ChatPanel header
 * to open the panel. Events are timestamped and can be copied or cleared.
 *
 * Call `window.__TEAHOUSE_LOG__(source, detail)` from anywhere in the code.
 */
declare global {
  interface Window {
    __TEAHOUSE_DIAG__?: boolean
    __TEAHOUSE_LOG__?: (source: LogEntry["source"], detail: string) => void
    __TEAHOUSE_LOG_RAW__?: LogEntry[]
  }
}

export function useDiagnosticLog() {
  const [entries, setEntries] = useState<LogEntry[]>([])
  const enabledRef = useRef(false)

  useEffect(() => {
    // Expose global toggle + log function
    window.__TEAHOUSE_LOG_RAW__ = []
    window.__TEAHOUSE_LOG__ = (source, detail) => {
      if (!enabledRef.current) return
      const entry: LogEntry = { ts: performance.now(), source, detail }
      window.__TEAHOUSE_LOG_RAW__!.push(entry)
      setEntries(prev => [...prev, entry])
    }
    // Check if already toggled on from a previous mount
    if (window.__TEAHOUSE_DIAG__) enabledRef.current = true

    return () => {
      window.__TEAHOUSE_LOG__ = undefined
      window.__TEAHOUSE_LOG_RAW__ = undefined
    }
  }, [])

  const enable = useCallback(() => {
    enabledRef.current = true
    window.__TEAHOUSE_DIAG__ = true
    window.__TEAHOUSE_LOG__?.("_doSend", "DIAGNOSTICS ENABLED")
  }, [])

  const disable = useCallback(() => {
    enabledRef.current = false
    window.__TEAHOUSE_DIAG__ = false
  }, [])

  const clear = useCallback(() => {
    setEntries([])
    if (window.__TEAHOUSE_LOG_RAW__) window.__TEAHOUSE_LOG_RAW__ = []
  }, [])

  const copy = useCallback(() => {
    const text = entries.map(e => `[${e.ts.toFixed(0)}ms] ${e.source}: ${e.detail}`).join("\n")
    navigator.clipboard.writeText(text).catch(() => {})
  }, [entries])

  return { entries, enabled: enabledRef.current, enable, disable, clear, copy }
}

export function DiagnosticPanel({
  open,
  onClose,
  entries,
  enabled,
  onEnable,
  onDisable,
  onClear,
  onCopy,
}: {
  open: boolean
  onClose: () => void
  entries: LogEntry[]
  enabled: boolean
  onEnable: () => void
  onDisable: () => void
  onClear: () => void
  onCopy: () => void
}) {
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (open && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight
    }
  }, [entries.length, open])

  if (!open) return null

  return (
    <div className="absolute inset-0 z-50 bg-background flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border shrink-0">
        <div className="flex items-center gap-2">
          <Monitor className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-semibold">诊断日志</span>
          <span className="text-[10px] text-muted-foreground">
            {entries.length} 条
          </span>
          <span className={`text-[10px] px-1.5 py-0.5 rounded ${enabled ? "bg-green-500/15 text-green-600" : "bg-muted text-muted-foreground"}`}>
            {enabled ? "录制中" : "已暂停"}
          </span>
        </div>
        <div className="flex items-center gap-1">
          {enabled ? (
            <Button size="sm" variant="outline" className="h-7 text-[10px]" onClick={onDisable}>
              暂停
            </Button>
          ) : (
            <Button size="sm" variant="outline" className="h-7 text-[10px]" onClick={onEnable}>
              开始录制
            </Button>
          )}
          <Button size="sm" variant="ghost" className="h-7 text-[10px]" onClick={onClear} disabled={entries.length === 0}>
            <Trash2 className="h-3 w-3 mr-1" />清空
          </Button>
          <Button size="sm" variant="ghost" className="h-7 text-[10px]" onClick={onCopy} disabled={entries.length === 0}>
            <Copy className="h-3 w-3 mr-1" />复制
          </Button>
          <Button size="icon" variant="ghost" className="h-7 w-7" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>
      {/* Log entries */}
      <div ref={listRef} className="flex-1 overflow-auto p-2 font-mono text-[10px] leading-relaxed">
        {entries.length === 0 && (
          <div className="text-center text-muted-foreground py-8">
            点击"开始录制"以收集诊断事件
          </div>
        )}
        {entries.map((e, i) => (
          <div key={i} className="flex gap-2 py-0.5 border-b border-border/30">
            <span className="text-muted-foreground/60 shrink-0 w-16 text-right">
              {(e.ts / 1000).toFixed(3)}s
            </span>
            <span className={`shrink-0 w-[9.5rem] ${
              e.source === "session_event" ? "text-blue-600 dark:text-blue-400" :
              e.source === "session_user_msg" ? "text-purple-600 dark:text-purple-400" :
              e.source === "session_done" ? "text-green-600 dark:text-green-400" :
              e.source === "session_created" ? "text-cyan-600 dark:text-cyan-400" :
              e.source === "_doSend" ? "text-amber-600 dark:text-amber-400" :
              e.source === "loadHistory" ? "text-orange-600 dark:text-orange-400" :
              e.source === "render" ? "text-rose-600 dark:text-rose-400" :
              "text-muted-foreground"
            }`}>
              {e.source}
            </span>
            <span className="text-foreground break-all">{e.detail}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
