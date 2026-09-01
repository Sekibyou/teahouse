import { useEffect, useState, type FormEvent } from "react"
import { useTranslation } from "react-i18next"
import { Loader2, Eye, EyeOff } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { useAuthActions } from "@/stores/authStore"
import { authApi } from "@/lib/api"

export function LoginPage() {
  const { t } = useTranslation("login")
  const { setAuth } = useAuthActions()
  const [mode, setMode] = useState<"login" | "register">("login")
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [displayName, setDisplayName] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [showPassword, setShowPassword] = useState(false)
  const [allowRegistration, setAllowRegistration] = useState(false)
  const [registrationMode, setRegistrationMode] = useState<"disabled" | "open" | "invite">("disabled")
  const [inviteKey, setInviteKey] = useState("")

  useEffect(() => {
    let active = true
    authApi.registrationStatus().then((res) => {
      if (active) {
        const mode = res.data?.mode ?? "disabled"
        const open = !!res.data?.allow_registration || mode !== "disabled"
        setRegistrationMode(mode)
        setAllowRegistration(open)
        if (!open) setMode("login") // 关闭注册时不允许停留在注册表单
      }
    })
    return () => {
      active = false
    }
  }, [])

  const handleLogin = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    if (!username.trim() || !password.trim()) {
      setError(t("loginRequired"))
      return
    }
    setIsLoading(true)
    try {
      const result = await authApi.login(username, password)
      if (result.ok && result.data?.token && result.data?.user) {
        setAuth(result.data.user, result.data.token)
      } else {
        // 429 -> frozen for too many attempts; 401 -> bad credentials; else fallback
        setError(
          result.status === 429
            ? t("tooManyAttempts")
            : result.status === 401
              ? t("invalidCredentials")
              : result.error || t("loginFail")
        )
      }
    } catch {
      setError(t("networkError"))
    } finally {
      setIsLoading(false)
    }
  }

  const handleRegister = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    if (!username.trim() || !password.trim()) {
      setError(t("registerRequired"))
      return
    }
    if (password.length < 6) {
      setError(t("passwordMinLength"))
      return
    }
    if (registrationMode === "invite" && !inviteKey.trim()) {
      setError(t("inviteKeyRequired"))
      return
    }
    setIsLoading(true)
    try {
      const result = await authApi.register(username, password, displayName || undefined, inviteKey.trim() || undefined)
      if (result.ok && result.data?.token && result.data?.user) {
        setAuth(result.data.user, result.data.token)
      } else {
        // 409 -> username taken; 403 -> registration disabled; else fallback
        setError(
          result.status === 409
            ? t("usernameTaken")
            : result.status === 403
              ? t("registrationDisabled")
              : result.error || t("registerFail")
        )
      }
    } catch {
      setError(t("networkError"))
    } finally {
      setIsLoading(false)
    }
  }

  const isRegister = mode === "register"

  return (
    <div className="h-full flex items-center justify-center bg-muted/30">
      <Card className="w-full max-w-md mx-4">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl">{t("title")}</CardTitle>
          <CardDescription>
            {isRegister
              ? registrationMode === "invite"
                ? t("subtitleRegisterInvite")
                : t("subtitleRegister")
              : t("subtitleLogin")}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={isRegister ? handleRegister : handleLogin} className="space-y-4">
            <div className="space-y-2">
              <label htmlFor="username" className="text-sm font-medium">
                {t("username")}
              </label>
              <Input
                id="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
              />
            </div>

            {isRegister && (
              <div className="space-y-2">
                <label htmlFor="displayName" className="text-sm font-medium">
                  {t("displayName")} <span className="text-muted-foreground text-xs">{t("displayNameOptional")}</span>
                </label>
                <Input
                  id="displayName"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                />
              </div>
            )}

            {isRegister && registrationMode === "invite" && (
              <div className="space-y-2">
                <label htmlFor="inviteKey" className="text-sm font-medium">
                  {t("inviteKey")}
                </label>
                <Input
                  id="inviteKey"
                  value={inviteKey}
                  onChange={(e) => setInviteKey(e.target.value)}
                  placeholder={t("inviteKeyPlaceholder")}
                />
              </div>
            )}

            <div className="space-y-2">
              <label htmlFor="password" className="text-sm font-medium">
                {t("password")}
              </label>
              <div className="relative">
                <Input
                  id="password"
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="pr-9"
                  autoComplete={isRegister ? "new-password" : "current-password"}
                />
                <button
                  type="button"
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  onClick={() => setShowPassword(!showPassword)}
                  tabIndex={-1}
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>

            {error && (
              <div className="text-sm text-destructive bg-destructive/10 px-3 py-2 rounded-md">
                {error}
              </div>
            )}

            <Button type="submit" className="w-full" disabled={isLoading}>
              {isLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {isRegister ? t("submitRegister") : t("submitLogin")}
            </Button>

            {allowRegistration && (
              <div className="text-center text-sm text-muted-foreground">
                {isRegister ? t("switchToLogin") : registrationMode === "invite" ? t("switchToRegisterInvite") : t("switchToRegister")}
                <button
                  type="button"
                  className="text-primary hover:underline ml-1"
                  onClick={() => { setMode(isRegister ? "login" : "register"); setError(null) }}
                >
                  {isRegister ? t("goLogin") : t("goRegister")}
                </button>
              </div>
            )}
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
