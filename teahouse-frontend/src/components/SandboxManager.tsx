import { useEffect, useRef, useState, useCallback } from "react"
import type { TextStyleRule } from "@/lib/types"
import { getBBCodeAnimationCSS, getBBCodeTooltipScript } from "@/lib/bbcodeParser"
import { renderText } from "@/lib/htmlSanitizer"
import { sandboxSrcApi, floorsApi, textStyleRulesApi, instancesApi, sandboxVarsApi } from "@/lib/api"
import type { ToolsRunStep } from "@/lib/api"
import { useSSERefresh } from "@/hooks/useSSERefresh"
import { useSessionStore } from "@/stores/sessionStore"

// ============================================================
// SandboxManager — file-system driven sandbox iframe + TeahouseBridge
//
// Sources of truth (instance .teahouse/output/ tree):
//   - .teahouse/output/sandbox/  → bootstrap.js (first), *.css (inject <head>),
//                                  other *.js (append). Read via sandboxSrcApi.
//   - .teahouse/output/floors/   → prose history the sandbox reads at runtime
//                                  via listFloors + readText.
// No output blocks / content_type. The host watches file_changed SSE:
//   - sandbox file changed → rebuild srcdoc
//   - floors/style changed → postMessage output.refresh so the sandbox re-reads
//
// Timing note: the iframe is ALWAYS mounted; its srcdoc is fed via the `srcDoc`
// prop once a valid HTML document is built. Doing the build inside a separate
// async effect guarantees the iframe exists before its srcdoc is set.
// ============================================================

interface SandboxManagerProps {
  instanceId: string | undefined
  instanceName: string | undefined
  onSend?: (message: string) => void
}

export function SandboxManager({ instanceId, instanceName, onSend }: SandboxManagerProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const [textStyleRules, setTextStyleRules] = useState<TextStyleRule[]>([])
  const [srcdoc, setSrcdoc] = useState<string>("")
  const [srcdocVersion, setSrcdocVersion] = useState(0)
  const [hasSandbox, setHasSandbox] = useState(false)

  // send a refresh event into the iframe (fires once the sandbox is mounted & ready)
  const sendToSandbox = useCallback((event: string, data: unknown) => {
    iframeRef.current?.contentWindow?.postMessage(
      { _type: "_teahouse_event", _event: event, _data: data },
      "*"
    )
  }, [])

  // ---- text style rules ----
  useEffect(() => {
    if (!instanceId) { setTextStyleRules([]); return }
    ;(async () => {
      const res = await textStyleRulesApi.get(instanceId)
      if (res.ok && res.data) setTextStyleRules(res.data.rules ?? [])
    })()
  }, [instanceId])

  // ---- file_changed watchdog: route to srcdoc rebuild vs sandbox refresh ----
  useSSERefresh({
    instanceId,
    instanceName,
    onFileChanged: useCallback((path: string) => {
      if (!path) return
      // srcdoc is built solely from .teahouse/output/sandbox/. Any change under
      // .teahouse/output/ that is NOT floors/ (sandbox code moved/edited/written,
      // or moved to/from output_disabled) can alter that directory's contents,
      // so rebuild the iframe. Only floor changes are handled in-sandbox.
      const isFloors = path.includes(".teahouse/output/floors/")
      const isOutput = path.includes(".teahouse/output")
      if (isOutput && !isFloors) {
        setSrcdocVersion((v) => v + 1)
      } else {
        // floors / text-style-rules / anything else → ask sandbox to re-read
        sendToSandbox("output.refresh", { path })
      }
    }, [sendToSandbox]),
    onWorkspaceChanged: useCallback(() => {
      sendToSandbox("output.refresh", { path: "*" })
    }, [sendToSandbox]),
    onToolRun: useCallback((payload: Record<string, unknown>) => {
      // 透传 runTool 后台任务的单步结果给沙盒（组件按 run_uuid 筛选/数 index）
      sendToSandbox("tool_run", payload)
    }, [sendToSandbox]),
    onGenerateProgress: useCallback((payload: Record<string, unknown>) => {
      // 透传 Generate 流式进度（含 diff）给沙盒，供"生成中"缓冲渲染/打字机
      sendToSandbox("generate_progress", payload)
    }, [sendToSandbox]),
    onSessionEvent: useCallback((event: string, payload: Record<string, unknown>) => {
      // 透传子会话结束/销毁事件给沙盒（bootstrap 用 Teahouse.on('session_done') 订阅）
      sendToSandbox(event, payload)
    }, [sendToSandbox]),
  })

  // ---- Build srcdoc from engine bootstrap + instance UI files ----
  useEffect(() => {
    if (!instanceId) { setHasSandbox(false); setSrcdoc(""); return }
    let cancelled = false

    ;(async () => {
      const res = await sandboxSrcApi.get(instanceId)
      if (cancelled || !res.ok || !res.data) return
      const bootstrapScripts = res.data.bootstrap || []
      const files = res.data.files || {}
      const rels = Object.keys(files)
      // hasSandbox = true if there are bootstrap scripts OR user UI files
      setHasSandbox(bootstrapScripts.length > 0 || rels.length > 0)
      if (bootstrapScripts.length === 0 && rels.length === 0) { setSrcdoc(""); return }

      // Dispatch by filename/extension:
      //   Engine bootstrap scripts first (from API bootstrap[]),
      //   *.css → <style>, user *.js → appended <script>
      const cssFiles = rels.filter((r) => r.endsWith(".css")).sort()
      const jsFiles = rels.filter((r) => r.endsWith(".js")).sort()

      const bridge = `(function() {
  // host → sandbox 事件桥（宿主硬编码，任何 bootstrap 都收得到）。这是
  // '_teahouse_event' 的唯一合法转发入口——bootstrap 自带代码不得再监听同名
  // message 并 _emit，否则同一事件（如 generate_progress）会双发、增量追加重复。
  window.addEventListener('message', function(e) {
    var d = e.data;
    if (d && d._type === '_teahouse_event' && window.Teahouse && window.Teahouse._emit) {
      window.Teahouse._emit(d._event, d._data);
    }
  });
})();`

      // Engine bootstrap scripts first, then user UI components
      const scriptTags = [
        ...bootstrapScripts.map((s) => `<script>${s}</script>`),
        `<script>${bridge}</script>`,
        ...jsFiles.map((r) => files[r]).map((s) => `<script>${s}</script>`),
      ].join("\n")

      // tip 气泡驱动脚本：随 srcdoc 注入沙盒 document，正文里的 [tip] 即可智能定位
      const tipScriptTag = `<script>${getBBCodeTooltipScript()}</script>`

      const styleTags = [...cssFiles.map((r) => files[r]), getBBCodeAnimationCSS()]
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
    ::-webkit-scrollbar { width: 6px; height: 6px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.15); border-radius: 3px; }
    *, *::before, *::after { scrollbar-width: thin; scrollbar-color: rgba(255,255,255,0.15) transparent; }
  </style>
  ${styleTags}
</head>
<body>
  ${scriptTags}
  ${tipScriptTag}
</body>
</html>`

      if (!cancelled) setSrcdoc(doc)
    })()

    return () => { cancelled = true }
  }, [instanceId, srcdocVersion])

  // ---- onMessage bridge ----
  const handleMessage = useCallback(async (e: MessageEvent) => {
    const iframe = iframeRef.current
    if (!iframe || e.source !== iframe.contentWindow) return
    const d = e.data
    if (!d || typeof d !== "object") return

    if (d._type === "ready") {
      iframe.contentWindow?.postMessage({ _type: "init", instanceId, instanceName }, "*")
      return
    }
    if (!d._method) return
    const { _method, _args, _callId } = d

    try {
      let result: unknown = undefined
      switch (_method) {
        case "listFloors": {
          if (instanceId) {
            const res = await floorsApi.list(instanceId)
            result = res.ok ? res.data?.floors : []
          }
          break
        }
        case "renderRichText": {
          const text = _args[0] as string
          if (text) result = renderText(text, textStyleRules)
          break
        }
        case "readText": {
          if (instanceId && _args[0]) {
            const res = await instancesApi.readText(instanceId, _args[0] as string)
            result = res.ok ? res.data?.content : null
          }
          break
        }
        case "readAsset": {
          if (instanceId && _args[0]) {
            const res = await instancesApi.readAsset(instanceId, _args[0] as string)
            // return a ready-to-use data URL: data:{mime};base64,{data}
            result = res.ok && res.data
              ? `data:${res.data.mime};base64,${res.data.data}`
              : null
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
        case "setVar": {
          if (instanceId && _args[0]) {
            const payload = _args[0] as {
              updates?: Record<string, unknown>
              note?: Record<string, string>
              change_log?: Record<string, unknown>
              delete?: string[]
            }
            // Accept either the full payload {updates,note,change_log,delete} or a bare
            // updates object for backward compat.
            const normalized = payload && typeof payload === "object" && "updates" in payload
              ? payload
              : { updates: payload as Record<string, unknown> }
            const res = await sandboxVarsApi.set(instanceId, normalized)
            result = res.ok ? res.data?.vars : undefined
          }
          break
        }
        case "runTools": {
          if (instanceId && Array.isArray(_args[0])) {
            const res = await instancesApi.runTools(instanceId, _args[0] as unknown as ToolsRunStep[])
            result = res.ok ? res.data : { ok: false, error: res.error }
          }
          break
        }
        case "getVars": {
          if (instanceId) {
            const names = Array.isArray(_args[0]) ? (_args[0] as string[]) : []
            const res = await sandboxVarsApi.get(instanceId, names)
            result = res.ok ? res.data?.vars : []
          }
          break
        }
        case "send": {
          if (_args[0] && onSend) { onSend(_args[0] as string); result = true }
          break
        }
        case "sessionCreate": {
          // { enabled_tools?: string[] } → creates a child sub-session, returns session_id.
          if (instanceId) {
            const opts = (_args[0] as { enabled_tools?: string[] } | undefined) || {}
            const res = await instancesApi.createSession(instanceId, opts.enabled_tools)
            result = res.ok ? res.data : { ok: false, error: res.error }
          }
          break
        }
        case "sessionSend": {
          // { session_id, message } → route a message to a specific sub-session.
          const p = _args[0] as { session_id?: string; sessionId?: string; message?: string } | undefined
          const sid = p?.session_id || p?.sessionId
          if (instanceId && sid && p?.message) {
            useSessionStore.getState().setPendingSessionSend({ sessionId: sid, message: p.message })
            result = true
          } else {
            result = { ok: false, error: "sessionSend requires {session_id, message}" }
          }
          break
        }
        case "sessionDestroy": {
          // { session_id, abort? } → destroy a child session (abort cancels in-flight).
          const p = _args[0] as { session_id?: string; sessionId?: string; abort?: boolean } | undefined
          const sid = p?.session_id || p?.sessionId
          if (instanceId && sid) {
            const res = await instancesApi.destroySession(instanceId, sid, !!p?.abort)
            result = res.ok ? true : { ok: false, error: res.error }
          } else {
            result = { ok: false, error: "sessionDestroy requires {session_id}" }
          }
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

  // ---- empty state: no sandbox code at all ----
  if (!instanceId || !hasSandbox) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground">
        <div className="text-center">
          <p className="text-sm">等待 AI 生成内容...</p>
        </div>
      </div>
    )
  }

  return (
    <iframe
      ref={iframeRef}
      className="w-full h-full border-0 bg-white dark:bg-neutral-900"
      sandbox="allow-scripts"
      title="Teahouse Sandbox"
      srcDoc={srcdoc}
      style={{ minHeight: "400px" }}
    />
  )
}
