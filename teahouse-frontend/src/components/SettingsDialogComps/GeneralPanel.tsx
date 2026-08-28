import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { Sun, Moon, Languages, Download, ExternalLink, ArrowUp, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select"
import { SavedBadge } from "@/components/SavedBadge"
import { useCurrentLang, useLangStore, SUPPORTED_LANGS, LANG_LABELS } from "@/i18n/config"
import { useThemeStore } from "@/stores/themeStore"
import { useNewVersion } from "@/stores/versionStore"
import { useIsMobile } from "@/hooks/useMediaQuery"
import { appSettingsApi } from "@/lib/api"
import type { AppSettings } from "@/lib/types"

export function GeneralPanel() {
  const { t } = useTranslation("settings")
  const isMobile = useIsMobile()
  const currentLang = useCurrentLang()
  const setLang = useLangStore((s) => s.setLang)
  const newVersion = useNewVersion()
  const isDark = useThemeStore((s) => s.isDark)
  const setTheme = useThemeStore((s) => s.setTheme)

  const [appSettings, setAppSettings] = useState<AppSettings>({ max_retries: 3, max_tool_rounds: 15, max_parse_depth: 10 })
  const [settingsLoading, setSettingsLoading] = useState(false)
  const settingSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [savedSettingKeys, setSavedSettingKeys] = useState<Set<string>>(new Set())
  const savedFlashTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({})

  useEffect(() => {
    let alive = true
    setSettingsLoading(true)
    appSettingsApi.get().then((res) => {
      if (alive && res.ok) setAppSettings(res.data!)
      if (alive) setSettingsLoading(false)
    })
    return () => { alive = false }
  }, [])

  useEffect(() => () => {
    if (settingSaveTimer.current) clearTimeout(settingSaveTimer.current)
    Object.values(savedFlashTimers.current).forEach(clearTimeout)
  }, [])

  const flashSaved = (keys: string[]) => {
    setSavedSettingKeys((prev) => {
      const next = new Set(prev)
      keys.forEach((k) => next.add(k))
      return next
    })
    keys.forEach((k) => {
      const existing = savedFlashTimers.current[k]
      if (existing) clearTimeout(existing)
      savedFlashTimers.current[k] = setTimeout(() => {
        setSavedSettingKeys((prev) => {
          const next = new Set(prev)
          next.delete(k)
          return next
        })
        delete savedFlashTimers.current[k]
      }, 1600)
    })
  }

  const setAppSetting = (patch: Partial<AppSettings>) => {
    setAppSettings((prev) => ({ ...prev, ...patch }))
    if (settingSaveTimer.current) clearTimeout(settingSaveTimer.current)
    settingSaveTimer.current = setTimeout(async () => {
      const res = await appSettingsApi.update(patch)
      if (res.ok) {
        setAppSettings(res.data!)
        flashSaved(Object.keys(patch))
      }
    }, 250)
  }

  return (
    <div className={isMobile ? "p-5 space-y-6" : "p-5 columns-2 gap-5"}>
      <div className="rounded-lg border p-4 mb-5 break-inside-avoid">
        <div className="flex flex-col gap-3">
          <div>
            <div className="text-sm font-medium">{t("general.appearance")}</div>
            <p className="text-xs text-muted-foreground mt-1">
              {t("general.appearanceDesc")}
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setTheme(!isDark)}
            className="gap-1.5 self-start"
          >
            {isDark ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
            {isDark ? t("general.switchLight") : t("general.switchDark")}
          </Button>
        </div>
      </div>

      <div className="rounded-lg border p-4 mb-5 break-inside-avoid">
        <div className="flex flex-col gap-3">
          <div>
            <div className="text-sm font-medium flex items-center gap-1.5">
              <Languages className="h-3.5 w-3.5" />
              {t("general.language")}
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              {t("general.languageDesc")}
            </p>
          </div>
          <Select value={currentLang} onValueChange={(v) => setLang(v as typeof currentLang)}>
            <SelectTrigger className="w-36 h-8">
              <SelectValue>{LANG_LABELS[currentLang]}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {SUPPORTED_LANGS.map((l) => (
                <SelectItem key={l} value={l}>
                  {LANG_LABELS[l]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="rounded-lg border p-4 mb-5 break-inside-avoid">
        <div className="flex flex-col gap-3">
          <div className="min-w-0 space-y-1">
            <div className="text-sm font-medium flex items-center gap-1.5">
              <Download className="h-3.5 w-3.5" />
              {t("general.aboutVersion")}
              <span className="font-mono text-muted-foreground">{newVersion.version ?? t("general.versionUnknown")}</span>
              {newVersion.hasUpdate && newVersion.latestVersion && (
                <span className="text-[10px] text-primary bg-primary/10 px-1.5 py-0.5 rounded shrink-0">
                  {t("general.newVersionAvailable", { latest: newVersion.latestVersion })}
                </span>
              )}
            </div>
            <div className="text-sm flex items-center gap-1.5">
              <ArrowUp className="h-3.5 w-3.5 text-muted-foreground" />
              {t("general.latestVersion")}
              <span className="font-mono text-muted-foreground">
                {newVersion.latestVersion ?? t("general.versionUnknown")}
              </span>
            </div>
          </div>
          <Button
            variant={newVersion.hasUpdate ? "default" : "outline"}
            size="sm"
            className="gap-1.5 shrink-0 self-start"
            onClick={() => window.open(newVersion.url, "_blank", "noopener,noreferrer")}
          >
            <ExternalLink className="h-3.5 w-3.5" />
            {t("general.goToRelease")}
          </Button>
        </div>
      </div>

      {settingsLoading ? (
        <div className="flex items-center justify-center py-12 break-inside-avoid">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <>
          <div className="rounded-lg border p-4 space-y-4 mb-5 break-inside-avoid">
            <div>
              <div className="flex items-center justify-between gap-2 min-h-5">
                <label className="text-sm font-medium">
                  {t("general.maxRetries")}
                </label>
                <SavedBadge show={savedSettingKeys.has("max_retries")} />
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                {t("general.maxRetriesDesc")}
              </p>
              <div className="mt-3 flex items-center gap-3">
                <input
                  type="range"
                  min={0}
                  max={10}
                  value={appSettings.max_retries}
                  onChange={(e) => setAppSetting({ max_retries: Number(e.target.value) })}
                  className="flex-1 h-2 rounded-full appearance-none bg-muted cursor-pointer accent-primary"
                />
                <input
                  type="number"
                  min={0}
                  max={10}
                  value={appSettings.max_retries}
                  onChange={(e) => {
                    const v = Math.max(0, Math.min(10, Number(e.target.value) || 0))
                    setAppSetting({ max_retries: v })
                  }}
                  className="w-16 h-8 rounded border border-border bg-muted/30 text-center text-sm font-mono [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                />
              </div>
            </div>
          </div>

          <div className="rounded-lg border p-4 space-y-4 mb-5 break-inside-avoid">
            <div>
              <div className="flex items-center justify-between gap-2 min-h-5">
                <label className="text-sm font-medium">
                  {t("general.maxToolRounds")}
                </label>
                <SavedBadge show={savedSettingKeys.has("max_tool_rounds")} />
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                {t("general.maxToolRoundsDesc")}
              </p>
              <div className="mt-3 flex items-center gap-3">
                <input
                  type="range"
                  min={1}
                  max={200}
                  value={appSettings.max_tool_rounds}
                  onChange={(e) => setAppSetting({ max_tool_rounds: Number(e.target.value) })}
                  className="flex-1 h-2 rounded-full appearance-none bg-muted cursor-pointer accent-primary"
                />
                <input
                  type="number"
                  min={1}
                  max={200}
                  value={appSettings.max_tool_rounds}
                  onChange={(e) => {
                    const v = Math.max(1, Math.min(200, Number(e.target.value) || 1))
                    setAppSetting({ max_tool_rounds: v })
                  }}
                  className="w-16 h-8 rounded border border-border bg-muted/30 text-center text-sm font-mono [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                />
              </div>
            </div>
          </div>

          <div className="rounded-lg border p-4 space-y-4 mb-5 break-inside-avoid">
            <div>
              <div className="flex items-center justify-between gap-2 min-h-5">
                <label className="text-sm font-medium">
                  {t("general.maxParseDepth")}
                </label>
                <SavedBadge show={savedSettingKeys.has("max_parse_depth")} />
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                {t("general.maxParseDepthDesc")}
              </p>
              <div className="mt-3 flex items-center gap-3">
                <input
                  type="range"
                  min={0}
                  max={30}
                  value={appSettings.max_parse_depth}
                  onChange={(e) => setAppSetting({ max_parse_depth: Number(e.target.value) })}
                  className="flex-1 h-2 rounded-full appearance-none bg-muted cursor-pointer accent-primary"
                />
                <input
                  type="number"
                  min={0}
                  max={30}
                  value={appSettings.max_parse_depth}
                  onChange={(e) => {
                    const v = Math.max(0, Math.min(30, Number(e.target.value) || 0))
                    setAppSetting({ max_parse_depth: v })
                  }}
                  className="w-16 h-8 rounded border border-border bg-muted/30 text-center text-sm font-mono [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                />
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
