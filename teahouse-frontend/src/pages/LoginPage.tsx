import { useState, type FormEvent } from "react"
import { Loader2, Eye, EyeOff, AlertTriangle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { useAuthActions } from "@/stores/authStore"
import { authApi } from "@/lib/api"
import { getApiBaseUrl, setApiBaseUrl } from "@/lib/apiBaseUrl"

export function LoginPage() {
  const { setAuth } = useAuthActions()
  const [mode, setMode] = useState<"login" | "register">("login")
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [displayName, setDisplayName] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [showPassword, setShowPassword] = useState(false)
  const [apiUrl, setApiUrl] = useState(getApiBaseUrl)

  const handleLogin = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    if (!username.trim() || !password.trim()) {
      setError("请输入用户名和密码")
      return
    }
    setIsLoading(true)
    try {
      const result = await authApi.login(username, password)
      if (result.ok && result.data?.token && result.data?.user) {
        setAuth(result.data.user, result.data.token)
      } else {
        setError(result.error || "登录失败")
      }
    } catch {
      setError("网络错误，请检查连接")
    } finally {
      setIsLoading(false)
    }
  }

  const handleRegister = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    if (!username.trim() || !password.trim()) {
      setError("请填写所有必填字段")
      return
    }
    if (password.length < 6) {
      setError("密码长度不能少于 6 位")
      return
    }
    setIsLoading(true)
    try {
      const result = await authApi.register(username, password, displayName || undefined)
      if (result.ok && result.data?.token && result.data?.user) {
        setAuth(result.data.user, result.data.token)
      } else {
        setError(result.error || "注册失败")
      }
    } catch {
      setError("网络错误，请检查连接")
    } finally {
      setIsLoading(false)
    }
  }

  const isRegister = mode === "register"
  const isDefaultAdmin = username === "admin" && password === "admin123"

  return (
    <div className="h-full flex items-center justify-center bg-muted/30">
      <Card className="w-full max-w-md mx-4">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl">Teahouse</CardTitle>
          <CardDescription>
            {isRegister ? "创建新账号开始使用" : "登录到您的账号"}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={isRegister ? handleRegister : handleLogin} className="space-y-4">
            <div className="space-y-2">
              <label htmlFor="apiUrl" className="text-sm font-medium">
                后端地址
              </label>
              <Input
                id="apiUrl"
                value={apiUrl}
                onChange={(e) => {
                  setApiUrl(e.target.value)
                  setApiBaseUrl(e.target.value)
                }}
                placeholder="http://192.168.x.x:8000 或 http://服务器域名:8000"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
              />
            </div>

            <div className="space-y-2">
              <label htmlFor="username" className="text-sm font-medium">
                用户名
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
                  显示名 <span className="text-muted-foreground text-xs">（可选）</span>
                </label>
                <Input
                  id="displayName"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                />
              </div>
            )}

            <div className="space-y-2">
              <label htmlFor="password" className="text-sm font-medium">
                密码
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

            {isDefaultAdmin && (
              <div className="flex items-start gap-2 text-sm text-yellow-600 bg-yellow-500/10 border border-yellow-500/30 px-3 py-2 rounded-md">
                <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                <span>检测到默认管理员账号，请立即修改密码</span>
              </div>
            )}

            {error && (
              <div className="text-sm text-destructive bg-destructive/10 px-3 py-2 rounded-md">
                {error}
              </div>
            )}

            <Button type="submit" className="w-full" disabled={isLoading}>
              {isLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {isRegister ? "注册" : "登录"}
            </Button>

            <div className="text-center text-sm text-muted-foreground">
              {isRegister ? "已有账号？" : "没有账号？"}
              <button
                type="button"
                className="text-primary hover:underline ml-1"
                onClick={() => { setMode(isRegister ? "login" : "register"); setError(null) }}
              >
                {isRegister ? "去登录" : "注册新账号"}
              </button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
