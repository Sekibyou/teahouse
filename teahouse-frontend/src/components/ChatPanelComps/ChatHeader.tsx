import { useState, useCallback } from "react"
import { useTranslation } from "react-i18next"
import { ChevronRight, PanelLeftClose, Plus, Menu, Cpu, Puzzle, Bot, PenLine, RefreshCw, GitCommitHorizontal, Dices, Feather } from "lucide-react"
import { Switch } from "@/components/ui/switch"
import { useIsMobile } from "@/hooks/useMediaQuery"
import { useDialogBackClose } from "@/hooks/useDialogBackClose"
import type { ContextUsage } from "@/lib/types"
import { ContextUsageBar } from "./ContextUsageBar"

// DM（运行时导演）单例会话 id —— 与后端 sessions.DM_SESSION_ID 保持一致。
const DM_SID = "dm"

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

  // DM（运行时导演）是否可用（实例存在 dm.yaml）。DM 与主/子会话完全独立，故它不是
  // 会话列表的一项，而是顶部「导演 | DM」二段式 tab 的另一个模式。
  dmAvailable: boolean
  onSwitchPanelMode: (mode: "director" | "dm") => void

  // Auto commit
  autoApproveCommit: boolean
  onAutoApproveChange: (checked: boolean) => void

  // 收起/关闭导演栏（移动端关闭全屏面板，宽屏折叠面板）。可选——不传则不显示。
  onClosePanel?: () => void

  // 移动端标题行右上角的上下文用量（含盲文进度条）。可选——仅移动端渲染在标题行。
  usage?: ContextUsage | null
}

const EFFORT_LABEL: Record<string, string> = { none: "effort.none", low: "effort.low", mid: "effort.mid", high: "effort.high", max: "effort.max" }

// 抽屉滑动进出动画时长（与下方 Tailwind duration 保持一致）
const DRAWER_ANIM_MS = 200

// 「导演 | DM」二段式切换 tab（仅桌面端标题行）—— 视觉照抄顶栏的「游玩/后台」分段控件。
// DM 与主/子会话是相互独立的两条线路，切换即整块面板（消息区、输入、模型槽）换轨。
// 移动端不用 tab：那边由顶部复合触发器 + 抽屉里的两个分组承担切换。
function PanelModeTab({
  mode,
  dmAvailable,
  directorHasNew,
  dmHasNew,
  onSwitch,
}: {
  mode: "director" | "dm"
  dmAvailable: boolean
  directorHasNew: boolean
  dmHasNew: boolean
  onSwitch: (mode: "director" | "dm") => void
}) {
  const { t } = useTranslation("chat")
  const seg = (on: boolean) =>
    `relative px-4 py-1.5 text-sm font-medium transition-colors ${
      on ? "bg-primary text-primary-foreground" : "hover:bg-muted text-muted-foreground"
    }`
  const iconCls = "h-4 w-4 inline mr-1 align-[-2px]"
  const dot = <span className="absolute top-0.5 right-0.5 h-1.5 w-1.5 rounded-full bg-red-500" />
  return (
    <div className="flex items-center rounded-md border border-border overflow-hidden shrink-0">
      <button className={seg(mode === "director")} onClick={() => onSwitch("director")}>
        <Feather className={iconCls} />
        {t("directorTitle")}
        {directorHasNew && dot}
      </button>
      {dmAvailable && (
        <button className={seg(mode === "dm")} onClick={() => onSwitch("dm")}>
          <Dices className={iconCls} />
          {t("dmConsole")}
          {dmHasNew && dot}
        </button>
      )}
    </div>
  )
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
  onCreateSession,
  instId,
  dmAvailable,
  onSwitchPanelMode,
  autoApproveCommit,
  onAutoApproveChange,
  onClosePanel,
  usage,
}: ChatHeaderProps) {
  const { t } = useTranslation("chat")
  const isMobile = useIsMobile()

  // ── 导演 / DM 模式 ────────────────────────────────────────────────────
  // activeSid 即模式：="dm" 就是 DM 轨，其余都是导演轨（主会话或某个子会话）。
  const isDmMode = activeSid === DM_SID
  const panelMode: "director" | "dm" = isDmMode ? "dm" : "director"
  // 会话标签栏 / 抽屉「导演」分组只列主会话与子会话——DM 不在其中。
  const directorSessions = sessionList.filter((s) => s.session_id !== DM_SID)
  // tab 红点：只在看另一边时点，同一侧由会话标签栏自己的圆点负责。
  const directorHasNew = isDmMode && directorSessions.some((s) => newMsgMap[s.session_id])
  const dmHasNew = !isDmMode && !!newMsgMap[DM_SID]

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
  useDialogBackClose(menuOpen, closeMenu, { route: "/workspace", kind: "director_menu" })

  // ── 移动端：功能收进左上角全高左滑菜单 ─────────────────────────────────
  if (isMobile) {
    // 当前导演会话名（DM 轨不显示会话名——DM 是单例，标题即模式名）
    const activeLabel = (() => {
      const s = directorSessions.find((x) => x.session_id === activeSid)
      if (!s) return null
      return s.session_id === MAIN_SID
        ? t("mainSession")
        : t("sessionItem", { sid: s.session_id.replace("session-", "") })
    })()

    return (
      <div className="p-3 border-b border-border shrink-0">
        <div className="flex items-center justify-between gap-2">
          {/* 左侧：抽屉触发器（模式 icon + 「导演 · 会话名」/「DM」+ 三横线，复合成一个按钮）+ 上下文用量。
              导演/DM 的切换在抽屉里的两个分组（移动端不放 tab）。 */}
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <button
              className="flex items-center gap-1.5 min-w-0 rounded hover:bg-muted px-1 py-1 transition-colors"
              onClick={() => (menuOpen ? closeMenu() : openMenu())}
              title={t("moreActions")}
            >
              {isDmMode ? (
                <Dices className="h-4 w-4 shrink-0" />
              ) : (
                <Feather className="h-4 w-4 shrink-0" />
              )}
              <span className="text-sm font-semibold truncate">
                {isDmMode ? (
                  t("dmConsole")
                ) : (
                  <>
                    {t("directorTitle")}
                    {activeLabel && <span className="text-muted-foreground font-normal"> · {activeLabel}</span>}
                  </>
                )}
                {directorHasNew && <span className="ml-1 inline-block h-2 w-2 rounded-full bg-red-500 align-middle" />}
              </span>
              <Menu className="h-4 w-4 text-muted-foreground shrink-0" />
            </button>

            {usage && usage.threshold != null && usage.used_tokens != null && (
              <div className="text-[10px] text-muted-foreground min-w-0 overflow-hidden">
                <ContextUsageBar usage={usage} textFirst />
              </div>
            )}
          </div>

          {/* 右上角：仅游玩临时导演栏形态提供关闭钮（关闭即隐藏回游玩）；外层 director tab 页留空 */}
          {onClosePanel ? (
            <button
              className="p-2 -mr-2 rounded hover:bg-muted text-muted-foreground shrink-0 transition-colors"
              onClick={() => { if (menuOpen) closeMenu(); else onClosePanel() }}
              title={t("closePanelMobile")}
            >
              <ChevronRight className="h-5 w-5" />
            </button>
          ) : (
            <div className="w-8 shrink-0" />
          )}
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
              {/* 上区：导演会话（主会话 + 子会话，DM 不在其中）——占满剩余高度、可滚动。
                  会话一律渲染为胶囊。 */}
              <div className="min-h-0 flex-1 overflow-y-auto py-2">
                <div className="flex items-center justify-between px-3 pb-1">
                  <span className="flex items-center gap-1.5 text-sm font-semibold">
                    <Feather className="h-3.5 w-3.5" />
                    {t("directorTitle")}
                  </span>
                  {instId && (
                    <button
                      className="flex items-center justify-center p-1 text-muted-foreground hover:bg-muted hover:text-foreground rounded"
                      onClick={() => { onRefreshSessionList(); closeMenu() }}
                      title={t("refreshSessionListTitle")}
                    >
                      <RefreshCw className="h-4 w-4" />
                    </button>
                  )}
                </div>
                {instId && (
                  <button
                    className="w-[90%] mx-auto flex items-center justify-center gap-1.5 px-3 py-2.5 text-sm rounded-full bg-primary/15 text-primary font-medium hover:bg-primary/25 mb-3"
                    onClick={() => { onCreateSession(); closeMenu() }}
                  >
                    <Plus className="h-4 w-4 shrink-0" />
                    <span className="truncate">{t("newSubSessionTitle")}</span>
                  </button>
                )}
                {directorSessions.map((s) => {
                  const active = s.session_id === activeSid
                  const hasNew = !!newMsgMap[s.session_id]
                  const isMain = s.session_id === MAIN_SID
                  const label = isMain
                    ? t("mainSession")
                    : t("sessionItem", { sid: s.session_id.replace("session-", "") })
                  return (
                    <button
                      key={s.session_id}
                      className={`w-[90%] mx-auto flex items-center gap-2 px-4 py-2.5 text-sm rounded-full ${
                        active
                          ? "bg-primary text-primary-foreground font-medium"
                          : "bg-muted/60 text-muted-foreground hover:bg-muted"
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

              {/* 下区常驻一：DM（与导演会话相互独立的一条线路，故自己成组、不混入上面的会话列表；
                  实例只有一个 DM 会话，故组内只有一个胶囊） */}
              {dmAvailable && (
                <div className="border-t border-border py-2">
                  <div className="flex items-center gap-1.5 px-3 pb-1 text-sm font-semibold">
                    <Dices className="h-3.5 w-3.5" />
                    {t("dmConsole")}
                  </div>
                  <button
                    className={`w-[90%] mx-auto flex items-center gap-2 px-4 py-2.5 text-sm rounded-full ${
                      isDmMode
                        ? "bg-primary text-primary-foreground font-medium"
                        : "bg-muted/60 text-muted-foreground hover:bg-muted"
                    }`}
                    onClick={() => { onSwitchPanelMode("dm"); closeMenu() }}
                  >
                    <span className="flex-1 text-left truncate">{t("dmConsole")}</span>
                    {isDmMode && <span className="text-[10px] shrink-0">{t("current")}</span>}
                    {dmHasNew && <span className="h-2 w-2 rounded-full bg-red-500 shrink-0" />}
                  </button>
                </div>
              )}

              {/* 下区常驻二：设置（贴底，并入模型/配置/自动提交） */}
              <div className="border-t border-border px-3 py-2">
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
                <button
                  type="button"
                  role="switch"
                  aria-checked={autoApproveCommit}
                  className="w-full flex items-center gap-2 px-3 py-2.5 text-sm hover:bg-muted rounded-md"
                  onClick={() => onAutoApproveChange(!autoApproveCommit)}
                >
                  <GitCommitHorizontal className="h-4 w-4 text-muted-foreground shrink-0" />
                  <span className="flex-1 text-left">{t("autoCommit")}</span>
                  <span className="pointer-events-none" aria-hidden>
                    <Switch checked={autoApproveCommit} />
                  </span>
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    )
  }

  // ── 桌面端：完整头部 ────────────────────────────────────────────────────
  return (
    <div className="shrink-0 border-b border-border">
      {/* Row 1: 内联收起按钮 + 导演/DM tab（都在左侧）+ 信息区 */}
      <div className="flex items-center justify-between px-3 pt-2 pb-1 bg-muted/20">
        <div className="flex items-center gap-1.5">
          {onClosePanel && (
            <button
              className="p-1 rounded hover:bg-muted text-muted-foreground transition-colors"
              onClick={onClosePanel}
              title={t("collapsePanel")}
            >
              <PanelLeftClose className="h-3.5 w-3.5" />
            </button>
          )}
          <PanelModeTab
            mode={panelMode}
            dmAvailable={dmAvailable}
            directorHasNew={directorHasNew}
            dmHasNew={dmHasNew}
            onSwitch={onSwitchPanelMode}
          />
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
      {/* 会话标签栏（仅导演轨）：仿文件编辑器标签——激活强调色、贴底、仅上方圆角。加号紧跟最右标签。
          DM 轨整行不渲染——DM 与主/子会话是相互独立的线路，顶部的二段 tab 才是它的入口。 */}
      {!isDmMode && (
        <div className="flex items-end gap-1.5 px-2 bg-muted/20">
          <div className="flex items-end gap-1.5 flex-1 min-w-0 overflow-x-auto">
            {directorSessions.map((s) => {
              const active = s.session_id === activeSid
              const hasNew = !!newMsgMap[s.session_id]
              const isMain = s.session_id === MAIN_SID
              const label = isMain
                ? t("mainSession")
                : t("sessionItem", { sid: s.session_id.replace("session-", "") })
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
      )}
    </div>
  )
}
