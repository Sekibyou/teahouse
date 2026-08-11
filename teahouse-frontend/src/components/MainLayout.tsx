import { Sun, Moon, LogOut, User, Settings, ArrowLeft, Gamepad2, Wrench } from "lucide-react"
import { useEffect } from "react"
import { Outlet, useNavigate } from "react-router-dom"
import { Button } from "@/components/ui/button"
import { useAuth, useAuthActions } from "@/stores/authStore"
import { useSessionStore } from "@/stores/sessionStore"
import { useViewModeStore } from "@/stores/viewModeStore"
import { useIsMobile } from "@/hooks/useMediaQuery"
import { useThemeStore } from "@/stores/themeStore"
import { useSettingsDialogStore } from "@/stores/settingsDialogStore"
import { SettingsDialog } from "@/components/SettingsDialog"
import { LoginPage } from "@/pages/LoginPage"

export function MainLayout() {
  const { isAuthenticated, isLoading, user } = useAuth()
  const { clearAuth } = useAuthActions()
  const navigate = useNavigate()
  const activeInstance = useSessionStore((s) => s.activeInstance)
  const setActiveInstance = useSessionStore((s) => s.setActiveInstance)
  const { mode } = useViewModeStore()
  const isMobile = useIsMobile()
  const isDark = useThemeStore((s) => s.isDark)
  const toggleTheme = useThemeStore((s) => s.toggleTheme)
  const openSettings = useSettingsDialogStore((s) => s.openSettings)

  useEffect(() => {
    if (isLoading) return
  }, [isLoading])

  if (isLoading) {
    return (
      <div className="h-screen flex items-center justify-center bg-background">
        <div className="animate-spin h-8 w-8 border-2 border-primary border-t-transparent rounded-full" />
      </div>
    )
  }

  if (!isAuthenticated) {
    return (
      <div className="h-screen flex flex-col bg-background">
        <header className="h-12 border-b border-border flex items-center justify-between px-4 shrink-0">
          <span className="font-semibold">LowStar's Teahouse</span>
          <div className="flex items-center gap-1">
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
      <div className="h-screen flex flex-col overflow-hidden bg-background">
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
    <div className="h-screen flex flex-col overflow-hidden bg-background">
      <header className="h-14 border-b border-border flex items-center justify-between px-5 shrink-0 relative z-[60] bg-background">
        <div className="flex items-center gap-3 min-w-0">
          <div className="flex items-baseline gap-2 min-w-0">
            <span className="font-semibold whitespace-nowrap">LowStar's Teahouse</span>
            <span className="text-xs text-muted-foreground truncate">基于 Harness 的交互式小说创作引擎</span>
          </div>
          {activeInstance && (
            <div className="flex items-center gap-2 shrink-0">
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5 text-xs"
                onClick={() => {
                  setActiveInstance(null)
                  navigate("/", { replace: true })
                }}
                title="返回会话选择"
              >
                <ArrowLeft className="h-3.5 w-3.5" />
                返回大厅
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
                  游玩
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
                  后台
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
