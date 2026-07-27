import { useEffect, useRef } from "react"
import { API_BASE_URL } from "@/lib/api"

interface SSERefreshOptions {
  /** Called when a single file was modified (Write, Edit, WriteLine, GitDiscard single file). */
  onFileChanged: (path: string) => void
  /** Called when workspace state changed (git operations, branch switch, etc.). */
  onWorkspaceChanged: () => void
  /** The instance ID to scope events to. Events for other instances are ignored. */
  instanceId: string | undefined
}

/**
 * Connects to GET /events SSE stream and triggers refresh callbacks
 * when the backend broadcasts file_changed or workspace_changed events
 * for the current instance.
 *
 * Automatically reconnects on disconnect. Cleans up on unmount or
 * instance change.
 */
export function useSSERefresh({
  onFileChanged,
  onWorkspaceChanged,
  instanceId,
}: SSERefreshOptions) {
  const esRef = useRef<EventSource | null>(null)

  useEffect(() => {
    if (!instanceId) return

    let stopped = false

    const connect = () => {
      if (stopped) return

      const es = new EventSource(`${API_BASE_URL}/events`)
      esRef.current = es

      es.addEventListener("file_changed", (e: MessageEvent) => {
        try {
          const data = JSON.parse(e.data)
          // Filter by instance — only react to events for the current instance
          if (data.instance_id && data.instance_id !== instanceId) return
          onFileChanged(data.path || "")
        } catch {
          // ignore malformed events
        }
      })

      es.addEventListener("workspace_changed", (e: MessageEvent) => {
        try {
          const data = JSON.parse(e.data)
          if (data.instance_id && data.instance_id !== instanceId) return
          onWorkspaceChanged()
        } catch {
          onWorkspaceChanged()
        }
      })

      es.onerror = () => {
        es.close()
        esRef.current = null
        if (!stopped) {
          // Reconnect after 3 seconds
          setTimeout(connect, 3000)
        }
      }
    }

    connect()

    return () => {
      stopped = true
      if (esRef.current) {
        esRef.current.close()
        esRef.current = null
      }
    }
  }, [instanceId])
}
