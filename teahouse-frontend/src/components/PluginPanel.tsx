import { useEffect, useRef, useCallback } from "react"
import { pluginsApi, API_BASE_URL } from "@/lib/api"

interface PluginPanelProps {
  pluginId: string
  className?: string
}

/**
 * PluginPanel — iframe wrapper with postMessage bridge.
 *
 * Loads an enabled plugin's frontend (served from /plugin/{pluginId}/)
 * in a sandboxed iframe and brokers data access through the main app's
 * authenticated API layer. The plugin iframe never sees the JWT token.
 *
 * Bridge protocol:
 *   plugin → bridge: {type: "ready", pluginId}     handshake
 *   plugin → bridge: {type: "getData", key}         request decrypted data
 *   plugin → bridge: {type: "setData", key, value}  write encrypted data
 *   bridge → plugin: {type: "init", pluginId}       handshake response
 *   bridge → plugin: {type: "data", key, value}     return decrypted data
 *   bridge → plugin: {type: "saved", key}           confirm save
 *   bridge → plugin: {type: "error", message}       error feedback
 */
export function PluginPanel({ pluginId, className }: PluginPanelProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const readyRef = useRef(false)

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

  return (
    <iframe
      ref={iframeRef}
      src={`${API_BASE_URL}/plugin/${pluginId}/`}
      className={className}
      sandbox="allow-scripts allow-same-origin"
      title={`Plugin: ${pluginId}`}
      style={{ width: "100%", height: "100%", border: "none" }}
    />
  )
}
