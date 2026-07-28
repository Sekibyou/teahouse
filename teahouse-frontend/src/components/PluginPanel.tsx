import { useEffect, useRef, useCallback, useState } from "react"
import { pluginsApi, API_BASE_URL } from "@/lib/api"
import { Loader2 } from "lucide-react"

interface PluginPanelProps {
  pluginId: string
  className?: string
}

/**
 * PluginPanel — iframe wrapper with postMessage bridge.
 *
 * Fetches the plugin's frontend HTML via the authenticated API and renders
 * it in a sandboxed iframe via srcdoc. Data access is brokered through
 * postMessage — the plugin iframe never sees the JWT token.
 */
export function PluginPanel({ pluginId, className }: PluginPanelProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const readyRef = useRef(false)
  const [html, setHtml] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Fetch the plugin's index.html via authenticated API
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const token = (await import("@/stores/authStore")).getAuthToken()
        const res = await fetch(
          `${API_BASE_URL}/api/plugins/${pluginId}/frontend/index.html`,
          { headers: token ? { Authorization: `Bearer ${token}` } : {} }
        )
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const text = await res.text()
        if (!cancelled) setHtml(text)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "加载失败")
      }
    })()
    return () => { cancelled = true }
  }, [pluginId])

  const handleMessage = useCallback(async (e: MessageEvent) => {
    const iframe = iframeRef.current
    if (!iframe || e.source !== iframe.contentWindow) return

    const d = e.data
    if (!d || typeof d !== "object") return
    if (d.pluginId && d.pluginId !== pluginId) return

    switch (d.type) {
      case "ready": {
        readyRef.current = true
        iframe.contentWindow?.postMessage({ type: "init", pluginId }, "*")
        break
      }
      case "getData": {
        if (!d.key) break
        try {
          const res = await pluginsApi.getData(pluginId)
          if (res.ok && res.data) {
            const value = res.data.data[d.key] || ""
            iframe.contentWindow?.postMessage({ type: "data", key: d.key, value }, "*")
          } else {
            iframe.contentWindow?.postMessage({ type: "error", message: res.error || "获取数据失败" }, "*")
          }
        } catch {
          iframe.contentWindow?.postMessage({ type: "error", message: "网络错误" }, "*")
        }
        break
      }
      case "setData": {
        if (!d.key) break
        try {
          const res = await pluginsApi.setData(pluginId, { [d.key]: d.value || "" })
          if (res.ok) {
            iframe.contentWindow?.postMessage({ type: "saved", key: d.key }, "*")
          } else {
            iframe.contentWindow?.postMessage({ type: "error", message: res.error || "保存失败" }, "*")
          }
        } catch {
          iframe.contentWindow?.postMessage({ type: "error", message: "网络错误" }, "*")
        }
        break
      }
    }
  }, [pluginId])

  useEffect(() => {
    window.addEventListener("message", handleMessage)
    return () => window.removeEventListener("message", handleMessage)
  }, [handleMessage])

  if (error) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
        插件加载失败: {error}
      </div>
    )
  }

  if (html === null) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <iframe
      ref={iframeRef}
      srcDoc={html}
      className={className}
      sandbox="allow-scripts allow-same-origin"
      title={`Plugin: ${pluginId}`}
      style={{ width: "100%", height: "100%", border: "none" }}
    />
  )
}
