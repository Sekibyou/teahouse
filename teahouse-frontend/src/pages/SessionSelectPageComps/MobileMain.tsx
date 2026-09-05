import { useState } from "react"
import { useTranslation } from "react-i18next"
import { motion, useReducedMotion } from "motion/react"
import { Settings, Users, Sun, Moon, Languages, LogOut, BookOpen, Plus, Play, Hash, Clock } from "lucide-react"
import { isAdminRole, useAuth } from "@/stores/authStore"
import { useCurrentLang, useLangStore, SUPPORTED_LANGS, LANG_LABELS, type Lang } from "@/i18n/config"
import { useSettingsDialogStore } from "@/stores/settingsDialogStore"
import { CoverWithFetch } from "@/components/Cover"
import { formatDateShort } from "./formatDateShort"
import { SetupGateEmpty } from "./SetupGate"
import { NewInstanceCard } from "./DesktopMain"
import type { Instance } from "@/lib/types"

// ============================================================================
// Mobile main — instance list with FAB to open bookshelf
// ============================================================================
export function MobileMain({
  instances, onOpenInstance, onQuickStart, onNew, isDark, onToggleTheme, onOpenSettings, onLogout,
}: {
  instances: Instance[]
  onOpenInstance: (i: Instance) => void
  onQuickStart: (i: Instance) => void
  onNew: () => void
  isDark: boolean
  onToggleTheme: () => void
  onOpenSettings: () => void
  onLogout: () => void
}) {
  const { t } = useTranslation("session")
  const { user: currentUser } = useAuth()
  const openSettings = useSettingsDialogStore((s) => s.openSettings)
  const currentLang = useCurrentLang()
  const setLang = useLangStore((s) => s.setLang)
  const reduced = useReducedMotion()
  const [showMenu, setShowMenu] = useState(false)
  return (
    <div className="h-full flex flex-col overflow-hidden">
      <header className="h-14 relative border-b border-border flex items-center justify-between px-3 shrink-0">
        <div className="flex-1 min-w-0 flex flex-col justify-center">
          <span className="font-serif font-semibold text-sm leading-tight">LowStar's Teahouse</span>
          <span className="text-[11px] text-muted-foreground leading-tight truncate">{t("subtitle")}</span>
        </div>
        <button
          className="p-2 rounded hover:bg-muted shrink-0"
          onClick={() => setShowMenu(!showMenu)}
          aria-label={t("menu")}
        >
          <Settings className="h-5 w-5" />
        </button>
        {showMenu && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setShowMenu(false)} />
            <div className="absolute right-0 top-full mt-1 z-50 bg-background border border-border rounded-md shadow-lg py-1 min-w-[200px]">
              {isAdminRole(currentUser?.role) && (
                <button className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-muted" onClick={() => { openSettings("users"); setShowMenu(false) }}>
                  <Users className="h-4 w-4" />{t("workspace:userManagement")}
                </button>
              )}
              <button className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-muted" onClick={() => { onToggleTheme(); setShowMenu(false) }}>
                {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
                {t("themeToggle")}
              </button>
              <button className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-muted" onClick={() => { onOpenSettings(); setShowMenu(false) }}>
                <Settings className="h-4 w-4" />{t("common:settings")}
              </button>
              <div className="border-t border-border" />
              <div className="px-3 py-2 space-y-1">
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Languages className="h-4 w-4" />
                  {t("workspace:language")}
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
                      onClick={() => setLang(l as Lang)}
                    >
                      {LANG_LABELS[l]}
                    </button>
                  ))}
                </div>
              </div>
              <div className="border-t border-border" />
              <button className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-muted text-red-500" onClick={() => { onLogout(); setShowMenu(false) }}>
                <LogOut className="h-4 w-4" />{t("logout")}
              </button>
            </div>
          </>
        )}
      </header>

      <div className="flex-1 overflow-y-auto min-h-0 p-3">
        {instances.length === 0 ? (
          <SetupGateEmpty onNew={onNew}>
            <div className="flex flex-col items-center justify-center text-center gap-4 py-24">
              <BookOpen className="h-10 w-10 text-muted-foreground opacity-40" />
              <p className="text-sm text-muted-foreground">{t("empty.title")}</p>
              <button
                onClick={onNew}
                className="inline-flex items-center justify-center gap-2 h-10 px-4 rounded-xl border-2 border-dashed border-border text-muted-foreground hover:border-primary hover:text-primary transition-colors"
              >
                <Plus className="h-4 w-4" />{t("newInstance")}
              </button>
            </div>
          </SetupGateEmpty>
        ) : (
          <motion.div
            className="columns-2 gap-3"
            initial={reduced ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
          >
            <NewInstanceCard onNew={onNew} />
            {instances.map((inst) => (
              <MobileInstanceCard key={inst.id} instance={inst} onOpen={() => onOpenInstance(inst)} onQuickStart={() => onQuickStart(inst)} />
            ))}
          </motion.div>
        )}
      </div>
    </div>
  )
}

function MobileInstanceCard({ instance, onOpen, onQuickStart }: { instance: Instance; onOpen: () => void; onQuickStart: () => void }) {
  const { t } = useTranslation("session")
  return (
    <div
      className="mb-3 break-inside-avoid flex flex-col rounded-xl overflow-hidden border border-border bg-card shadow-sm cursor-pointer active:scale-[0.98] transition-transform duration-150 card-hover-glow group"
      onClick={onOpen}
    >
      <div className="shrink-0 p-2 pb-0">
        <div className="aspect-square w-full overflow-hidden rounded-md bg-muted">
          <CoverWithFetch kind="instance" id={instance.id} name={instance.name} className="transition-transform duration-300 ease-out group-hover:scale-[1.05]" />
        </div>
      </div>
      <div className="flex items-center gap-2 p-2">
        {/* Left: text stack (title over meta) */}
        <div className="flex-1 min-w-0 flex flex-col">
          <div className="font-semibold text-[13px] leading-snug line-clamp-2">
            {instance.prototype_name ? `${instance.prototype_name} - ${instance.name}` : instance.name}
          </div>
          <div className="flex items-center gap-2 mt-1 text-[11px] text-muted-foreground">
            <span className="flex items-center gap-0.5"><Hash className="h-3 w-3" />{instance.floor_count}</span>
            <span className="flex items-center gap-0.5"><Clock className="h-3 w-3" />{formatDateShort(instance.updated_at)}</span>
          </div>
        </div>
        {/* Right: square play icon — 快速进入会话 */}
        <button
          className="shrink-0 w-9 h-9 flex items-center justify-center rounded-md bg-primary text-primary-foreground cursor-pointer active:scale-90 transition-transform"
          onClick={(e) => { e.stopPropagation(); onQuickStart() }}
          title={t("quickStart")}
          aria-label={t("quickStart")}
        >
          <Play className="h-4 w-4" />
        </button>
      </div>
    </div>
  )
}
