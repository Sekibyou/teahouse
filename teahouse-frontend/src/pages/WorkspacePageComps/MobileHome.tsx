import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { Play, Minus, Plus, Type, Sun, Moon, Languages, ArrowLeft, FileText, Bot, PenLine, AlertCircle, GitBranch, Puzzle, BookOpen, Package, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { SUPPORTED_LANGS, LANG_LABELS, useCurrentLang, useLangStore, type Lang } from "@/i18n/config"
import { useThemeStore } from "@/stores/themeStore"
import { useUiScaleStore, UI_SCALE_PRESETS } from "@/stores/uiScaleStore"
import { appSettingsApi, llmSlotsApi, llmModelsApi } from "@/lib/api"
import type { LLMModel } from "@/lib/types"
import { cn } from "@/lib/utils"

interface MobileHomeProps {
  instanceName: string
  onEnterPlay: () => void
  onOpenModel: () => void
  onOpenFiles: () => void
  onOpenGit: () => void
  changeCounts: { added: number; modified: number; deleted: number }
  onBackToHome: () => void
  /** 实例内容快速入口的数量（插件=全局已启用；Skill/提示词包=实例内已启用）。 */
  counts: { plugins: number; skill: number; pkg: number } | null
  countsLoading: boolean
  onOpenPlugins: () => void
  onOpenSkills: () => void
  onOpenPackages: () => void
}

/** 字号 A−/A+ 步进控件：本地 setScaleId 即时换档(DOM 预览) + debounce 落后端持久化。 */
function FontScaleControl() {
  const { t } = useTranslation(["workspace", "settings"])
  const scaleId = useUiScaleStore((s) => s.scaleId)
  const setScaleId = useUiScaleStore((s) => s.setScaleId)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // mount 拉一次后端持久化档位对齐 store/DOM（与 GeneralPanel 初始对齐同理）
  useEffect(() => {
    let alive = true
    appSettingsApi.get().then((res) => {
      if (alive && res.ok && res.data?.ui_scale) setScaleId(res.data.ui_scale)
    })
    return () => { alive = false }
  }, [setScaleId])

  const apply = (id: string) => {
    setScaleId(id)
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      void appSettingsApi.update({ ui_scale: id })
    }, 250)
  }
  useEffect(() => () => { if (saveTimer.current) clearTimeout(saveTimer.current) }, [])

  const idx = UI_SCALE_PRESETS.findIndex((p) => p.id === scaleId)
  const cur = UI_SCALE_PRESETS[idx >= 0 ? idx : 0]
  const prev = UI_SCALE_PRESETS[Math.max(0, idx - 1)]
  const next = UI_SCALE_PRESETS[Math.min(UI_SCALE_PRESETS.length - 1, idx + 1)]

  return (
    <div className="flex items-center gap-2">
      <Button
        variant="outline"
        size="sm"
        className="h-9 w-9 px-0 bg-transparent dark:bg-transparent hover:bg-muted hover:text-foreground"
        disabled={!prev || prev.id === cur.id}
        aria-label={`${t("workspace:homeFontSize")} -`}
        onClick={() => apply(prev.id)}
      >
        <Minus className="h-4 w-4" />
      </Button>
      <span className="min-w-12 text-center text-sm">{cur ? t(`settings:general.${cur.id}`) : ""}</span>
      <Button
        variant="outline"
        size="sm"
        className="h-9 w-9 px-0 bg-transparent dark:bg-transparent hover:bg-muted hover:text-foreground"
        disabled={!next || next.id === cur.id}
        aria-label={`${t("workspace:homeFontSize")} +`}
        onClick={() => apply(next.id)}
      >
        <Plus className="h-4 w-4" />
      </Button>
    </div>
  )
}

/** 移动端外层首页 tab：大「进入游玩」按钮 + 快捷设置（字号/主题/语言/模型）+ 返回列表。 */
export function MobileHome({ instanceName, onEnterPlay, onOpenModel, onOpenFiles, onOpenGit, changeCounts, onBackToHome, counts, countsLoading, onOpenPlugins, onOpenSkills, onOpenPackages }: MobileHomeProps) {
  const { t } = useTranslation(["workspace", "settings", "misc", "session"])
  const { isDark, setTheme } = useThemeStore()
  const currentLang = useCurrentLang()
  const setLang = useLangStore((s) => s.setLang)
  // 当前导演/正文槽位模型（含供应商），只读展示，点击整块跳设置「槽位指定」
  const [slotModels, setSlotModels] = useState<{ director: LLMModel | null; writer: LLMModel | null }>({ director: null, writer: null })

  useEffect(() => {
    let alive = true
    ;(async () => {
      const [slotsRes, modelsRes] = await Promise.all([llmSlotsApi.getAll(), llmModelsApi.list()])
      if (!alive) return
      if (!slotsRes.ok || !modelsRes.ok) return
      const slots = slotsRes.data?.slots
      const modelMap = new Map<string, LLMModel>((modelsRes.data?.models ?? []).map((m) => [m.id, m]))
      const resolve = (modelId: string | null | undefined) => (modelId ? modelMap.get(modelId) ?? null : null)
      setSlotModels({
        director: resolve(slots?.director?.model_id),
        writer: resolve(slots?.writer?.model_id),
      })
    })()
    return () => { alive = false }
  }, [])

  const slotRow = (key: "director" | "writer", icon: typeof Bot, model: LLMModel | null) => {
    const Icon = icon
    return (
      <div className="flex items-center justify-between px-4 gap-3 min-h-[52px]">
        <div className="flex items-center gap-2 text-sm min-w-0">
          <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="shrink-0">{t(`settings:slot.${key}`)}</span>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="h-9 gap-1.5 shrink-0 bg-transparent dark:bg-transparent hover:bg-muted hover:text-foreground"
          onClick={onOpenModel}
          aria-label={t(`settings:slot.${key}`)}
        >
          {model ? (
            <>
              <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                {model.provider_name}
              </span>
              <span className="max-w-[140px] truncate">{model.name}</span>
            </>
          ) : (
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <AlertCircle className="h-3.5 w-3.5" />
              {t("misc:slot.noModel")}
            </span>
          )}
        </Button>
      </div>
    )
  }

  // 实例内容快速入口行：与版本控制行一致——icon+名在左；右组 = 状态 badge(已启用 N / 无) + 「查看」按钮。
  const quickRow = (Icon: typeof Bot, label: string, count: number | undefined, onClick: () => void) => (
    <div className="flex items-center justify-between px-4 gap-3 min-h-[52px]">
      <div className="flex items-center gap-2 text-sm min-w-0">
        <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="truncate">{label}</span>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {!countsLoading && (count ?? 0) > 0 && (
          <span className="text-xs bg-muted/60 text-muted-foreground font-medium px-1.5 py-0.5 rounded leading-none">
            {t("session:homeQuick.enabled", { n: count })}
          </span>
        )}
        {!countsLoading && (count ?? 0) === 0 && (
          <span className="text-xs bg-muted/60 text-muted-foreground font-medium px-1.5 py-0.5 rounded leading-none">
            {t("session:homeQuick.none")}
          </span>
        )}
        <Button
          variant="outline"
          size="sm"
          className="h-9 gap-1.5 shrink-0 bg-transparent dark:bg-transparent hover:bg-muted hover:text-foreground"
          onClick={onClick}
        >
          {countsLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : t("workspace:homeView")}
        </Button>
      </div>
    </div>
  )

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-auto px-5 pt-4 space-y-6">
      {/* 栏1 · 进入游玩 */}
      <section>
        <h2 className="text-xs font-medium text-muted-foreground mb-2 px-1">{t("homeSectionPlayTitle")}</h2>
        <button
          className="w-full text-left p-4 rounded-xl border border-border bg-card flex items-center gap-3 active:bg-muted"
          onClick={onEnterPlay}
        >
          <span className="h-12 w-12 rounded-full bg-primary text-primary-foreground flex items-center justify-center shrink-0">
            <Play className="h-6 w-6 ml-0.5" fill="currentColor" />
          </span>
          <div className="min-w-0">
            <div className="text-base font-semibold truncate">{t("homeEnterPlay")}</div>
            <div className="text-sm text-muted-foreground truncate">{instanceName}</div>
          </div>
        </button>
      </section>

      {/* 栏2 · 快捷设置 */}
      <section>
        <h2 className="text-xs font-medium text-muted-foreground mb-2 px-1">{t("homeSettingsTitle")}</h2>
        <div className="rounded-xl border border-border divide-y divide-border bg-card overflow-hidden">
          {/* 字号 */}
          <div className="flex items-center justify-between px-4 gap-3 min-h-[52px]">
            <div className="flex items-center gap-2 text-sm min-w-0">
              <Type className="h-4 w-4 shrink-0 text-muted-foreground" />
              {t("homeFontSize")}
            </div>
            <FontScaleControl />
          </div>
          {/* 主题 */}
          <div className="flex items-center justify-between px-4 gap-3 min-h-[52px]">
            <div className="flex items-center gap-2 text-sm min-w-0">
              {isDark ? <Moon className="h-4 w-4 shrink-0 text-muted-foreground" /> : <Sun className="h-4 w-4 shrink-0 text-muted-foreground" />}
              {t("workspace:themeToggle")}
            </div>
            <Button variant="outline" size="sm" className="h-9 gap-1.5 bg-transparent dark:bg-transparent hover:bg-muted hover:text-foreground" onClick={() => setTheme(!isDark)}>
              {isDark ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
              {isDark ? t("settings:general.switchLight") : t("settings:general.switchDark")}
            </Button>
          </div>
          {/* 语言 */}
          <div className="flex items-center justify-between px-4 gap-3 min-h-[52px]">
            <div className="flex items-center gap-2 text-sm min-w-0">
              <Languages className="h-4 w-4 shrink-0 text-muted-foreground" />
              {t("workspace:language")}
            </div>
            <div className="flex items-center gap-1">
              {SUPPORTED_LANGS.map((l) => (
                <button
                  key={l}
                  className={cn(
                    "h-9 px-3 rounded-md text-xs font-medium border",
                    currentLang === l
                      ? "bg-primary text-primary-foreground border-primary"
                      : "border-border hover:bg-muted"
                  )}
                  onClick={() => setLang(l as Lang)}
                >
                  {LANG_LABELS[l]}
                </button>
              ))}
            </div>
          </div>
          {/* 文件清单 */}
          <div className="flex items-center justify-between px-4 gap-3 min-h-[52px]">
            <div className="flex items-center gap-2 text-sm min-w-0">
              <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
              {t("workspace:fileList")}
            </div>
            <Button variant="outline" size="sm" className="h-9 gap-1.5 bg-transparent dark:bg-transparent hover:bg-muted hover:text-foreground" onClick={onOpenFiles}>
              {t("workspace:homeView")}
            </Button>
          </div>
          {/* 导演模型 */}
          {slotRow("director", Bot, slotModels.director)}
          {/* 正文模型 */}
          {slotRow("writer", PenLine, slotModels.writer)}
          {/* 版本控制 */}
          <div className="flex items-center justify-between px-4 gap-3 min-h-[52px]">
            <div className="flex items-center gap-2 text-sm min-w-0">
              <GitBranch className="h-4 w-4 shrink-0 text-muted-foreground" />
              {t("workspace:versionControl")}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <div className="flex items-center gap-1">
                {changeCounts.deleted > 0 && (
                  <span className="text-xs bg-red-500/15 text-red-600 dark:text-red-400 font-medium px-1.5 py-0.5 rounded leading-none">
                    -{changeCounts.deleted}
                  </span>
                )}
                {changeCounts.modified > 0 && (
                  <span className="text-xs bg-yellow-500/15 text-yellow-600 dark:text-yellow-400 font-medium px-1.5 py-0.5 rounded leading-none">
                    ~{changeCounts.modified}
                  </span>
                )}
                {changeCounts.added > 0 && (
                  <span className="text-xs bg-green-500/15 text-green-600 dark:text-green-400 font-medium px-1.5 py-0.5 rounded leading-none">
                    +{changeCounts.added}
                  </span>
                )}
              </div>
              <Button variant="outline" size="sm" className="h-9 gap-1.5 bg-transparent dark:bg-transparent hover:bg-muted hover:text-foreground" onClick={onOpenGit}>
                {t("workspace:homeView")}
              </Button>
            </div>
          </div>

          {/* 实例内容快速入口：插件 / Skill / 提示词包（带数量，点进管理） */}
          {quickRow(Puzzle, t("session:pluginsShort"), counts?.plugins, onOpenPlugins)}
          {quickRow(BookOpen, "Skill", counts?.skill, onOpenSkills)}
          {quickRow(Package, t("session:packagesShort"), counts?.pkg, onOpenPackages)}
        </div>
      </section>

      {/* 栏3 · 退出实例 */}
      <section>
        <h2 className="text-xs font-medium text-muted-foreground mb-2 px-1">{t("homeSectionBackTitle")}</h2>
        <div className="rounded-xl border border-border bg-card overflow-hidden">
          <div className="flex items-center justify-between px-4 gap-3 min-h-[52px]">
            <div className="flex items-center gap-2 text-sm min-w-0">
              <ArrowLeft className="h-4 w-4 shrink-0 text-muted-foreground" />
              {t("homeBackToHome")}
            </div>
            <Button variant="destructive" size="sm" className="h-9 gap-1.5" onClick={onBackToHome}>
              {t("homeGoBack")}
            </Button>
          </div>
        </div>
      </section>

      <div className="h-2" />
    </div>
  )
}
