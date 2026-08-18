import { Loader2, Check, Circle, Sparkles } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useSettingsDialogStore } from "@/stores/settingsDialogStore"
import { useSetupStatus } from "@/hooks/useSetupStatus"
import { REQUIRED_STEPS, RECOMMENDED_STEPS, type WizardTab } from "./steps"

function StepRow({
  done, title, desc, actionTab, actionLabel = "去配置", optional,
}: {
  done: boolean
  title: string
  desc: string
  actionTab: WizardTab
  actionLabel?: string
  optional?: boolean
}) {
  const openSettings = useSettingsDialogStore((s) => s.openSettings)
  return (
    <div className={`flex items-start gap-3 rounded-xl border px-4 py-3.5 ${done ? "border-border/60 bg-muted/20" : "border-border bg-card"}`}>
      {done ? (
        <span className="mt-0.5 shrink-0 flex items-center justify-center h-6 w-6 rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
          <Check className="h-4 w-4" />
        </span>
      ) : (
        <span className="mt-0.5 shrink-0 flex items-center justify-center h-6 w-6 rounded-full bg-muted text-muted-foreground">
          <Circle className="h-4 w-4" />
        </span>
      )}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-medium text-sm">{title}</span>
          {optional && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground shrink-0">推荐</span>
          )}
        </div>
        <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">{desc}</p>
      </div>
      {!done && (
        <Button
          size="sm"
          variant="outline"
          className="shrink-0 gap-1.5"
          onClick={() => openSettings(actionTab)}
        >
          {actionLabel}
        </Button>
      )}
    </div>
  )
}

export function WelcomeWizard() {
  const { loading, complete, ...ready } = useSetupStatus()

  const requiredDoneCount = REQUIRED_STEPS.filter((s) => ready[s.key]).length
  const requiredTotal = REQUIRED_STEPS.length

  return (
    <div className="h-full overflow-y-auto flex items-center justify-center px-4 py-10">
      <div className="w-full max-w-lg flex flex-col gap-5 py-6">
        <div className="text-center">
          <div className="inline-flex items-center justify-center h-12 w-12 rounded-2xl bg-primary/10 text-primary mb-3">
            <Sparkles className="h-6 w-6" />
          </div>
          <h2 className="text-lg font-serif font-bold">欢迎来到 Teahouse</h2>
          <p className="text-xs text-muted-foreground mt-1.5 leading-relaxed max-w-sm mx-auto">
            创作前，先把「模型体系」配好。跟着下面几步走完，就能新建你的第一个故事实例。
            {complete && "已经全部就绪，随时可以新建实例开始冒险！"}
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
                  style={{ width: `${(requiredDoneCount / requiredTotal) * 100}%` }}
                />
              </div>
              <span className="text-xs text-muted-foreground whitespace-nowrap">
                完成 {requiredDoneCount}/{requiredTotal}
              </span>
            </div>

            {/* 必需步骤 */}
            <div className="space-y-2">
              {REQUIRED_STEPS.map((s) => (
                <StepRow
                  key={s.key}
                  done={ready[s.key]}
                  title={s.title}
                  desc={s.desc}
                  actionTab={s.tab}
                  actionLabel={s.key === "slotsReady" ? "去指定" : "去配置"}
                />
              ))}
            </div>

            {/* 推荐步骤 */}
            <div className="space-y-1">
              <div className="flex items-center gap-2 px-1 pt-1">
                <span className="text-xs font-medium text-muted-foreground">推荐（可选）</span>
                <div className="flex-1 h-px bg-border" />
              </div>
              <div className="space-y-2 pt-1">
                {RECOMMENDED_STEPS.map((s) => (
                  <StepRow
                    key={s.key}
                    done={ready[s.key]}
                    title={s.title}
                    desc={s.desc}
                    actionTab={s.tab}
                    optional
                  />
                ))}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
