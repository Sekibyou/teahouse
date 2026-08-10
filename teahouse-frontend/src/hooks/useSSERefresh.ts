import { useEffect, useRef } from "react"
import { API_BASE_URL } from "@/lib/api"
import type { FileTreeNode } from "@/lib/types"
import { useGitStore } from "@/stores/gitStore"

interface SSERefreshOptions {
  /** Called when a single file was modified (Write, Edit, WriteLine, GitDiscard single file). */
  onFileChanged: (path: string) => void
  /** Called when workspace state changed (git operations, branch switch, etc.). */
  onWorkspaceChanged: () => void
  /** Called when a runTool background step broadcast a result (success or failure). */
  onToolRun?: (payload: Record<string, unknown>) => void
  /** Called when a streaming Generate broadcasts a progress tick (~200ms, carries diff). */
  onGenerateProgress?: (payload: Record<string, unknown>) => void
  /** Called when a sub-session broadcasts session_done (EndSession) or session_destroyed. */
  onSessionEvent?: (event: string, payload: Record<string, unknown>) => void
  /** The instance ID (UUID) to scope events to. */
  instanceId: string | undefined
  /** The instance name (directory name) as fallback match for tool-executor broadcasts. */
  instanceName: string | undefined
  /** Optional periodic file-tree polling as a backstop for backend broadcasts
   * that are missing (e.g. Generate dump_payload). When set, every tick fetches
   * the tree via onPollFetch, compares it against the previous snapshot, and
   * only fires onPollTick when the tree actually changed. */
  pollIntervalMs?: number
  /** Fetches the current file tree for the poll dirty-check. */
  onPollFetch?: () => Promise<FileTreeNode[]>
  /** Called when the poll detects a tree change, with the freshly-fetched tree. */
  onPollTick?: (tree: FileTreeNode[]) => void
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
  onToolRun,
  onGenerateProgress,
  onSessionEvent,
  instanceId,
  instanceName,
  pollIntervalMs,
  onPollFetch,
  onPollTick,
}: SSERefreshOptions) {
  const esRef = useRef<EventSource | null>(null)
  const fileTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const wsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastFilePathRef = useRef<string>("")
  const lastTreeKeyRef = useRef<string>("")
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  // Latest poll callbacks, read via ref so the interval never has to re-arm
  // when their identity changes (stable across renders).
  const pollRefs = useRef({ onPollFetch, onPollTick })
  pollRefs.current.onPollFetch = onPollFetch
  pollRefs.current.onPollTick = onPollTick

  useEffect(() => {
    if (!instanceId) return

    let stopped = false

    // A stable snapshot key for the tree, so identical polls are no-ops.
    const treeKey = (nodes: FileTreeNode[]): string =>
      nodes.map((n) => (n.children?.length ? `dir:${n.path}` : `file:${n.path}`)).sort().join("\n")

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

      es.addEventListener("tool_run", (e: MessageEvent) => {
        try {
          const data = JSON.parse(e.data)
          const id = data.instance_id
          if (id && id !== instanceId && id !== instanceName) return
          onToolRun?.(data)
        } catch {
          // ignore malformed events
        }
      })

      es.addEventListener("generate_progress", (e: MessageEvent) => {
        try {
          const data = JSON.parse(e.data)
          const id = data.instance_id
          if (id && id !== instanceId && id !== instanceName) return
          onGenerateProgress?.(data)
        } catch {
          // ignore malformed events
        }
      })

      for (const evt of ["session_done", "session_destroyed", "session_created"]) {
        es.addEventListener(evt, (e: MessageEvent) => {
          try {
            const data = JSON.parse(e.data)
            const id = data.instance_id
            if (id && id !== instanceId && id !== instanceName) return
            onSessionEvent?.(evt, data)
          } catch {
            // ignore malformed events
          }
        })
      }

      es.onerror = () => {
        es.close()
        esRef.current = null
        if (!stopped) {
          // Reconnect after 3 seconds
          setTimeout(connect, 3000)
        }
      }
    }

    if (pollIntervalMs && pollIntervalMs > 0 && onPollFetch && onPollTick) {
      const tick = async () => {
        try {
          const tree = await pollRefs.current.onPollFetch!()
          if (!tree) return
          const key = treeKey(tree)
          if (key !== lastTreeKeyRef.current) {
            lastTreeKeyRef.current = key
            pollRefs.current.onPollTick!(tree)
          }
        } catch {
          // transient error — skip this tick
        }
      }
      // Seed baseline on start so the first real change is detected.
      tick()
      pollTimerRef.current = setInterval(tick, pollIntervalMs)
    }

    connect()

    return () => {
      stopped = true
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current)
        pollTimerRef.current = null
      }
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
  }, [instanceId, instanceName, onToolRun, onGenerateProgress, onSessionEvent, pollIntervalMs])
}
