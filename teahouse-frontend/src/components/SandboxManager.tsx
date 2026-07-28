import { useEffect, useRef, useCallback, useState } from "react"
import type { OutputBlock } from "@/hooks/useOutputSSE"
import type { ContentType, TextStyleRule } from "@/lib/types"
import { getBBCodeAnimationCSS } from "@/lib/bbcodeParser"
import { renderText } from "@/lib/htmlSanitizer"
import { outputBlocksApi, instancesApi, textStyleRulesApi } from "@/lib/api"

// ============================================================
// SandboxManager — unified sandbox iframe + TeahouseBridge
// ============================================================

interface SandboxManagerProps {
  instanceId: string | undefined
  instanceName: string | undefined
  blocks: OutputBlock[]
  onSend?: (message: string) => void
  isEmpty: boolean
  rulesVersion?: number
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
export function SandboxManager({ instanceId, instanceName, blocks, onSend, isEmpty, rulesVersion }: SandboxManagerProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const [sandboxReady, setSandboxReady] = useState(false)
  const [fallbackContent, setFallbackContent] = useState<string | null>(null)
  const [srcdoc, setSrcdoc] = useState<string | null>(null)
  const [textStyleRules, setTextStyleRules] = useState<TextStyleRule[]>([])

  // ---- Load text style rules when instance or rules change ----

  useEffect(() => {
    if (!instanceId) {
      setTextStyleRules([])
      return
    }
    ;(async () => {
      const res = await textStyleRulesApi.get(instanceId)
      if (res.ok && res.data) {
        setTextStyleRules(res.data.rules ?? [])
      }
    })()
  }, [instanceId, rulesVersion])

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
    /* 沙盒默认滚动条美化（与主项目一致，硬编码颜色） */
    ::-webkit-scrollbar { width: 6px; height: 6px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.15); border-radius: 3px; }
    ::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.3); }
    *, *::before, *::after { scrollbar-width: thin; scrollbar-color: rgba(255,255,255,0.15) transparent; }
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
            result = renderText(text, textStyleRules)
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
  }, [instanceId, instanceName, onSend, textStyleRules])

  useEffect(() => {
    window.addEventListener("message", handleMessage)
    return () => window.removeEventListener("message", handleMessage)
  }, [handleMessage])

  // ---- Forward SSE events to sandbox (initial full sync + incremental deltas) ----

  const syncedRef = useRef(false)
  const prevBlocksRef = useRef<Map<string, OutputBlock>>(new Map())

  useEffect(() => {
    if (!sandboxReady || !iframeRef.current || !bootstrapBlock) return

    if (!syncedRef.current) {
      // Initial full sync: push all blocks once (skip code types embedded in srcdoc)
      for (const block of blocks) {
        if (block.content_type === "bootstrap_js" ||
            block.content_type === "scene_js" ||
            block.content_type === "css" ||
            block.content_type === "ui_js") {
          continue
        }
        sendToSandbox("output.append", block)
        prevBlocksRef.current.set(block.uuid, block)
      }
      syncedRef.current = true
      return
    }

    // Incremental delta: detect new/changed/deleted blocks
    const prev = prevBlocksRef.current
    const current = new Map(blocks
      .filter(b =>
        b.content_type !== "bootstrap_js" &&
        b.content_type !== "scene_js" &&
        b.content_type !== "css" &&
        b.content_type !== "ui_js"
      )
      .map(b => [b.uuid, b])
    )

    for (const [uuid, block] of current) {
      if (!prev.has(uuid)) {
        sendToSandbox("output.append", block)
      } else if (prev.get(uuid)!.rendered !== block.rendered || prev.get(uuid)!.note !== block.note) {
        sendToSandbox("output.replace", block)
      }
    }

    for (const uuid of prev.keys()) {
      if (!current.has(uuid)) {
        sendToSandbox("output.delete", { uuid })
      }
    }

    prevBlocksRef.current = current
  }, [blocks, sandboxReady, bootstrapBlock])

  function sendToSandbox(_event: string, _data: unknown) {
    iframeRef.current?.contentWindow?.postMessage({
      _type: "_teahouse_event",
      _event,
      _data,
    }, "*")
  }

  // ---- When text style rules change, re-render active ep block in sandbox ----
  // Skip the initial load (sandbox renders with rules from the start).
  // Only fire on subsequent updates (e.g. director edited text-style-rules.yaml).

  const rulesSkipInitialRef = useRef(true)

  useEffect(() => {
    if (!sandboxReady || !bootstrapBlock || blocks.length === 0) return

    if (rulesSkipInitialRef.current) {
      rulesSkipInitialRef.current = false
      return
    }

    // Find the highest ep block and re-forward it so sandbox re-renders with new rules
    const epBlocks = blocks
      .filter((b) => /^ep\d+$/i.test(b.label) && b.content_type === "rich_text")
    if (epBlocks.length === 0) return

    const latest = epBlocks.reduce((a, b) => {
      const na = parseInt(a.label.replace(/^ep/i, ""), 10)
      const nb = parseInt(b.label.replace(/^ep/i, ""), 10)
      return na > nb ? a : b
    })
    sendToSandbox("output.replace", latest)
  }, [textStyleRules, sandboxReady, bootstrapBlock, blocks])

  // Reset skip flag when instance changes (sandbox restarts)
  useEffect(() => {
    rulesSkipInitialRef.current = true
  }, [instanceId])

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
          setFallbackContent(renderText(res.data.rendered, textStyleRules))
        }
      })()
    }
  }, [bootstrapBlock, blocks, isEmpty, instanceId, textStyleRules])

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
