import { useEffect, useRef, useCallback, useState } from "react"
import type { OutputBlock } from "@/hooks/useOutputSSE"
import type { ContentType } from "@/lib/types"
import { getBBCodeAnimationCSS } from "@/lib/bbcodeParser"
import { renderText } from "@/lib/htmlSanitizer"
import { outputBlocksApi, instancesApi } from "@/lib/api"

// ============================================================
// SandboxManager — unified sandbox iframe + TeahouseBridge
// ============================================================

interface SandboxManagerProps {
  instanceId: string | undefined
  instanceName: string | undefined
  blocks: OutputBlock[]
  onSend?: (message: string) => void
  isEmpty: boolean
}

/**
 * Lifecycle:
 * 1. On mount / blocks change: detect bootstrap_js block
 * 2. Fetch full rendered content for bootstrap + css + ui_js + scene_js blocks
 * 3. Build srcdoc with ALL code injected, set on iframe
 * 4. Sandbox boots → sends {_type: "ready"} → host marks ready
 * 5. Host forwards SSE events into sandbox via postMessage
 * 6. Fallback: no bootstrap → host renders rich_text directly via renderText()
 */
export function SandboxManager({ instanceId, instanceName, blocks, onSend, isEmpty }: SandboxManagerProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const [sandboxReady, setSandboxReady] = useState(false)
  const [fallbackContent, setFallbackContent] = useState<string | null>(null)
  const [srcdoc, setSrcdoc] = useState<string | null>(null)

  // ---- Determine block types from the list ----
  const bootstrapBlock = blocks.find((b) => b.content_type === "bootstrap_js")
  const cssBlocks = blocks.filter((b) => b.content_type === "css")
  const uiBlocks = blocks.filter((b) => b.content_type === "ui_js")
  const sceneBlock = blocks.find((b) => b.content_type === "scene_js")

  // ---- Phase 1: Fetch full rendered content for code blocks, build srcdoc ----

  useEffect(() => {
    if (!instanceId || !bootstrapBlock) {
      setSrcdoc(null)
      return
    }

    let cancelled = false

    async function build() {
      // Fetch full data for each code block (list API only gives summary, no rendered)
      const fetchRendered = async (block: OutputBlock): Promise<string> => {
        if (block.rendered) return block.rendered
        const res = await outputBlocksApi.get(instanceId!, block.uuid)
        if (res.ok && res.data) return res.data.rendered
        return block.rendered || ""
      }

      const bootstrapRendered = await fetchRendered(bootstrapBlock!)
      if (cancelled) return

      // Fetch CSS blocks
      const cssRendered = await Promise.all(
        cssBlocks.map((b) => fetchRendered(b))
      )
      if (cancelled) return

      // Fetch UI JS blocks
      const uiRendered = await Promise.all(
        uiBlocks.map((b) => fetchRendered(b))
      )
      if (cancelled) return

      // Fetch scene JS block (injected into srcdoc so it's immediately available)
      const sceneRendered = sceneBlock ? await fetchRendered(sceneBlock) : null
      if (cancelled) return

      // Gather all styles: theme CSS + BBCode animation CSS
      const allStyles = [...cssRendered, getBBCodeAnimationCSS()]

      // Gather all scripts:
      // 1. postMessage bridge (inline)
      // 2. bootstrap.js
      // 3. scene.js (if present)
      // 4. ui_js blocks
      const scriptTags = [
        bootstrapRendered,
        sceneRendered,
        ...uiRendered,
      ].filter(Boolean).map((s) => `<script>${s}</script>`).join("\n")

      const styleTags = allStyles
        .filter(Boolean)
        .map((s) => `<style>${s}</style>`)
        .join("\n")

      const doc = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    html, body { margin: 0; padding: 0; width: 100%; min-height: 100%; }
  </style>
</head>
<body>
  <script>
// Teahouse Bridge — 沙盒内 postMessage 通信层
(function() {
  window.addEventListener('message', function(e) {
    var d = e.data;
    if (d && d._type === '_teahouse_event') {
      if (window.Teahouse && window.Teahouse._emit) {
        window.Teahouse._emit(d._event, d._data);
      }
    }
  });
})();
  </script>
  ${scriptTags}
  ${styleTags}
</body>
</html>`

      if (!cancelled) setSrcdoc(doc)
    }

    build()
    return () => { cancelled = true }
  }, [instanceId, bootstrapBlock?.uuid, sceneBlock?.uuid, cssBlocks.length, uiBlocks.length])

  // ---- Phase 2: Set srcdoc on iframe ----

  useEffect(() => {
    if (srcdoc && iframeRef.current) {
      iframeRef.current.srcdoc = srcdoc
    }
  }, [srcdoc])

  // ---- postMessage bridge — handle requests from sandbox ----

  const handleMessage = useCallback(async (e: MessageEvent) => {
    const iframe = iframeRef.current
    if (!iframe || e.source !== iframe.contentWindow) return

    const d = e.data
    if (!d || typeof d !== "object") return

    if (d._type === "ready") {
      setSandboxReady(true)
      iframe.contentWindow?.postMessage({ _type: "init", instanceId, instanceName }, "*")
      return
    }

    if (!d._method) return
    const { _method, _args, _callId } = d

    try {
      let result: unknown = undefined

      switch (_method) {
        case "listOutputBlocks": {
          if (instanceId) {
            const res = await outputBlocksApi.list(instanceId)
            result = res.ok ? res.data?.blocks : []
          }
          break
        }
        case "getOutputBlock": {
          if (instanceId && _args[0]) {
            const res = await outputBlocksApi.get(instanceId, _args[0] as string)
            result = res.ok ? res.data : null
          }
          break
        }
        case "renderRichText": {
          const text = _args[0] as string
          if (text) {
            result = renderText(text)
          }
          break
        }
        case "readFile": {
          if (instanceId && _args[0]) {
            const res = await instancesApi.readFile(instanceId, _args[0] as string)
            result = res.ok ? res.data?.content : null
          }
          break
        }
        case "writeFile": {
          if (instanceId && _args[0] && _args[1] !== undefined) {
            const res = await instancesApi.writeFile(instanceId, _args[0] as string, _args[1] as string)
            result = res.ok
          }
          break
        }
        case "send": {
          if (_args[0] && onSend) {
            onSend(_args[0] as string)
            result = true
          }
          break
        }
        case "activateScene": {
          // scene_js is already embedded in srcdoc and self-executes.
          // This is a no-op on the host; just acknowledge.
          result = true
          break
        }
      }

      iframe.contentWindow?.postMessage({ _callId, _result: result }, "*")
    } catch (err) {
      iframe.contentWindow?.postMessage({
        _callId,
        _error: err instanceof Error ? err.message : "Unknown error",
      }, "*")
    }
  }, [instanceId, instanceName, onSend])

  useEffect(() => {
    window.addEventListener("message", handleMessage)
    return () => window.removeEventListener("message", handleMessage)
  }, [handleMessage])

  // ---- Forward SSE events to sandbox (initial full sync + incremental deltas) ----

  const syncedRef = useRef(false)

  useEffect(() => {
    if (!sandboxReady || !iframeRef.current) return

    if (!syncedRef.current) {
      // Initial full sync: push all blocks once, EXCEPT code types already in srcdoc
      for (const block of blocks) {
        // bootstrap_js, scene_js, css, ui_js are already embedded in srcdoc
        // Only forward rich_text and text so the sandbox can render them
        if (block.content_type === "bootstrap_js" ||
            block.content_type === "scene_js" ||
            block.content_type === "css" ||
            block.content_type === "ui_js") {
          continue
        }
        sendToSandbox("output.append", block)
      }
      syncedRef.current = true
      return
    }
  }, [sandboxReady])

  function sendToSandbox(_event: string, _data: unknown) {
    iframeRef.current?.contentWindow?.postMessage({
      _type: "_teahouse_event",
      _event,
      _data,
    }, "*")
  }

  // ---- Fallback: render rich_text directly when no bootstrap ----

  useEffect(() => {
    if (bootstrapBlock || isEmpty) {
      setFallbackContent(null)
      return
    }

    const epBlocks = blocks
      .filter((b) => /^ep\d+$/i.test(b.label) && b.content_type === "rich_text")
      .sort((a, b) => {
        const na = parseInt(a.label.replace(/^ep/i, ""), 10)
        const nb = parseInt(b.label.replace(/^ep/i, ""), 10)
        return nb - na
      })

    if (epBlocks.length > 0) {
      ;(async () => {
        if (!instanceId) return
        const res = await outputBlocksApi.get(instanceId, epBlocks[0].uuid)
        if (res.ok && res.data) {
          setFallbackContent(renderText(res.data.rendered))
        }
      })()
    }
  }, [bootstrapBlock, blocks, isEmpty, instanceId])

  // ---- Render ----

  if (isEmpty) return null

  if (bootstrapBlock) {
    return (
      <iframe
        ref={iframeRef}
        className="w-full h-full border-0 bg-white dark:bg-neutral-900"
        sandbox="allow-scripts"
        title="Teahouse Sandbox"
        style={{ minHeight: "400px" }}
      />
    )
  }

  if (fallbackContent) {
    return (
      <div className="flex-1 overflow-auto py-4 px-6">
        <div
          className="prose prose-sm dark:prose-invert prose-chat max-w-none"
          dangerouslySetInnerHTML={{ __html: fallbackContent }}
        />
      </div>
    )
  }

  return null
}
