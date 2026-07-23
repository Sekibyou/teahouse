import { Sun, Moon, LogOut, User, Settings } from "lucide-react"
import { useEffect, useState } from "react"
import { Outlet, useNavigate } from "react-router-dom"
import { Button } from "@/components/ui/button"
import { useAuth, useAuthActions } from "@/stores/authStore"
import { LoginPage } from "@/pages/LoginPage"

export function MainLayout() {
  const { isAuthenticated, isLoading, user } = useAuth()
  const { clearAuth } = useAuthActions()
  const navigate = useNavigate()
  const [isDark, setIsDark] = useState(() => {
    const saved = localStorage.getItem("theme")
    const shouldBeDark = saved ? saved === "dark" : true
    document.documentElement.classList.toggle("dark", shouldBeDark)
    return shouldBeDark
  })

  const toggleTheme = () => {
    setIsDark(!isDark)
    document.documentElement.classList.toggle("dark", !isDark)
    localStorage.setItem("theme", isDark ? "light" : "dark")
  }

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
          <span className="font-semibold">Teahouse</span>
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

  return (
    <div className="h-screen flex flex-col overflow-hidden bg-background">
      <header className="h-12 border-b border-border flex items-center justify-between px-4 shrink-0">
        <span className="font-semibold">Teahouse</span>
        <div className="flex items-center gap-1">
          <div className="flex items-center gap-2 mr-2 text-sm text-muted-foreground">
            <User className="h-4 w-4" />
            <span>{user?.display_name || user?.username}</span>
          </div>
          <Button variant="ghost" size="icon" onClick={toggleTheme}>
            {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </Button>
          <Button variant="ghost" size="icon" onClick={() => navigate("/settings")}>
            <Settings className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="icon" onClick={clearAuth}>
            <LogOut className="h-4 w-4" />
          </Button>
        </div>
      </header>

      <div className="flex-1 flex overflow-hidden">
        <main className="flex-1 overflow-auto">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
