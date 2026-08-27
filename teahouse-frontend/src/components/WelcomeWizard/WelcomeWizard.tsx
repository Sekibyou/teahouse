import { Loader2, Check, Circle, Sparkles, SkipForward } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useSettingsDialogStore } from "@/stores/settingsDialogStore"
import { useSetupStatus } from "@/hooks/useSetupStatus"
import { WIZARD_STEPS, type WizardTab } from "./steps"
import { useTranslation } from "react-i18next"

function StepRow({
  done, skipped, title, desc, actionTab, actionLabel, recommended, onSkip,
}: {
  done: boolean
  /** 没真做，但用户点了「跳过」——按完成计入进度，标记上仍如实标注 */
  skipped?: boolean
  title: string
  desc: string
  actionTab: WizardTab
  actionLabel?: string
  recommended?: boolean
  onSkip?: () => void
}) {
  const { t } = useTranslation("misc")
  const openSettings = useSettingsDialogStore((s) => s.openSettings)
  const actionText = actionLabel ?? t("wizard.goConfig")
  const settled = done || skipped
  return (
    <div className={`flex items-start gap-3 rounded-xl border px-4 py-3.5 ${settled ? "border-border/60 bg-muted/20" : "border-border bg-card"}`}>
      {settled ? (
        <span className={`mt-0.5 shrink-0 flex items-center justify-center h-6 w-6 rounded-full ${done ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400" : "bg-muted text-muted-foreground"}`}>
          {done ? <Check className="h-4 w-4" /> : <SkipForward className="h-3.5 w-3.5" />}
        </span>
      ) : (
        <span className="mt-0.5 shrink-0 flex items-center justify-center h-6 w-6 rounded-full bg-muted text-muted-foreground">
          <Circle className="h-4 w-4" />
        </span>
      )}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-medium text-sm">{title}</span>
          {recommended && !settled && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground shrink-0">{t("wizard.recommended")}</span>
          )}
          {!done && skipped && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground shrink-0">{t("wizard.skipped")}</span>
          )}
        </div>
        <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">{desc}</p>
      </div>
      {!settled && (
        <div className="shrink-0 flex items-center gap-1.5">
          {onSkip && (
            <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={onSkip}>
              {t("wizard.skip")}
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5"
            onClick={() => openSettings(actionTab)}
          >
            {actionText}
          </Button>
        </div>
      )}
    </div>
  )
}

export function WelcomeWizard() {
  const { t } = useTranslation("misc")
  const { loading, complete, skipped, skipStep, ...ready } = useSetupStatus()

  // 跳过的推荐项也算一格：进度分母恒为全部步骤数（x/5）
  const doneCount = WIZARD_STEPS.filter((s) => ready[s.key] || skipped[s.key]).length
  const total = WIZARD_STEPS.length

  return (
    <div className="h-full overflow-y-auto flex items-center justify-center px-4 py-10">
      <div className="w-full max-w-lg flex flex-col gap-5 py-6">
        <div className="text-center">
          <div className="inline-flex items-center justify-center h-12 w-12 rounded-2xl bg-primary/10 text-primary mb-3">
            <Sparkles className="h-6 w-6" />
          </div>
          <h2 className="text-lg font-serif font-bold">{t("wizard.welcomeTitle")}</h2>
          <p className="text-xs text-muted-foreground mt-1.5 leading-relaxed max-w-sm mx-auto">
            {t("wizard.welcomeDesc")}
            {complete && t("wizard.welcomeComplete")}
          </p>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-10">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <>
            {/* 进度 */}
            <div className="flex items-center gap-3">
              <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
                <div
                  className="h-full bg-primary transition-all duration-500"
                  style={{ width: `${(doneCount / total) * 100}%` }}
                />
              </div>
              <span className="text-xs text-muted-foreground whitespace-nowrap">
                {t("wizard.doneCount", { done: doneCount, total })}
              </span>
            </div>

            {/* 清单：硬门槛 + 推荐项（推荐项可跳过，跳过也前进一格） */}
            <div className="space-y-2">
              {WIZARD_STEPS.map((s) => (
                <StepRow
                  key={s.key}
                  done={ready[s.key]}
                  skipped={!!skipped[s.key]}
                  title={t(s.titleKey)}
                  desc={t(s.descKey)}
                  actionTab={s.tab}
                  actionLabel={s.actionLabelKey ? t(s.actionLabelKey) : undefined}
                  recommended={s.skippable}
                  onSkip={s.skippable ? () => skipStep(s.key) : undefined}
                />
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
