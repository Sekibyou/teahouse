import { useState } from "react"
import { GitBranch as GitBranchIcon, Edit3, ChevronDown, PanelLeftClose, Plus, Menu, Cpu, Puzzle, Bot, PenLine, RefreshCw } from "lucide-react"
import { Switch } from "@/components/ui/switch"
import { useIsMobile } from "@/hooks/useMediaQuery"
import { ContextUsageBar } from "./ContextUsageBar"
import type { FloorsStats, ContextUsage } from "@/lib/types"

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
  onCreateSession: () => void
  instId: string | undefined

  // Git info
  currentBranch: string
  latestCommitMsg: string | undefined
  changeCounts: ChangeCounts
  onOpenGitDialog: () => void

  // Auto commit
  autoApproveCommit: boolean
  onAutoApproveChange: (checked: boolean) => void

  // 楼层统计 + 上下文用量（移动端头部右上角精简展示，桌面端仍走底部 footer）
  floorsStats: FloorsStats | null
  contextUsage: ContextUsage | null

  // 收起/关闭导演栏（移动端关闭全屏面板，宽屏折叠面板）。可选——不传则不显示。
  onClosePanel?: () => void
}

const EFFORT_LABEL: Record<string, string> = { none: "无", low: "低", mid: "中", high: "高", max: "极" }

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
  onCreateSession,
  instId,
  currentBranch,
  latestCommitMsg,
  changeCounts,
  onOpenGitDialog,
  autoApproveCommit,
  onAutoApproveChange,
  floorsStats,
  contextUsage,
  onClosePanel,
}: ChatHeaderProps) {
  const isMobile = useIsMobile()
  const [menuOpen, setMenuOpen] = useState(false)

  // ── 移动端：功能收进右上角菜单 ──────────────────────────────────────────
  if (isMobile) {
    return (
      <div className="p-3 border-b border-border shrink-0">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 min-w-0">
            {onClosePanel && (
              <button
                className="p-1 -ml-1 rounded hover:bg-muted text-muted-foreground transition-colors"
                onClick={onClosePanel}
                title="收起导演面板"
              >
                <ChevronDown className="h-4 w-4" />
              </button>
            )}
            <h3 className="text-sm font-semibold shrink-0">导演</h3>
          </div>

          <div className="flex items-center gap-2 min-w-0">
            {((floorsStats && floorsStats.latest_floor != null) || (contextUsage && contextUsage.threshold != null)) && (
              <div className="flex items-center gap-2 text-[10px] text-muted-foreground min-w-0">
                {floorsStats && floorsStats.latest_floor != null && (
                  <span className="font-mono whitespace-nowrap shrink-0">
                    楼层<span className="text-foreground">{String(floorsStats.latest_floor).padStart(3, '0')}</span>
                  </span>
                )}
                {contextUsage && contextUsage.threshold != null && (
                  <ContextUsageBar usage={contextUsage} />
                )}
              </div>
            )}

            <div className="relative shrink-0">
            <button
              className="p-2 rounded hover:bg-muted text-muted-foreground transition-colors"
              onClick={() => setMenuOpen((v) => !v)}
              title="更多功能"
            >
              <Menu className="h-5 w-5" />
            </button>

            {menuOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />
                <div className="absolute right-0 top-full mt-1 z-50 bg-background border border-border rounded-md shadow-lg py-1 min-w-[240px] max-h-[70vh] overflow-y-auto">
                  {/* 会话切换 */}
                  <div className="px-3 pt-2 pb-1 text-[10px] text-muted-foreground">会话</div>
                  {sessionList.map((s) => {
                    const active = s.session_id === activeSid
                    const hasNew = !!newMsgMap[s.session_id]
                    const isMain = s.session_id === MAIN_SID
                    const label = isMain ? "主会话" : `会话·${s.session_id.replace("session-", "")}`
                    return (
                      <button
                        key={s.session_id}
                        className={`w-full flex items-center gap-2 px-3 py-2.5 text-sm hover:bg-muted ${
                          active ? "text-foreground font-medium" : "text-muted-foreground"
                        }`}
                        onClick={() => { onSwitchSession(s.session_id); setMenuOpen(false) }}
                      >
                        <span className="flex-1 text-left">{label}</span>
                        {active && <span className="text-[10px] text-primary">当前</span>}
                        {hasNew && !active && <span className="h-2 w-2 rounded-full bg-red-500 shrink-0" />}
                      </button>
                    )
                  })}
                  <div className="flex border-t border-border mt-1">
                    {instId && (
                      <button
                        className="flex-1 flex items-center justify-center gap-1 px-3 py-2 text-xs text-muted-foreground hover:bg-muted"
                        onClick={() => { onCreateSession(); setMenuOpen(false) }}
                      >
                        <Plus className="h-3.5 w-3.5" />
                        新建
                      </button>
                    )}
                    {instId && (
                      <button
                        className="flex-1 flex items-center justify-center gap-1 px-3 py-2 text-xs text-muted-foreground hover:bg-muted"
                        onClick={() => { onRefreshSessionList(); setMenuOpen(false) }}
                      >
                        <RefreshCw className="h-3.5 w-3.5" />
                        刷新
                      </button>
                    )}
                  </div>

                  {/* 模型与配置 */}
                  <div className="px-3 pt-2 pb-1 text-[10px] text-muted-foreground border-t border-border">模型与配置</div>
                  <button
                    className="w-full flex items-center gap-2 px-3 py-2.5 text-sm hover:bg-muted"
                    onClick={() => { onCycleReasoningEffort(); setMenuOpen(false) }}
                  >
                    <Cpu className="h-4 w-4 text-muted-foreground" />
                    <span className="flex-1 text-left">思考强度</span>
                    <span className="text-xs text-muted-foreground">{EFFORT_LABEL[reasoningEffort] ?? reasoningEffort}</span>
                  </button>
                  <button
                    className="w-full flex items-center gap-2 px-3 py-2.5 text-sm hover:bg-muted"
                    onClick={() => { onOpenSettings("plugins"); setMenuOpen(false) }}
                  >
                    <Puzzle className="h-4 w-4 text-muted-foreground" />
                    <span className="flex-1 text-left">插件</span>
                    <span className="text-xs text-muted-foreground">{enabledPluginCount}</span>
                  </button>
                  <button
                    className="w-full flex items-center gap-2 px-3 py-2.5 text-sm hover:bg-muted"
                    onClick={() => { onOpenSettings("slots"); setMenuOpen(false) }}
                  >
                    <Bot className="h-4 w-4 text-muted-foreground" />
                    <span className="flex-1 text-left">导演模型</span>
                    <span className="text-xs text-muted-foreground max-w-[120px] truncate">{slotModels.director || "未设置"}</span>
                  </button>
                  <button
                    className="w-full flex items-center gap-2 px-3 py-2.5 text-sm hover:bg-muted"
                    onClick={() => { onOpenSettings("slots"); setMenuOpen(false) }}
                  >
                    <PenLine className="h-4 w-4 text-muted-foreground" />
                    <span className="flex-1 text-left">正文模型</span>
                    <span className="text-xs text-muted-foreground max-w-[120px] truncate">{slotModels.writer || "未设置"}</span>
                  </button>

                  {/* 版本控制 */}
                  <div className="px-3 pt-2 pb-1 text-[10px] text-muted-foreground border-t border-border">版本控制</div>
                  <button
                    className="w-full flex items-center gap-2 px-3 py-2.5 text-sm hover:bg-muted"
                    onClick={() => { onOpenGitDialog(); setMenuOpen(false) }}
                  >
                    <GitBranchIcon className="h-4 w-4 text-muted-foreground" />
                    <span className="flex-1 text-left font-mono text-xs">{currentBranch}</span>
                    {changeCounts.deleted > 0 && (
                      <span className="text-[9px] bg-red-500/15 text-red-600 dark:text-red-400 font-medium px-1 py-0.5 rounded leading-none shrink-0">-{changeCounts.deleted}</span>
                    )}
                    {changeCounts.modified > 0 && (
                      <span className="text-[9px] bg-yellow-500/15 text-yellow-600 dark:text-yellow-400 font-medium px-1 py-0.5 rounded leading-none shrink-0">~{changeCounts.modified}</span>
                    )}
                    {changeCounts.added > 0 && (
                      <span className="text-[9px] bg-green-500/15 text-green-600 dark:text-green-400 font-medium px-1 py-0.5 rounded leading-none shrink-0">+{changeCounts.added}</span>
                    )}
                    <Edit3 className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  </button>
                  <div className="flex items-center justify-between px-3 py-2.5 text-sm">
                    <span className="text-muted-foreground">自动提交</span>
                    <Switch checked={autoApproveCommit} onCheckedChange={onAutoApproveChange} />
                  </div>
                </div>
              </>
            )}
            </div>
          </div>
        </div>
      </div>
    )
  }

  // ── 桌面端：完整头部 ────────────────────────────────────────────────────
  return (
    <div className="p-3 border-b border-border shrink-0 space-y-2">
      {/* Row 1: 导演 + 内联收起按钮 + 插件/模型信息 */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <h3 className="text-sm font-semibold">导演</h3>
          {onClosePanel && (
            <button
              className="p-1 rounded hover:bg-muted text-muted-foreground transition-colors"
              onClick={onClosePanel}
              title="折叠导演面板"
            >
              <PanelLeftClose className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
          <button
            className="flex items-center gap-1 hover:text-foreground transition-colors"
            onClick={onCycleReasoningEffort}
            title={`思考强度：${reasoningEffort}（点击轮换 none|low|mid|high|max）`}
          >
            思考：<span className="text-foreground font-medium">{EFFORT_LABEL[reasoningEffort] ?? reasoningEffort}</span>
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
            onClick={onCreateSession}
            title="新建子会话"
          >
            <Plus className="h-3 w-3" />
          </button>
        )}
        {!instId ? null : (
          <button
            className="px-2 py-0.5 rounded text-[10px] border border-dashed text-muted-foreground hover:text-foreground transition-colors"
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
