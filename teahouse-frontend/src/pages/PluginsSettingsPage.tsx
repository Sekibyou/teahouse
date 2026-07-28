import { useEffect, useState } from "react"
import { ArrowLeft, Loader2, Puzzle, Shield, Power, PowerOff } from "lucide-react"
import { useNavigate } from "react-router-dom"
import { Button } from "@/components/ui/button"
import { pluginsApi } from "@/lib/api"
import { PluginPanel } from "@/components/PluginPanel"
import type { Plugin } from "@/lib/pluginTypes"

export function PluginsSettingsPage() {
  const navigate = useNavigate()
  const [plugins, setPlugins] = useState<Plugin[]>([])
  const [loading, setLoading] = useState(true)
  const [toggling, setToggling] = useState<Set<string>>(new Set())
  const [configPlugin, setConfigPlugin] = useState<Plugin | null>(null)

  const load = async () => {
    setLoading(true)
    const res = await pluginsApi.list()
    if (res.ok) setPlugins(res.data!.plugins)
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  const handleToggle = async (p: Plugin) => {
    setToggling((prev) => new Set(prev).add(p.id))
    if (p.enabled) {
      await pluginsApi.disable(p.id)
    } else {
      await pluginsApi.enable(p.id)
    }
    await load()
    setToggling((prev) => {
      const next = new Set(prev)
      next.delete(p.id)
      return next
    })
  }

  const permLabels: Record<string, string> = {
    tool: "导演工具",
    frontend: "前端面板",
    network: "网络请求",
    file_read: "读取文件",
    file_write: "写入文件",
  }

  return (
    <div className="h-full flex flex-col max-w-2xl mx-auto">
      <div className="flex items-center justify-between px-6 py-4 border-b border-border shrink-0">
        <div className="flex items-center gap-3">
          <button className="p-1 rounded hover:bg-muted" onClick={() => navigate(-1)} title="返回">
            <ArrowLeft className="h-4 w-4" />
          </button>
          <h2 className="text-lg font-semibold">插件管理</h2>
        </div>
      </div>

      {loading ? (
        <div className="flex-1 flex items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <div className="flex-1 overflow-auto p-6 space-y-6">
          {plugins.length === 0 ? (
            <div className="text-center text-muted-foreground py-12">
              <Puzzle className="h-12 w-12 mx-auto mb-3 opacity-20" />
              <p className="text-sm">暂无可用插件</p>
              <p className="text-xs mt-1 opacity-60">将插件放入 plugins/ 目录后自动发现</p>
            </div>
          ) : (
            <div className="space-y-4">
              <p className="text-xs text-muted-foreground">
                已发现 {plugins.length} 个插件。启用后可配置参数并在导演工具中使用。
              </p>
              {plugins.map((p) => (
                <div key={p.id} className="rounded-lg border p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="font-medium flex items-center gap-2">
                        {p.name}
                        <span className="text-[10px] text-muted-foreground font-normal">
                          v{p.version}
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5">{p.description}</p>
                    </div>
                    <Button
                      size="sm"
                      variant={p.enabled ? "default" : "outline"}
                      onClick={() => handleToggle(p)}
                      disabled={toggling.has(p.id)}
                      className="shrink-0"
                    >
                      {toggling.has(p.id) ? (
                        <Loader2 className="h-3 w-3 animate-spin mr-1" />
                      ) : p.enabled ? (
                        <PowerOff className="h-3 w-3 mr-1" />
                      ) : (
                        <Power className="h-3 w-3 mr-1" />
                      )}
                      {p.enabled ? "已启用" : "已禁用"}
                    </Button>
                  </div>

                  {/* Permissions */}
                  <div className="flex flex-wrap gap-1.5">
                    {p.permissions.map((perm) => (
                      <span
                        key={perm}
                        className="inline-flex items-center gap-1 text-[10px] bg-muted/50 px-1.5 py-0.5 rounded"
                      >
                        <Shield className="h-2.5 w-2.5" />
                        {permLabels[perm] || perm}
                      </span>
                    ))}
                    <span className="text-[10px] text-muted-foreground ml-1">
                      {p.has_backend ? "· 后端" : ""}{p.has_frontend ? "· 前端" : ""}
                    </span>
                  </div>

                  {/* Config panel button (only when enabled and has frontend) */}
                  {p.enabled && p.has_frontend && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setConfigPlugin(configPlugin?.id === p.id ? null : p)}
                      className="text-xs"
                    >
                      <Puzzle className="h-3 w-3 mr-1" />
                      {configPlugin?.id === p.id ? "关闭配置面板" : "打开配置面板"}
                    </Button>
                  )}

                  {/* Inline config panel */}
                  {configPlugin?.id === p.id && (
                    <div className="border rounded-md overflow-hidden" style={{ height: 280 }}>
                      <PluginPanel pluginId={p.id} className="w-full h-full" />
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
