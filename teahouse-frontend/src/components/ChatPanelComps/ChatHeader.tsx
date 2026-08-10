import { GitBranch as GitBranchIcon, Edit3 } from "lucide-react"
import { Switch } from "@/components/ui/switch"

interface ChangeCounts {
  added: number
  modified: number
  deleted: number
}

interface ChatHeaderProps {
  // Slot models
  slotModels: Record<string, string | null>
  enabledPluginCount: number
  onOpenSettings: (tab: string) => void

  // Reasoning effort (thinking strength) of the active session
  reasoningEffort: string
  onCycleReasoningEffort: () => void

  // Session strip
  MAIN_SID: string
  sessionList: { session_id: string; record_count: number }[]
  activeSid: string
  newMsgMap: Record<string, boolean>
  onSwitchSession: (sid: string) => void
  onRefreshSessionList: () => void
  instId: string | null

  // Git info
  currentBranch: string
  latestCommitMsg: string | null
  changeCounts: ChangeCounts
  onOpenGitDialog: () => void

  // Auto commit
  autoApproveCommit: boolean
  onAutoApproveChange: (checked: boolean) => void
}

export function ChatHeader({
  slotModels,
  enabledPluginCount,
  onOpenSettings,
  reasoningEffort,
  onCycleReasoningEffort,
  MAIN_SID,
  sessionList,
  activeSid,
  newMsgMap,
  onSwitchSession,
  onRefreshSessionList,
  instId,
  currentBranch,
  latestCommitMsg,
  changeCounts,
  onOpenGitDialog,
  autoApproveCommit,
  onAutoApproveChange,
}: ChatHeaderProps) {
  return (
    <div className="p-3 border-b border-border shrink-0 space-y-2">
      {/* Row 1: 导演 + enabled plugin count + model names */}
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">导演</h3>
        <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
          <button
            className="flex items-center gap-1 hover:text-foreground transition-colors"
            onClick={onCycleReasoningEffort}
            title={`思考强度：${reasoningEffort}（点击轮换 none|low|mid|high|max）`}
          >
            思考：<span className="text-foreground font-medium">
              {({ none: "无", low: "低", mid: "中", high: "高", max: "极" } as Record<string, string>)[reasoningEffort] ?? reasoningEffort}
            </span>
          </button>
          <button
            className="flex items-center gap-1 hover:text-foreground transition-colors"
            onClick={() => onOpenSettings("plugins")}
            title="打开设置→插件管理"
          >
            插件：<span className="text-foreground font-medium">{enabledPluginCount}</span>
          </button>
          <button
            className="flex items-center gap-1 hover:text-foreground transition-colors"
            onClick={() => onOpenSettings("slots")}
            title="打开设置→槽位指定"
          >
            导演：<span className="text-foreground font-medium">{slotModels.director || "未设置"}</span>
          </button>
          <button
            className="flex items-center gap-1 hover:text-foreground transition-colors"
            onClick={() => onOpenSettings("slots")}
            title="打开设置→槽位指定"
          >
            正文：<span className="text-foreground font-medium">{slotModels.writer || "未设置"}</span>
          </button>
        </div>
      </div>
      {/* Session strip: main + child sub-sessions. Click to switch the panel. */}
      <div className="flex items-center gap-1.5 flex-wrap">
        {sessionList.map((s) => {
          const active = s.session_id === activeSid
          const hasNew = !!newMsgMap[s.session_id]
          const isMain = s.session_id === MAIN_SID
          const label = isMain ? "主会话" : `会话·${s.session_id.replace("session-", "")}`
          return (
            <button
              key={s.session_id}
              onClick={() => onSwitchSession(s.session_id)}
              className={`relative px-2 py-0.5 rounded text-[10px] border transition-colors ${
                active ? "bg-primary text-primary-foreground border-primary" : "text-muted-foreground border-border hover:bg-accent"
              }`}
            >
              {label}
              {/* 有新消息 → 右上角小圆圈 */}
              {hasNew && !active && (
                <span className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-red-500 ring-2 ring-background" />
              )}
            </button>
          )
        })}
        {!instId ? null : (
          <button
            className="ml-auto px-2 py-0.5 rounded text-[10px] border border-dashed text-muted-foreground hover:text-foreground transition-colors"
            onClick={onRefreshSessionList}
            title="刷新会话列表"
          >
            刷新
          </button>
        )}
      </div>
      {/* Row 2: git info + auto-commit switch */}
      <div className="flex items-center justify-between">
        <div
          className="flex items-center gap-1.5 cursor-pointer hover:bg-muted/50 rounded px-1.5 py-0.5 -ml-1.5 transition-colors flex-1 min-w-0 mr-4"
          onClick={onOpenGitDialog}
          title="打开版本控制"
        >
          <GitBranchIcon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          <span className="text-[10px] font-mono bg-muted px-1.5 py-0.5 rounded text-muted-foreground shrink-0">
            {currentBranch}
          </span>
          {latestCommitMsg && (
            <span className="text-[10px] text-muted-foreground truncate">
              {latestCommitMsg.length > 30 ? latestCommitMsg.slice(0, 30) + "…" : latestCommitMsg}
            </span>
          )}
          {changeCounts.deleted > 0 && (
            <span className="text-[9px] bg-red-500/15 text-red-600 dark:text-red-400 font-medium px-1 py-0.5 rounded leading-none shrink-0">
              -{changeCounts.deleted}
            </span>
          )}
          {changeCounts.modified > 0 && (
            <span className="text-[9px] bg-yellow-500/15 text-yellow-600 dark:text-yellow-400 font-medium px-1 py-0.5 rounded leading-none shrink-0">
              ~{changeCounts.modified}
            </span>
          )}
          {changeCounts.added > 0 && (
            <span className="text-[9px] bg-green-500/15 text-green-600 dark:text-green-400 font-medium px-1 py-0.5 rounded leading-none shrink-0">
              +{changeCounts.added}
            </span>
          )}
          <Edit3 className="h-3 w-3 text-muted-foreground shrink-0" />
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <span className="text-[10px] text-muted-foreground">自动提交</span>
          <Switch
            checked={autoApproveCommit}
            onCheckedChange={onAutoApproveChange}
          />
          <span className="text-[10px] text-muted-foreground w-5 text-right">
            {autoApproveCommit ? "ON" : "OFF"}
          </span>
        </div>
      </div>
    </div>
  )
}
