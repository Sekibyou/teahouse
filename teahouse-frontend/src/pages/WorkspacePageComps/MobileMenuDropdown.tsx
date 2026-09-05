import { useTranslation } from "react-i18next"
import {
  ArrowLeft, GitBranch, Languages, MessageCircle, FileText,
  Moon, Settings, Sun, Users,
} from "lucide-react"
import { Switch } from "@/components/ui/switch"
import { SUPPORTED_LANGS, LANG_LABELS, type Lang } from "@/i18n/config"
import { useViewModeStore } from "@/stores/viewModeStore"

export function MobileMenuDropdown({
  mode,
  isDark,
  currentLang,
  isAdmin,
  onChangeLang,
  onToggleTheme,
  onOpenDirector,
  onOpenGit,
  onOpenFiles,
  onOpenSettings,
  onOpenUsers,
  onExit,
  onClose,
}: {
  mode: "play" | "backstage"
  isDark: boolean
  currentLang: string
  isAdmin: boolean
  onChangeLang: (l: Lang) => void
  onToggleTheme: () => void
  onOpenDirector: () => void
  onOpenGit: () => void
  onOpenFiles: () => void
  onOpenSettings: () => void
  onOpenUsers: () => void
  onExit: () => void
  onClose: () => void
}) {
  const { t } = useTranslation("workspace")
  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div className="absolute right-0 top-full mt-1 z-50 bg-background border border-border rounded-md shadow-lg py-1 min-w-[160px]">
        <div className="flex items-center justify-between px-3 py-2">
          <span className="text-sm">{t("mode.play")}</span>
          <Switch
            checked={mode === "backstage"}
            onCheckedChange={(v) => {
              useViewModeStore.getState().setMode(v ? "backstage" : "play")
              onClose()
            }}
          />
        </div>
        <div className="border-t border-border" />
        <button
          className="w-full flex items-center gap-2 px-3 py-2.5 text-sm hover:bg-muted"
          onClick={onOpenDirector}
        >
          <MessageCircle className="h-4 w-4" />
          {t("director")}
        </button>
        <button
          className="w-full flex items-center gap-2 px-3 py-2.5 text-sm hover:bg-muted"
          onClick={onOpenGit}
        >
          <GitBranch className="h-4 w-4" />
          {t("versionControl")}
        </button>
        <button
          className="w-full flex items-center gap-2 px-3 py-2.5 text-sm hover:bg-muted"
          onClick={onOpenFiles}
        >
          <FileText className="h-4 w-4" />
          {t("fileList")}
        </button>
        {isAdmin && (
          <button
            className="w-full flex items-center gap-2 px-3 py-2.5 text-sm hover:bg-muted"
            onClick={onOpenUsers}
          >
            <Users className="h-4 w-4" />
            {t("userManagement")}
          </button>
        )}
        <button
          className="w-full flex items-center gap-2 px-3 py-2.5 text-sm hover:bg-muted"
          onClick={onOpenSettings}
        >
          <Settings className="h-4 w-4" />
          {t("common:settings")}
        </button>
        <div className="border-t border-border" />
        <div className="px-3 py-2 space-y-1">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Languages className="h-4 w-4" />
            {t("language")}
          </div>
          <div className="flex items-center gap-2 flex-wrap pl-6">
            {SUPPORTED_LANGS.map((l) => (
              <button
                key={l}
                className={`px-2 py-1 text-xs rounded border ${
                  currentLang === l
                    ? "bg-primary text-primary-foreground border-primary"
                    : "border-border hover:bg-muted"
                }`}
                onClick={() => onChangeLang(l as Lang)}
              >
                {LANG_LABELS[l]}
              </button>
            ))}
          </div>
        </div>
        <div className="border-t border-border" />
        <button
          className="w-full flex items-center gap-2 px-3 py-2.5 text-sm hover:bg-muted"
          onClick={onToggleTheme}
        >
          {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          {t("themeToggle")}
        </button>
        <div className="border-t border-border" />
        <button
          className="w-full flex items-center gap-2 px-3 py-2.5 text-sm hover:bg-muted"
          onClick={onExit}
        >
          <ArrowLeft className="h-4 w-4" />
          {t("exitToHome")}
        </button>
      </div>
    </>
  )
}
