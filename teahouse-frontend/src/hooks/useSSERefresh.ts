import { useEffect, useRef } from "react"
import { getApiBaseUrl } from "@/lib/apiBaseUrl"
import type { FileTreeNode } from "@/lib/types"
import { useGitStore } from "@/stores/gitStore"

interface SSERefreshOptions {
  /** Called when a single file was modified (Write, Edit, WriteLine, GitDiscard single file).
   * Receives the bare path plus the full parsed file_changed payload (may carry
   * `type` / `prev_path` when the backend annotated it) so consumers can do
   * type-aware partial tree updates instead of an unconditional full reload. */
  onFileChanged: (path: string, event?: Record<string, unknown>) => void
  /** Called when workspace state changed (git operations, branch switch, etc.). */
  onWorkspaceChanged: () => void
  /** Called when a runTool background step broadcast a result (success or failure). */
  onToolRun?: (payload: Record<string, unknown>) => void
  /** Called when a streaming Generate broadcasts a progress tick (~200ms, carries diff). */
  onGenerateProgress?: (payload: Record<string, unknown>) => void
  /** Called when a sub-session broadcasts session_done (EndSession), session_destroyed
   * (DeleteSubSession), session_created, or a runTool batch is cancelled (tool_run_cancelled). */
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
 * one LLM round) are coalesced — the last event in the burst is delivered
 * (with its `type` when present), and git status is fetched once after the
 * burst settles. Consumers use the delivered event to decide whether a
 * structural tree update is needed (created/deleted/moved) or just a content
 * touch (modified) that does not change tree shape.
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
  const lastFileEventRef = useRef<Record<string, unknown>>({})
  const burstStructuralRef = useRef(false)
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

    const debouncedFileChange = (evt: Record<string, unknown>) => {
      // A burst is a 200ms window of coalesced events. We can only deliver ONE
      // representative event to the consumer, which is fine when every event in
      // the burst was a content edit (modified). But if the burst mixes
      // structural events (created/deleted/moved) such that a single event can't
      // reconstruct the final shape — e.g. mkdir + Write: the created dir would
      // be dropped if we delivered only the last modified — we flag it and the
      // consumer falls back to a full reload.
      const t = evt.type ? String(evt.type) : ""
      if (t === "created" || t === "deleted" || t === "moved") burstStructuralRef.current = true
      lastFileEventRef.current = evt
      if (fileTimerRef.current) return
      fileTimerRef.current = setTimeout(() => {
        fileTimerRef.current = null
        const structuralInBurst = burstStructuralRef.current
        burstStructuralRef.current = false
        if (instanceId) {
          useGitStore.getState().fetchGitStatus(instanceId)
        }
        const last = lastFileEventRef.current
        const delivered = { ...last }
        // Deliver a synthetic type telling consumers to reload rather than apply
        // a partial update that would drop a structural change from this burst.
        if (structuralInBurst && (!delivered.type || String(delivered.type) === "modified")) {
          delivered.type = "__full_reload"
        }
        onFileChanged(String(delivered.path || ""), delivered)
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

      const es = new EventSource(`${getApiBaseUrl()}/events`)
      esRef.current = es

      es.addEventListener("file_changed", (e: MessageEvent) => {
        try {
          const data = JSON.parse(e.data)
          const id = data.instance_id
          if (id && id !== instanceId && id !== instanceName) return
          debouncedFileChange(data || {})
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

      for (const evt of ["session_done", "session_destroyed", "session_created", "tool_run_cancelled"]) {
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
