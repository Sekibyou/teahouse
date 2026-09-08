import { useState, useCallback } from "react"
import { useTranslation } from "react-i18next"
import { ChevronDown, PanelLeftClose, Plus, Menu, Cpu, Puzzle, Bot, PenLine, RefreshCw, GitCommitHorizontal } from "lucide-react"
import { Switch } from "@/components/ui/switch"
import { useIsMobile } from "@/hooks/useMediaQuery"
import { useDialogBackClose } from "@/hooks/useDialogBackClose"
import { ContextUsageBar } from "./ContextUsageBar"
import type { FloorsStats, ContextUsage } from "@/lib/types"

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

  // Auto commit
  autoApproveCommit: boolean
  onAutoApproveChange: (checked: boolean) => void

  // 楼层统计 + 上下文用量（移动端头部右上角精简展示，桌面端仍走底部 footer）
  floorsStats: FloorsStats | null
  contextUsage: ContextUsage | null

  // 收起/关闭导演栏（移动端关闭全屏面板，宽屏折叠面板）。可选——不传则不显示。
  onClosePanel?: () => void
}

const EFFORT_LABEL: Record<string, string> = { none: "effort.none", low: "effort.low", mid: "effort.mid", high: "effort.high", max: "effort.max" }

// 抽屉滑动进出动画时长（与下方 Tailwind duration 保持一致）
const DRAWER_ANIM_MS = 200

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
  autoApproveCommit,
  onAutoApproveChange,
  floorsStats,
  contextUsage,
  onClosePanel,
}: ChatHeaderProps) {
  const { t } = useTranslation("chat")
  const isMobile = useIsMobile()

  // 抽屉两阶段显隐：menuOpen = 意图（立即反映到标题/返回），renderDrawer = DOM 是否挂载。
  // 关闭时保留 DOM 一段动画时长播放退场，结束后才真正卸载（closing 用于挂退场类）。
  const [menuOpen, setMenuOpen] = useState(false)
  const [renderDrawer, setRenderDrawer] = useState(false)
  const [closing, setClosing] = useState(false)

  const openMenu = useCallback(() => {
    setMenuOpen(true)
    setClosing(false)
    setRenderDrawer(true)
  }, [])
  const closeMenu = useCallback(() => {
    setMenuOpen(false)
    setClosing(true)
    window.setTimeout(() => setRenderDrawer(false), DRAWER_ANIM_MS)
  }, [])

  // 抽屉挂载或打开时系统返回（物理返回键/手势/轻扫）优先收起抽屉
  useDialogBackClose(menuOpen, closeMenu)

  // ── 移动端：功能收进左上角全高左滑菜单 ─────────────────────────────────
  if (isMobile) {
    const activeLabel = (() => {
      const s = sessionList.find((x) => x.session_id === activeSid)
      if (!s) return null
      return s.session_id === MAIN_SID
        ? t("mainSession")
        : t("sessionItem", { sid: s.session_id.replace("session-", "") })
    })()

    return (
      <div className="p-3 border-b border-border shrink-0">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-0.5 min-w-0">
            {onClosePanel && (
              <button
                className="p-1 rounded hover:bg-muted text-muted-foreground transition-colors shrink-0"
                onClick={() => { if (menuOpen) closeMenu(); else onClosePanel() }}
                title={t("closePanelMobile")}
              >
                <ChevronDown className="h-4 w-4" />
              </button>
            )}
            {/* 左上标题即抽屉触发器 */}
            <button
              className="flex items-center gap-1.5 min-w-0 rounded hover:bg-muted px-1 py-1 transition-colors"
              onClick={() => (menuOpen ? closeMenu() : openMenu())}
              title={t("moreActions")}
            >
              <span className="text-sm font-semibold truncate">
                {t("directorTitle")}
                {activeLabel && <span className="text-muted-foreground font-normal"> · {activeLabel}</span>}
              </span>
              <Menu className="h-4 w-4 text-muted-foreground shrink-0" />
            </button>
          </div>

          <div className="flex items-center gap-2 min-w-0 shrink-0">
            {((floorsStats && floorsStats.latest_floor != null) || (contextUsage && contextUsage.threshold != null)) && (
              <div className="flex items-center gap-2 text-[10px] text-muted-foreground min-w-0">
                {floorsStats && floorsStats.latest_floor != null && (
                  <span className="font-mono whitespace-nowrap shrink-0">
                    {t("floorStats")}<span className="text-foreground">{String(floorsStats.latest_floor).padStart(3, '0')}</span>
                  </span>
                )}
                {contextUsage && contextUsage.threshold != null && (
                  <ContextUsageBar usage={contextUsage} />
                )}
              </div>
            )}
          </div>
        </div>

        {/* 左滑全高菜单（抽屉） */}
        {renderDrawer && (
          <>
            <div
              className={`fixed inset-0 z-40 bg-black/40 backdrop-blur-sm ${
                closing ? "animate-out fade-out duration-200 fill-mode-forwards" : "animate-in fade-in duration-200"
              }`}
              onClick={closeMenu}
            />
            <div
              className={`fixed inset-y-0 left-0 z-50 w-[78%] max-w-sm bg-background border-r border-border shadow-lg flex flex-col ${
                closing
                  ? "animate-out slide-out-to-left duration-200 fill-mode-forwards"
                  : "animate-in slide-in-from-left duration-200"
              }`}
            >
              {/* 上区：会话（向上对齐，过多时可滚动） */}
              <div className="min-h-0 overflow-y-auto py-2">
                <div className="flex items-center justify-between px-3 pb-1">
                  <span className="text-sm font-semibold">{t("sessionGroup")}</span>
                  {instId && (
                    <div className="flex items-center gap-1">
                      <button
                        className="flex items-center justify-center gap-1 px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground rounded"
                        onClick={() => { onCreateSession(); closeMenu() }}
                        title={t("newSubSessionTitle")}
                      >
                        <Plus className="h-4 w-4" />
                      </button>
                      <button
                        className="flex items-center justify-center gap-1 px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground rounded"
                        onClick={() => { onRefreshSessionList(); closeMenu() }}
                        title={t("refresh")}
                      >
                        <RefreshCw className="h-4 w-4" />
                      </button>
                    </div>
                  )}
                </div>
                {sessionList.map((s) => {
                  const active = s.session_id === activeSid
                  const hasNew = !!newMsgMap[s.session_id]
                  const isMain = s.session_id === MAIN_SID
                  const label = isMain ? t("mainSession") : t("sessionItem", { sid: s.session_id.replace("session-", "") })
                  return (
                    <button
                      key={s.session_id}
                      className={`w-full flex items-center gap-2 px-3 py-2.5 text-sm rounded-md ${
                        active
                          ? "bg-primary text-primary-foreground font-medium"
                          : "text-muted-foreground hover:bg-muted"
                      }`}
                      onClick={() => { onSwitchSession(s.session_id); closeMenu() }}
                    >
                      <span className="flex-1 text-left truncate">{label}</span>
                      {active && <span className="text-[10px] shrink-0">{t("current")}</span>}
                      {hasNew && !active && <span className="h-2 w-2 rounded-full bg-red-500 shrink-0" />}
                    </button>
                  )
                })}
              </div>

              {/* 下区：设置（贴底，并入模型/配置/自动提交） */}
              <div className="border-t border-border px-3 py-2 mt-auto">
                <div className="pb-1 text-sm font-semibold">{t("modelConfigGroup")}</div>
                <button
                  className="w-full flex items-center gap-2 px-3 py-2.5 text-sm hover:bg-muted rounded-md"
                  onClick={() => onCycleReasoningEffort()}
                >
                  <Cpu className="h-4 w-4 text-muted-foreground shrink-0" />
                  <span className="flex-1 text-left">{t("thinkingStrength")}</span>
                  <span className="text-xs text-muted-foreground">{t(EFFORT_LABEL[reasoningEffort] ?? reasoningEffort)}</span>
                </button>
                <button
                  className="w-full flex items-center gap-2 px-3 py-2.5 text-sm hover:bg-muted rounded-md"
                  onClick={() => onOpenSettings("plugins")}
                >
                  <Puzzle className="h-4 w-4 text-muted-foreground shrink-0" />
                  <span className="flex-1 text-left">{t("plugins")}</span>
                  <span className="text-xs text-muted-foreground">{enabledPluginCount}</span>
                </button>
                <button
                  className="w-full flex items-center gap-2 px-3 py-2.5 text-sm hover:bg-muted rounded-md"
                  onClick={() => onOpenSettings("slots")}
                >
                  <Bot className="h-4 w-4 text-muted-foreground shrink-0" />
                  <span className="flex-1 text-left">{t("directorModel")}</span>
                  <span className="text-xs text-muted-foreground max-w-[120px] truncate">{slotModels.director || t("unset")}</span>
                </button>
                <button
                  className="w-full flex items-center gap-2 px-3 py-2.5 text-sm hover:bg-muted rounded-md"
                  onClick={() => onOpenSettings("slots")}
                >
                  <PenLine className="h-4 w-4 text-muted-foreground shrink-0" />
                  <span className="flex-1 text-left">{t("writerModel")}</span>
                  <span className="text-xs text-muted-foreground max-w-[120px] truncate">{slotModels.writer || t("unset")}</span>
                </button>
                <div className="w-full flex items-center gap-2 px-3 py-2.5 text-sm">
                  <GitCommitHorizontal className="h-4 w-4 text-muted-foreground shrink-0" />
                  <span className="flex-1 text-left text-muted-foreground">{t("autoCommit")}</span>
                  <Switch checked={autoApproveCommit} onCheckedChange={onAutoApproveChange} />
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    )
  }

  // ── 桌面端：完整头部 ────────────────────────────────────────────────────
  return (
    <div className="shrink-0">
      {/* Row 1: 导演 + 内联收起按钮 + 信息区 */}
      <div className="flex items-center justify-between px-3 pt-2 pb-1 bg-muted/20">
        <div className="flex items-center gap-1.5">
          <h3 className="text-sm font-semibold">{t("directorTitle")}</h3>
          {onClosePanel && (
            <button
              className="p-1 rounded hover:bg-muted text-muted-foreground transition-colors"
              onClick={onClosePanel}
              title={t("collapsePanel")}
            >
              <PanelLeftClose className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <button
            className="flex items-center gap-1 hover:text-foreground transition-colors"
            onClick={onCycleReasoningEffort}
            title={t("thinkingEffortTitle", { effort: reasoningEffort })}
          >
            {t("thinkColon")}<span className="text-foreground font-medium">{t(EFFORT_LABEL[reasoningEffort] ?? reasoningEffort)}</span>
          </button>
          <button
            className="flex items-center gap-1 hover:text-foreground transition-colors"
            onClick={() => onOpenSettings("plugins")}
            title={t("openSettingsPlugins")}
          >
            {t("pluginColon")}<span className="text-foreground font-medium">{enabledPluginCount}</span>
          </button>
          <button
            className="flex items-center gap-1 hover:text-foreground transition-colors"
            onClick={() => onOpenSettings("slots")}
            title={t("openSettingsSlots")}
          >
            {t("directorColon")}<span className="text-foreground font-medium">{slotModels.director || t("unset")}</span>
          </button>
          <div className="flex items-center gap-1.5 border-l border-border pl-3">
            <span>{t("autoCommit")}</span>
            <Switch checked={autoApproveCommit} onCheckedChange={onAutoApproveChange} />
          </div>
        </div>
      </div>
      {/* 会话标签栏：仿文件编辑器标签——激活强调色、贴底、仅上方圆角。加号紧跟最右标签，刷新钉最右 */}
      <div className="flex items-end gap-1.5 px-2 border-b border-border bg-muted/20">
        <div className="flex items-end gap-1.5 flex-1 min-w-0 overflow-x-auto">
          {sessionList.map((s) => {
            const active = s.session_id === activeSid
            const hasNew = !!newMsgMap[s.session_id]
            const isMain = s.session_id === MAIN_SID
            const label = isMain ? t("mainSession") : t("sessionItem", { sid: s.session_id.replace("session-", "") })
            return (
              <div key={s.session_id} className="relative shrink-0 flex items-end">
                <button
                  onClick={() => onSwitchSession(s.session_id)}
                  className={`flex items-center px-2.5 text-xs rounded-t-md h-6 select-none whitespace-nowrap transition-colors ${
                    active ? "bg-primary text-primary-foreground font-medium" : "text-muted-foreground hover:bg-muted"
                  }`}
                >
                  {label}
                </button>
                {/* 有新消息 → 右上角小圆圈 */}
                {hasNew && !active && (
                  <span className="absolute -top-1 right-0.5 h-2 w-2 rounded-full bg-red-500 ring-2 ring-background" />
                )}
              </div>
            )
          })}
          {!instId ? null : (
            <button
              className="shrink-0 self-end mb-1.5 ml-0.5 px-1.5 rounded-md h-5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground transition-colors flex items-center"
              onClick={onCreateSession}
              title={t("newSubSessionTitle")}
            >
              <Plus className="h-3 w-3" />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
