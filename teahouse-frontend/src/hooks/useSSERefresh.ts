import { useEffect, useRef } from "react"
import { API_BASE_URL } from "@/lib/api"
import { useGitStore } from "@/stores/gitStore"

interface SSERefreshOptions {
  /** Called when a single file was modified (Write, Edit, WriteLine, GitDiscard single file). */
  onFileChanged: (path: string) => void
  /** Called when workspace state changed (git operations, branch switch, etc.). */
  onWorkspaceChanged: () => void
  /** The instance ID (UUID) to scope events to. */
  instanceId: string | undefined
  /** The instance name (directory name) as fallback match for tool-executor broadcasts. */
  instanceName: string | undefined
}

const DEBOUNCE_MS = 200

/**
 * Connects to GET /events SSE stream and triggers refresh callbacks
 * when the backend broadcasts file_changed or workspace_changed events
 * for the current instance.
 *
 * Filtering: events carry an instance_id field which may be the DB UUID
 * (from routes layer) or the directory name (from tool executors).
 * We accept the event if it matches either.
 *
 * Debouncing: rapid successive events (e.g. multiple Write tool calls in
 * one LLM round) are coalesced — only the last path in the burst is
 * delivered, and git status is fetched once after the burst settles.
 *
 * Automatically reconnects on disconnect. Cleans up on unmount or
 * instance change.
 */
export function useSSERefresh({
  onFileChanged,
  onWorkspaceChanged,
  instanceId,
  instanceName,
}: SSERefreshOptions) {
  const esRef = useRef<EventSource | null>(null)
  const fileTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const wsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastFilePathRef = useRef<string>("")

  useEffect(() => {
    if (!instanceId) return

    let stopped = false

    const debouncedFileChange = (path: string) => {
      lastFilePathRef.current = path
      if (fileTimerRef.current) return
      fileTimerRef.current = setTimeout(() => {
        fileTimerRef.current = null
        if (instanceId) {
          useGitStore.getState().fetchGitStatus(instanceId)
        }
        onFileChanged(lastFilePathRef.current)
      }, DEBOUNCE_MS)
    }

    const debouncedWorkspaceChange = () => {
      if (wsTimerRef.current) return
      wsTimerRef.current = setTimeout(() => {
        wsTimerRef.current = null
        if (instanceId) {
          useGitStore.getState().fetchGitStatus(instanceId)
        }
        onWorkspaceChanged()
      }, DEBOUNCE_MS)
    }

    const connect = () => {
      if (stopped) return

      const es = new EventSource(`${API_BASE_URL}/events`)
      esRef.current = es

      es.addEventListener("file_changed", (e: MessageEvent) => {
        try {
          const data = JSON.parse(e.data)
          const id = data.instance_id
          if (id && id !== instanceId && id !== instanceName) return
          debouncedFileChange(data.path || "")
        } catch {
          // ignore malformed events
        }
      })

      es.addEventListener("workspace_changed", (e: MessageEvent) => {
        try {
          const data = JSON.parse(e.data)
          const id = data.instance_id
          if (id && id !== instanceId && id !== instanceName) return
          debouncedWorkspaceChange()
        } catch {
          debouncedWorkspaceChange()
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
      if (fileTimerRef.current) {
        clearTimeout(fileTimerRef.current)
        fileTimerRef.current = null
      }
      if (wsTimerRef.current) {
        clearTimeout(wsTimerRef.current)
        wsTimerRef.current = null
      }
    }
  }, [instanceId, instanceName])
}
