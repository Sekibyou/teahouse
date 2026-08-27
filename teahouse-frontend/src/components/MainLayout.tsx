import { Sun, Moon, LogOut, User, Settings, ArrowLeft, Gamepad2, Wrench, Users, Download } from "lucide-react"
import { useEffect } from "react"
import { Outlet, useLocation, useNavigate } from "react-router-dom"
import { Button } from "@/components/ui/button"
import { useAuth, useAuthActions, isAdminRole } from "@/stores/authStore"
import { useSessionStore } from "@/stores/sessionStore"
import { useViewModeStore } from "@/stores/viewModeStore"
import { useIsMobile } from "@/hooks/useMediaQuery"
import { useThemeStore } from "@/stores/themeStore"
import { useSettingsDialogStore } from "@/stores/settingsDialogStore"
import { SettingsDialog } from "@/components/SettingsDialog"
import { LoginPage } from "@/pages/LoginPage"
import { useTranslation } from "react-i18next"
import { LangSwitcher } from "@/components/LangSwitcher"
import { useNewVersion } from "@/stores/versionStore"

export function MainLayout() {
  const { t } = useTranslation("misc")
  const { isAuthenticated, isLoading, user } = useAuth()
  const { clearAuth } = useAuthActions()
  const navigate = useNavigate()
  const location = useLocation()
  const activeInstance = useSessionStore((s) => s.activeInstance)
  const setActiveInstance = useSessionStore((s) => s.setActiveInstance)
  const { mode } = useViewModeStore()
  const isMobile = useIsMobile()
  const isDark = useThemeStore((s) => s.isDark)
  const toggleTheme = useThemeStore((s) => s.toggleTheme)
  const openSettings = useSettingsDialogStore((s) => s.openSettings)
  const newVersion = useNewVersion()

  useEffect(() => {
    if (isLoading) return
  }, [isLoading])

  if (isLoading) {
    return (
      <div className="h-dvh flex items-center justify-center bg-background">
        <div className="animate-spin h-8 w-8 border-2 border-primary border-t-transparent rounded-full" />
      </div>
    )
  }

  if (!isAuthenticated) {
    return (
      <div className="h-dvh flex flex-col bg-background">
        <header className="h-12 border-b border-border flex items-center justify-between px-4 shrink-0">
          <span className="font-semibold">LowStar's Teahouse</span>
          <div className="flex items-center gap-1">
            <LangSwitcher className="h-8 w-8 p-0 justify-center" />
            <Button variant="ghost" size="icon" onClick={toggleTheme}>
              {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </Button>
          </div>
        </header>
        <main className="flex-1 overflow-auto">
          <LoginPage />
        </main>
      </div>
    )
  }

  // Mobile: no global top bar — pages render fullscreen with their own navigation
  if (isMobile) {
    return (
      <div className="h-dvh flex flex-col overflow-hidden bg-background">
        <div className="flex-1 flex overflow-hidden">
          <main className="flex-1 overflow-auto">
            <Outlet context={{ isMobile: true, toggleTheme }} />
          </main>
        </div>
        <SettingsDialog />
      </div>
    )
  }

  // Desktop header with full navigation
  return (
    <div className="h-dvh flex flex-col overflow-hidden bg-background">
      <header className="h-14 border-b border-border flex items-center justify-between px-5 shrink-0 relative z-[60] bg-background">
        <div className="flex items-center gap-3 min-w-0">
          <div className="flex items-baseline gap-2 min-w-0">
            <span className="font-semibold whitespace-nowrap">LowStar's Teahouse</span>
            <span className="text-xs text-muted-foreground truncate">{t("layout.engineTagline")}</span>
          </div>
          {/* 这两个按钮只在 workspace 内显示：用路由判断，而不是仅靠 activeInstance，
              否则用浏览器后退/直接改回大厅 URL 时，persist 的 activeInstance 仍在，
              按钮不会随之消失。 */}
          {activeInstance && location.pathname.startsWith("/workspace") && (
            <div className="flex items-center gap-2 shrink-0">
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5 text-xs"
                onClick={() => {
                  setActiveInstance(null)
                  navigate("/", { replace: true })
                }}
                title={t("layout.backToSessionTitle")}
              >
                <ArrowLeft className="h-3.5 w-3.5" />
                {t("layout.backToSessionText")}
              </Button>
              <div className="flex items-center rounded-md border border-border overflow-hidden">
                <button
                  className={`px-3 py-1 text-xs font-medium transition-colors ${
                    mode === "play"
                      ? "bg-primary text-primary-foreground"
                      : "hover:bg-muted text-muted-foreground"
                  }`}
                  onClick={() => useViewModeStore.getState().setMode("play")}
                >
                  <Gamepad2 className="h-3.5 w-3.5 inline mr-1" />
                  {t("layout.play")}
                </button>
                <button
                  className={`px-3 py-1 text-xs font-medium transition-colors ${
                    mode === "backstage"
                      ? "bg-primary text-primary-foreground"
                      : "hover:bg-muted text-muted-foreground"
                  }`}
                  onClick={() => useViewModeStore.getState().setMode("backstage")}
                >
                  <Wrench className="h-3.5 w-3.5 inline mr-1" />
                  {t("layout.backstage")}
                </button>
              </div>
            </div>
          )}
        </div>
        <div className="flex items-center gap-1">
          <div className="flex items-center gap-2 mr-2 text-sm text-muted-foreground">
            <User className="h-4 w-4" />
            <span>{user?.display_name || user?.username}</span>
          </div>
          {isAdminRole(user?.role) && (
            <Button variant="ghost" size="icon" onClick={() => openSettings("users")} title={t("layout.userManagement")}>
              <Users className="h-4 w-4" />
            </Button>
          )}
          {newVersion.hasUpdate && (
            <Button
              variant="outline"
              size="icon"
              className="relative border-primary text-primary animate-pulse"
              onClick={() => window.open(newVersion.url, "_blank", "noopener,noreferrer")}
              title={t("layout.newVersionAvailable", { latest: newVersion.latestVersion ?? "" })}
            >
              {/* 小圆点提示：有新版 */}
              <span className="absolute top-1 right-1 h-2 w-2 rounded-full bg-primary" />
              <Download className="h-4 w-4" />
            </Button>
          )}
          <LangSwitcher className="h-8 w-8 p-0 justify-center" />
          <Button variant="ghost" size="icon" onClick={toggleTheme}>
            {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </Button>
          <Button variant="ghost" size="icon" onClick={() => openSettings()}>
            <Settings className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="icon" onClick={clearAuth}>
            <LogOut className="h-4 w-4" />
          </Button>
        </div>
      </header>

      <div className="flex-1 flex overflow-hidden">
        <main className="flex-1 overflow-auto">
          <Outlet context={{ isMobile: false, toggleTheme }} />
        </main>
      </div>
      <SettingsDialog />
    </div>
  )
}
