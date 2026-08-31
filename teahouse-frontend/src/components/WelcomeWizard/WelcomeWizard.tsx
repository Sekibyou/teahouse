import { useEffect, useRef, useState } from "react"
import { motion, useReducedMotion } from "motion/react"
import { Loader2, Check, Circle, Sparkles, SkipForward } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useSettingsDialogStore } from "@/stores/settingsDialogStore"
import { useSetupStatus } from "@/hooks/useSetupStatus"
import { useWizardDoneStore } from "@/stores/wizardDoneStore"
import { WIZARD_STEPS, type WizardTab } from "./steps"
import { loadLitSteps, saveLitSteps } from "./progressMemory"
import { useTranslation } from "react-i18next"

export type CircleState = "pending" | "done" | "skipped"

/**
 * 清单左侧的状态灯。三态各有不同的"光"：
 * - `pending`：极淡的冷白背光缓慢呼吸——灯还没点，但通着电；
 * - `done`：暖色背光呼吸，亮度明显高一档——灯亮着；
 * - `skipped`：完全不发光，纯静态灰盘——用户主动放弃的项不该抢注意力。
 *
 * `celebrateDelay` 非 null 时额外播一次性的"点亮"特效：灯芯闪光 + 两圈由小到大
 * 迅速扩散的光晕 + 图标弹入。只有**本次新完成**的项才拿得到这个值（见 WelcomeWizard），
 * 早就亮着的项进页面时是稳定的常亮，不会每次都闪一遍。
 */
export function StepCircle({
  state, celebrateDelay, breathDelay,
}: {
  state: CircleState
  /** null = 不播点亮特效；数字 = 延迟几秒播 */
  celebrateDelay: number | null
  /** 呼吸相位错峰，避免五盏灯整齐划一地一起明灭 */
  breathDelay: number
}) {
  const reduced = useReducedMotion()
  const lit = state === "done"
  const glowing = state !== "skipped"
  const celebrate = celebrateDelay !== null && !reduced

  const disc =
    lit
      ? "bg-primary/15 text-primary ring-1 ring-primary/40"
      : state === "skipped"
        ? "bg-muted text-muted-foreground"
        : "bg-muted/70 text-muted-foreground ring-1 ring-border"

  return (
    <span className="relative mt-0.5 shrink-0 h-6 w-6">
      {/* ① 呼吸背光（常驻）。与 celebrate 完全解耦：done/pending 的灯永远在呼吸，
             不因首屏快照判定（本次新完成 or 早就完成）而停，F5 之后照常循环。 */}
      {glowing && (
        <motion.span
          aria-hidden
          className="absolute -inset-2.5 rounded-full"
          style={{
            background: `radial-gradient(circle, color-mix(in oklch, ${
              lit ? "var(--primary)" : "var(--muted-foreground)"
            } ${lit ? 72 : 34}%, transparent) 0%, transparent 70%)`,
            willChange: "transform, opacity",
          }}
          animate={
            reduced
              ? { opacity: lit ? 0.7 : 0.22, scale: 1 }
              : {
                  opacity: lit ? [0.5, 1, 0.5] : [0.14, 0.34, 0.14],
                  scale: lit ? [0.95, 1.24, 0.95] : [0.94, 1.06, 0.94],
                }
          }
          transition={
            reduced
              ? { duration: 0.2 }
              : {
                  duration: lit ? 2.8 : 3.8,
                  repeat: Infinity,
                  ease: "easeInOut",
                  delay: breathDelay,
                }
          }
        />
      )}

      {/* ② 点亮瞬间：两圈迅速扩散的光晕 + 灯芯闪光（一次性，播完停在透明态） */}
      {celebrate && (
        <>
          <motion.span
            aria-hidden
            className="absolute inset-0 rounded-full border-2 border-primary"
            initial={{ scale: 0.35, opacity: 0.95 }}
            animate={{ scale: 2.9, opacity: 0 }}
            transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1], delay: celebrateDelay }}
          />
          <motion.span
            aria-hidden
            className="absolute inset-0 rounded-full border border-primary/60"
            initial={{ scale: 0.35, opacity: 0.75 }}
            animate={{ scale: 4.4, opacity: 0 }}
            transition={{ duration: 0.95, ease: [0.16, 1, 0.3, 1], delay: celebrateDelay + 0.1 }}
          />
          <motion.span
            aria-hidden
            className="absolute -inset-3 rounded-full"
            style={{
              background:
                "radial-gradient(circle, color-mix(in oklch, var(--primary) 85%, transparent) 0%, transparent 62%)",
            }}
            initial={{ scale: 0.2, opacity: 0 }}
            animate={{ scale: [0.2, 1.3, 1], opacity: [0, 1, 0] }}
            transition={{ duration: 0.85, ease: "easeOut", times: [0, 0.16, 1], delay: celebrateDelay }}
          />
        </>
      )}

      {/* ③ 灯盘本体。key 绑状态：pending → done 时重挂载，图标才会弹进来 */}
      <motion.span
        key={state}
        className={`absolute inset-0 flex items-center justify-center rounded-full transition-colors ${disc}`}
        initial={celebrate ? { scale: 0.35, opacity: 0 } : false}
        animate={{ scale: 1, opacity: 1 }}
        transition={
          celebrate
            ? { type: "spring", stiffness: 480, damping: 18, delay: celebrateDelay }
            : { duration: 0 }
        }
      >
        {lit ? (
          <Check className="h-4 w-4" />
        ) : state === "skipped" ? (
          <SkipForward className="h-3.5 w-3.5" />
        ) : (
          <Circle className="h-4 w-4" />
        )}
      </motion.span>
    </span>
  )
}

function StepRow({
  done, skipped, title, desc, actionTab, actionLabel, recommended, onSkip,
  celebrateDelay, breathDelay,
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
  celebrateDelay: number | null
  breathDelay: number
}) {
  const { t } = useTranslation("misc")
  const openSettings = useSettingsDialogStore((s) => s.openSettings)
  const actionText = actionLabel ?? t("wizard.goConfig")
  const settled = done || skipped
  return (
    <div
      className={`relative flex items-start gap-3 rounded-xl border px-4 py-3.5 transition-colors duration-500 ${
        done
          ? "border-primary/30 bg-primary/[0.04]"
          : settled
            ? "border-border/60 bg-muted/20"
            : "border-border bg-card"
      }`}
    >
      <StepCircle
        state={done ? "done" : skipped ? "skipped" : "pending"}
        celebrateDelay={celebrateDelay}
        breathDelay={breathDelay}
      />
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
      {!done && (
        <div className="shrink-0 flex items-center gap-1.5">
          {onSkip && !skipped && (
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

  // 基线：上次离开这个页面时已经点亮的项。挂载读一次就冻结、永不回退，
  // 它是「本次新完成」的对照基准——上次就亮过的项这次绝不重复点亮。
  const [prevLit] = useState(loadLitSteps)

  // 首屏数据到位的那一刻，把「本次新完成」定格成一个有序批次，用来做依次点亮的错峰。
  const firstBatchRef = useRef<string[] | null>(null)
  if (!loading && firstBatchRef.current === null) {
    firstBatchRef.current = WIZARD_STEPS
      .filter((s) => ready[s.key] && !prevLit[s.key])
      .map((s) => s.key as string)
  }

  // 当前真正完成的项（签名）。跳过的推荐项不算。
  const doneKeys = WIZARD_STEPS.filter((s) => ready[s.key]).map((s) => s.key as string)
  const doneSig = doneKeys.join(",")

  // 本次访问已排入点亮特效的项：key -> 延迟秒数。每一项只在下面这个 effect 里被
  // 排入**一次**（`next[k] !== undefined` 短路），所以之后无论重渲染多少次、再填
  // 多少项，都不会把已经点过的项再点一遍——这就是修掉「填 B 回来 A、B 一起再闪」的关键。
  const [celebrations, setCelebrations] = useState<Record<string, number>>({})

  useEffect(() => {
    if (loading) return
    // ① 把当前真正完成的项写回记忆，供下次进页面做差集。
    saveLitSteps(doneKeys)
    // ② 把「本次新完成、且还没排入过」的项排入点亮特效。
    setCelebrations((prev) => {
      let changed = false
      const next = { ...prev }
      for (const s of WIZARD_STEPS) {
        const k = s.key as string
        if (!ready[s.key] || prevLit[k] || next[k] !== undefined) continue
        const idx = firstBatchRef.current?.indexOf(k) ?? -1
        // 首屏那批依次点亮；进来之后现场配好的（不在批次里）立刻点亮，别让用户等
        next[k] = idx >= 0 ? 0.3 + idx * 0.22 : 0
        changed = true
      }
      return changed ? next : prev
    })
  }, [loading, doneSig])

  // 跳过的推荐项也算一格：进度分母恒为全部步骤数（x/5）
  const doneCount = WIZARD_STEPS.filter((s) => ready[s.key] || skipped[s.key]).length
  const total = WIZARD_STEPS.length

  // 收尾确认：清单全绿后不再直接移除，而是亮出「完成」按钮；点击后每条清单
  // 依次折叠消失，播完动画再正式放行（markDone → SetupGateEmpty 切到正常空态）。
  const markDone = useWizardDoneStore((s) => s.markDone)
  const [confirming, setConfirming] = useState(false)
  const handleConfirm = () => {
    if (confirming || !complete) return
    setConfirming(true)
    // 折叠动画：5 条各 0.18s 错峰 + 0.45s 单条时长，约 1.2s 播完，留 0.4s 缓冲再放行
    window.setTimeout(() => markDone(), 1600)
  }

  return (
    <div className="h-full overflow-y-auto flex items-center justify-center px-4 py-10">
      <div className="w-full max-w-lg flex flex-col gap-5 py-6">
        <div className="text-center">
          <div className="inline-flex items-center justify-center h-12 w-12 rounded-2xl bg-primary/10 text-primary mb-3 ring-1 ring-primary/20 shadow-[0_0_28px_-8px_var(--primary)]">
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
                <motion.div
                  className="h-full rounded-full bg-primary"
                  style={{ boxShadow: "0 0 10px color-mix(in oklch, var(--primary) 60%, transparent)" }}
                  initial={false}
                  animate={{ width: `${(doneCount / total) * 100}%` }}
                  transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
                />
              </div>
              <span className="text-xs text-muted-foreground whitespace-nowrap">
                {t("wizard.doneCount", { done: doneCount, total })}
              </span>
            </div>

            {/* 清单：硬门槛 + 推荐项（推荐项可跳过，跳过也前进一格）。
                确认时每条依次折叠消失（height + opacity + margin 同步收拢）。 */}
            <div className="flex flex-col">
              {WIZARD_STEPS.map((s, i) => (
                <motion.div
                  key={s.key}
                  initial={false}
                  animate={
                    confirming
                      ? { height: 0, opacity: 0, marginBottom: 0 }
                      : { height: "auto", opacity: 1, marginBottom: 8 }
                  }
                  transition={{
                    duration: 0.45,
                    delay: confirming ? i * 0.18 : 0,
                    ease: [0.22, 1, 0.36, 1],
                  }}
                  style={{ overflow: "hidden" }}
                >
                  <StepRow
                    done={ready[s.key]}
                    skipped={!!skipped[s.key]}
                    title={t(s.titleKey)}
                    desc={t(s.descKey)}
                    actionTab={s.tab}
                    actionLabel={s.actionLabelKey ? t(s.actionLabelKey) : undefined}
                    recommended={s.skippable}
                    onSkip={s.skippable ? () => skipStep(s.key) : undefined}
                    celebrateDelay={celebrations[s.key] ?? null}
                    breathDelay={i * 0.4}
                  />
                </motion.div>
              ))}
            </div>

            {/* 确认按钮：达成条件不直接移除向导，等用户点下才算收尾 */}
            {complete && (
              <div className="flex justify-center pt-1">
                <Button
                  size="lg"
                  className="gap-2 px-8"
                  disabled={confirming}
                  onClick={handleConfirm}
                >
                  {confirming ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Sparkles className="h-4 w-4" />
                  )}
                  {t("wizard.confirm")}
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
