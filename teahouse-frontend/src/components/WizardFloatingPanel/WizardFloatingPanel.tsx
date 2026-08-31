import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { Sparkles, ChevronUp, X, Check, SkipForward, Circle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { StepCircle, type CircleState } from "@/components/WelcomeWizard/WelcomeWizard"
import { WIZARD_STEPS } from "@/components/WelcomeWizard/steps"
import { loadLitSteps, saveLitSteps } from "@/components/WelcomeWizard/progressMemory"
import { useIsMobile, useMediaQuery } from "@/hooks/useMediaQuery"
import { useSetupStatus } from "@/hooks/useSetupStatus"
import { useSettingsDialogStore } from "@/stores/settingsDialogStore"

/**
 * 设置弹窗打开时的悬浮跟随向导面板。
 *
 * 复用 WelcomeWizard 的 StepCircle（暗金呼吸背光 + 点亮庆祝特效）与
 * WIZARD_STEPS / useSetupStatus / progressMemory，保证外观与整屏向导完全统一，
 * 只是在弹窗旁以紧凑形式跟随指示「接下来要做什么」。
 *
 * 布局：
 * - 桌面宽屏（≥1650px）：左侧悬浮 side panel（z-[60]，位于弹窗 modal 左侧留白）。
 * - 移动端 / 窄桌面：左下角纵向窄条 trigger（5 个状态点缩略进度 + 「展开」按钮），
 *   点击展开浮动面板（z-[70]，点外部 / 收起按钮 / 点「去配置」收起）。
 *
 * 仅当弹窗打开且模型体系未配好（!complete）时显示；配好即消失。
 */
export function WizardFloatingPanel() {
  const { t } = useTranslation("misc")
  const isMobile = useIsMobile()
  const wide = useMediaQuery("(min-width: 1720px)")
  const openSettings = useSettingsDialogStore((s) => s.openSettings)
  const { loading, complete, skipped, skipStep, ...ready } = useSetupStatus()
  const [expanded, setExpanded] = useState(false)

  // ── 点亮庆祝：与 WelcomeWizard 同款差集逻辑（上次亮过的项本次不重复闪）──
  const [prevLit] = useState(loadLitSteps)
  const [celebrations, setCelebrations] = useState<Record<string, number>>({})
  const firstBatchRef = useRef<string[] | null>(null)
  if (!loading && firstBatchRef.current === null) {
    firstBatchRef.current = WIZARD_STEPS
      .filter((s) => ready[s.key] && !prevLit[s.key])
      .map((s) => s.key as string)
  }
  const doneKeys = WIZARD_STEPS.filter((s) => ready[s.key]).map((s) => s.key as string)
  const doneSig = doneKeys.join(",")

  useEffect(() => {
    if (loading) return
    saveLitSteps(doneKeys)
    setCelebrations((prev) => {
      let changed = false
      const next = { ...prev }
      for (const s of WIZARD_STEPS) {
        const k = s.key as string
        if (!ready[s.key] || prevLit[k] || next[k] !== undefined) continue
        const idx = firstBatchRef.current?.indexOf(k) ?? -1
        next[k] = idx >= 0 ? 0.3 + idx * 0.22 : 0
        changed = true
      }
      return changed ? next : prev
    })
  }, [loading, doneSig]) // eslint-disable-line react-hooks/exhaustive-deps

  // 加载中或已配好：不显示面板
  if (loading || complete) return null

  const doneCount = WIZARD_STEPS.filter((s) => ready[s.key] || skipped[s.key]).length
  const total = WIZARD_STEPS.length

  const collapse = () => setExpanded(false)

  // ── 展开面板（移动端 / 窄桌面共用）──
  const checklist = (
    <div className="flex flex-col gap-1">
      {WIZARD_STEPS.map((s, i) => {
        const done = ready[s.key]
        const isSkipped = !!skipped[s.key]
        const state: CircleState = done ? "done" : isSkipped ? "skipped" : "pending"
        const actionText = s.actionLabelKey ? t(s.actionLabelKey) : t("wizard.goConfig")
        return (
          <div key={s.key} className="flex items-center gap-2.5 px-2 py-2 -mx-2">
            <StepCircle state={state} celebrateDelay={celebrations[s.key] ?? null} breathDelay={i * 0.4} />
            <span className={`flex-1 min-w-0 text-xs truncate ${done ? "text-muted-foreground" : "text-foreground"}`}>
              {t(s.titleKey)}
            </span>
            {!done && (
              <div className="flex items-center gap-1 shrink-0">
                {isSkipped ? (
                  <span className="text-[10px] text-muted-foreground">{t("wizard.skipped")}</span>
                ) : (
                  <>
                    {s.skippable && (
                      <Button size="sm" variant="ghost" className="h-7 px-1.5 text-xs text-muted-foreground" onClick={() => skipStep(s.key)}>
                        {t("wizard.skip")}
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 px-2.5 text-xs gap-1"
                      onClick={() => { openSettings(s.tab); collapse() }}
                    >
                      {actionText}
                    </Button>
                  </>
                )}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )

  const progressBar = (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1 rounded-full bg-muted overflow-hidden">
        <div className="h-full rounded-full bg-primary" style={{ width: `${(doneCount / total) * 100}%` }} />
      </div>
      <span className="text-[10px] text-muted-foreground whitespace-nowrap">
        {t("wizard.doneCount", { done: doneCount, total })}
      </span>
    </div>
  )

  // ── 桌面宽屏：左侧悬浮 side panel ──
  if (!isMobile && wide) {
    return (
      <div className="fixed left-4 top-1/2 -translate-y-1/2 w-72 z-[60]">
        <div className="rounded-xl border bg-card p-4 shadow-2xl flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-medium flex items-center gap-1.5">
              <Sparkles className="h-3.5 w-3.5 text-primary" />
              {t("wizard.panelTitle")}
            </h4>
          </div>
          {progressBar}
          {checklist}
        </div>
      </div>
    )
  }

  // ── 移动端 / 窄桌面：纵向窄条 trigger + 展开面板 ──
  return (
    <>
      {/* 展开面板（盖在弹窗内容之上，点外部 / 收起 / 去配置 关闭） */}
      {expanded && (
        <>
          <div className="fixed inset-0 z-[65]" onClick={collapse} />
          <div className="fixed bottom-5 left-16 w-[min(calc(100vw-6rem),360px)] max-h-[62vh] overflow-y-auto rounded-xl border bg-card p-3 shadow-2xl z-[80] flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <h4 className="text-sm font-medium flex items-center gap-1.5">
                <Sparkles className="h-3.5 w-3.5 text-primary" />
                {t("wizard.panelTitle")}
              </h4>
              <Button size="icon" variant="ghost" className="h-7 w-7" onClick={collapse} aria-label={t("wizard.panelCloseAria")}>
                <X className="h-4 w-4" />
              </Button>
            </div>
            {progressBar}
            {checklist}
          </div>
        </>
      )}

      {/* 纵向窄条 trigger：5 个状态点（缩略进度）+ 展开按钮。整体可点击触发 */}
      <button
        type="button"
        className="fixed bottom-5 left-4 z-[70] flex flex-col items-center gap-2 rounded-full border bg-card pt-4 pb-2 px-2 shadow-xl cursor-pointer transition-colors hover:bg-muted/40"
        onClick={() => setExpanded((v) => !v)}
        aria-label={t("wizard.panelTriggerAria")}
      >
        <span className="flex flex-col gap-1.5">
          {WIZARD_STEPS.map((s) => {
            const state: CircleState = ready[s.key] ? "done" : skipped[s.key] ? "skipped" : "pending"
            return <MiniDot key={s.key} state={state} />
          })}
        </span>
        <span className="flex items-center justify-center h-6 w-6 rounded-full text-primary transition-transform">
          {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronUp className="h-4 w-4 rotate-180" />}
        </span>
      </button>
    </>
  )
}

/** 窄条 trigger 上的静态状态点：同一套 primary/muted 配色缩略呈现进度，不用完整呼吸动画 */
function MiniDot({ state }: { state: CircleState }) {
  const cls =
    state === "done"
      ? "bg-primary text-primary-foreground"
      : state === "skipped"
        ? "bg-muted text-muted-foreground"
        : "bg-muted/60 text-muted-foreground ring-1 ring-border"
  return (
    <span className={`flex items-center justify-center h-2.5 w-2.5 rounded-full transition-colors ${cls}`}>
      {state === "done" && <Check className="h-2 w-2" />}
      {state === "skipped" && <SkipForward className="h-2 w-2" />}
      {state === "pending" && <Circle className="h-2 w-2" />}
    </span>
  )
}
