import { useEffect, useRef, useCallback } from "react"
import { API_BASE_URL } from "@/lib/api"

export interface OutputBlock {
  uuid: string
  label: string
  note: string
  rendered: string
}

interface UseOutputSSEOptions {
  instanceId: string | undefined
  onAppend: (block: OutputBlock) => void
  onReplace: (block: OutputBlock) => void
  onDelete: (uuid: string) => void
}

/**
 * Connects to GET /events SSE stream and listens for output.append,
 * output.replace, and output.delete events for the current instance.
 */
export function useOutputSSE({
  instanceId,
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
          if (data.instance_id && data.instance_id !== instanceId) return

          const cb = callbacksRef.current
          if (e.type === "output.append") {
            cb.onAppend({
              uuid: data.uuid,
              label: data.label,
              note: data.note,
              rendered: data.rendered,
            })
          } else if (e.type === "output.replace") {
            cb.onReplace({
              uuid: data.uuid,
              label: data.label,
              note: data.note,
              rendered: data.rendered,
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
  }, [instanceId])
}
