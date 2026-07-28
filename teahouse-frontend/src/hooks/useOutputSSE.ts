import { useEffect, useRef } from "react"
import { API_BASE_URL } from "@/lib/api"
import type { ContentType } from "@/lib/types"

export interface OutputBlock {
  uuid: string
  label: string
  note: string
  rendered: string
  content_type?: ContentType
}

interface UseOutputSSEOptions {
  instanceId: string | undefined
  instanceName: string | undefined
  onAppend: (block: OutputBlock) => void
  onReplace: (block: OutputBlock) => void
  onDelete: (uuid: string) => void
}

/**
 * Connects to GET /events SSE stream and listens for output.append,
 * output.replace, and output.delete events for the current instance.
 *
 * Filtering: events carry an instance_id field which may be the DB UUID
 * (from routes layer) or the directory name (from tool executors).
 * We accept the event if it matches either.
 */
export function useOutputSSE({
  instanceId,
  instanceName,
  onAppend,
  onReplace,
  onDelete,
}: UseOutputSSEOptions) {
  const callbacksRef = useRef({ onAppend, onReplace, onDelete })
  callbacksRef.current = { onAppend, onReplace, onDelete }

  useEffect(() => {
    if (!instanceId) return

    let stopped = false

    const connect = () => {
      if (stopped) return

      const es = new EventSource(`${API_BASE_URL}/events`)
      const handler = (e: MessageEvent) => {
        try {
          const data = JSON.parse(e.data)
          // Accept event if instance_id matches UUID OR directory name
          const id = data.instance_id
          if (id && id !== instanceId && id !== instanceName) return

          const cb = callbacksRef.current
          if (e.type === "output.append") {
            cb.onAppend({
              uuid: data.uuid,
              label: data.label,
              note: data.note,
              rendered: data.rendered,
              content_type: data.content_type,
            })
          } else if (e.type === "output.replace") {
            cb.onReplace({
              uuid: data.uuid,
              label: data.label,
              note: data.note,
              rendered: data.rendered,
              content_type: data.content_type,
            })
          } else if (e.type === "output.delete") {
            cb.onDelete(data.uuid)
          }
        } catch {
          // ignore malformed events
        }
      }

      es.addEventListener("output.append", handler)
      es.addEventListener("output.replace", handler)
      es.addEventListener("output.delete", handler)

      es.onerror = () => {
        es.close()
        if (!stopped) {
          setTimeout(connect, 3000)
        }
      }
    }

    connect()

    return () => {
      stopped = true
    }
  }, [instanceId, instanceName])
}
