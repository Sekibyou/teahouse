import { useEffect, useRef, useState, useCallback } from "react"
import type { TextStyleRule } from "@/lib/types"
import { getBBCodeAnimationCSS, getBBCodeTooltipScript } from "@/lib/bbcodeParser"
import { renderText, clearRenderTextCache } from "@/lib/htmlSanitizer"
import { sandboxSrcApi, floorsApi, dmOutputApi, textStyleRulesApi, instancesApi, sandboxVarsApi, gitApi, rollApi } from "@/lib/api"
import type { ToolsRunStep } from "@/lib/api"
import { useSSERefresh } from "@/hooks/useSSERefresh"
import { useSessionStore } from "@/stores/sessionStore"
import { useThemeStore } from "@/stores/themeStore"
import { useUiScaleStore } from "@/stores/uiScaleStore"
import { useTranslation } from "react-i18next"

// ============================================================
// SandboxManager — file-system driven sandbox iframe + TeahouseBridge
//
// Sources of truth (instance runtime/ tree):
//   - runtime/sandbox/           → bootstrap.js (first), *.css (inject <head>),
//                                  other *.js (append). Read via sandboxSrcApi.
//   - runtime/floors/            → prose history the sandbox reads at runtime
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
  /** 沙盒请求唤起导演栏（被折叠时打开）。纯前端信号，不触发生成。 */
  onOpenDirector?: () => void
  /** 沙盒请求唤起导演栏并直接切到 DM 标签页。纯前端信号，不触发生成。 */
  onOpenDM?: () => void
}

export function SandboxManager({ instanceId, instanceName, onSend, onOpenDirector, onOpenDM }: SandboxManagerProps) {
  const { t } = useTranslation("misc")
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

  // ---- host theme → sandbox: relay dark/light so sandbox UI can follow ----
  const hostIsDark = useThemeStore((s) => s.isDark)
  useEffect(() => {
    sendToSandbox("theme.change", { dark: hostIsDark })
  }, [hostIsDark, sendToSandbox])

  // ---- host font scale → sandbox: relay --ui-scale multiplier so sandbox prose
  //       can follow (author opts in via theme.css rem/font var; see sandbox-builder) ----
  const hostScale = useUiScaleStore((s) => s.multiplier)
  useEffect(() => {
    sendToSandbox("font-scale", { scale: hostScale })
  }, [hostScale, sendToSandbox])

  // ---- text style rules ----
  const reloadTextStyleRules = useCallback(async () => {
    if (!instanceId) { setTextStyleRules([]); return }
    const res = await textStyleRulesApi.get(instanceId)
    if (res.ok && res.data) {
      clearRenderTextCache()
      setTextStyleRules(res.data.rules ?? [])
    }
  }, [instanceId])

  useEffect(() => {
    reloadTextStyleRules()
  }, [reloadTextStyleRules])

  // ---- director/DM busy state → sandbox ----
  // The backend is the authority (session_tracker's `running` map, delivered on
  // every `session_event`). Those arrive once per streamed token, so collapse
  // them here and only postMessage on an actual start/end boundary — the
  // sandbox then gets exactly one `session.busy` per boundary and can drive its
  // own elapsed timer. `since` is the earliest start time among the sessions
  // currently busy, so a rebuilt iframe resumes the count instead of restarting.
  const busySinceRef = useRef<Record<string, number>>({})
  const busyKeyRef = useRef<string>("")
  const busyPayloadRef = useRef<{ sessions: Record<string, boolean>; busy: boolean; since: number | null }>(
    { sessions: {}, busy: false, since: null }
  )

  // `authoritative` = the caller got a full snapshot of every live session
  // (GET /sessions/status), so any sid absent from it is idle — a stale entry
  // left by a missed `done` is dropped. Stream events merge instead, so a
  // payload that happens not to mention a sid can never silently unlock it.
  const applyRunningMap = useCallback((rMap: Record<string, boolean>, authoritative = false) => {
    const since = busySinceRef.current
    const now = Date.now()
    if (authoritative) {
      for (const sid of Object.keys(since)) if (rMap[sid] !== true) delete since[sid]
    }
    for (const [sid, running] of Object.entries(rMap)) {
      if (running) { if (since[sid] == null) since[sid] = now }
      else delete since[sid]
    }
    const busySids = Object.keys(since).sort()
    const key = busySids.join(",")
    if (key === busyKeyRef.current) return
    busyKeyRef.current = key
    const sessions: Record<string, boolean> = {}
    for (const sid of busySids) sessions[sid] = true
    busyPayloadRef.current = {
      sessions,
      busy: busySids.length > 0,
      since: busySids.length > 0 ? Math.min(...busySids.map((s) => since[s])) : null,
    }
    sendToSandbox("session.busy", busyPayloadRef.current)
  }, [sendToSandbox])

  const onSessionState = useCallback((payload: Record<string, unknown>) => {
    const rMap = payload.running
    if (!rMap || typeof rMap !== "object") return
    applyRunningMap(rMap as Record<string, boolean>)
  }, [applyRunningMap])

  // Re-read the authoritative map (GET /sessions/status). `authoritative` is only
  // set on reconnect: events were missed there, so a sid missing from the
  // response really is idle (a missed `done` would otherwise leave the sandbox's
  // input locked forever). At mount we merge instead — the refs were just reset,
  // so the two behave alike, and merging can't undo a `start` that raced ahead
  // of this request.
  const reconcileBusy = useCallback((authoritative = false) => {
    if (!instanceId) return
    instancesApi.getSessionsStatus(instanceId).then((res) => {
      if (res.ok && res.data) applyRunningMap(res.data.sessions ?? {}, authoritative)
    }).catch(() => {})
  }, [instanceId, applyRunningMap])

  const onReconnect = useCallback(() => reconcileBusy(true), [reconcileBusy])

  // Instance switched → the previous instance's busy sids say nothing about this
  // one (their `done` will never arrive here), so drop them before any event.
  // Then seed from the backend: the page may have loaded (or the iframe been
  // rebuilt) while a loop was already running, in which case no `start` event
  // is left to arrive and the sandbox would otherwise think it is idle.
  useEffect(() => {
    busySinceRef.current = {}
    busyKeyRef.current = ""
    busyPayloadRef.current = { sessions: {}, busy: false, since: null }
    reconcileBusy()
  }, [reconcileBusy])

  // ---- file_changed watchdog: route to srcdoc rebuild vs sandbox refresh ----
  useSSERefresh({
    instanceId,
    instanceName,
    onFileChanged: useCallback((path: string) => {
      if (!path) return
      // 样式规则变更：先刷新宿主侧的规则（renderRichText 用它着色）并清缓存，
      // 再让沙盒重渲染正文，避免沙盒用旧的规则集重渲染而看起来"没反应"。
      if (path.includes("text-style-rules.yaml")) {
        reloadTextStyleRules().then(() => sendToSandbox("output.refresh", { path }))
        return
      }
      // srcdoc is built solely from runtime/sandbox/. Only changes under
      // runtime/sandbox/ (sandbox code edited/written, or moved to/from
      // runtime/sandbox/disabled) can alter the iframe's contents, so rebuild it.
      // Floors / runtime_vars.jsonl / text-style-rules.yaml are DATA the sandbox
      // re-reads — route them to output.refresh so prose ${name} re-resolves.
      const isSandboxCode = path.includes("runtime/sandbox/")
      if (isSandboxCode) {
        setSrcdocVersion((v) => v + 1)
      } else {
        // floors / vars / style → ask sandbox to re-read & re-render
        sendToSandbox("output.refresh", { path })
      }
    }, [sendToSandbox, reloadTextStyleRules]),
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
    onSessionState,
    onReconnect,
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
      // sandbox (re)booted — (re)send current host theme so the fresh document gets it
      iframe.contentWindow?.postMessage(
        { _type: "_teahouse_event", _event: "theme.change", _data: { dark: hostIsDark } },
        "*"
      )
      iframe.contentWindow?.postMessage(
        { _type: "_teahouse_event", _event: "font-scale", _data: { scale: hostScale } },
        "*"
      )
      // A rebuilt iframe starts with no busy state (its editor may have just
      // changed mid-generation) — replay the current one so its input lock and
      // "working" indicator are correct from the first paint.
      iframe.contentWindow?.postMessage(
        { _type: "_teahouse_event", _event: "session.busy", _data: busyPayloadRef.current },
        "*"
      )
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
        case "listMessages": {
          // DM 呈现记录（与 listFloors 并列的独立线路）。返回 {enabled, messages}。
          if (instanceId) {
            const res = await dmOutputApi.list(instanceId)
            result = res.ok ? res.data : { enabled: false, messages: [] }
          } else {
            result = { enabled: false, messages: [] }
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
              meta?: Record<string, import("@/lib/api").SandboxVarMeta>
              delete?: string[]
            }
            // Accept either the full payload {updates,note,change_log,meta,delete} or a bare
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
        case "cancelRunTools": {
          // { run_uuid } → 打断一个 fire-and-forget 的 runTool 批次（如长 Generate 步骤）
          const runUuid = _args[0] as string
          if (instanceId && runUuid) {
            const res = await instancesApi.cancelRunTools(instanceId, runUuid)
            result = res.ok ? res.data : { ok: false, error: res.error }
          } else {
            result = { ok: false, error: "cancelRunTools requires {run_uuid}" }
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
        case "roll": {
          // 骰子：复用后端 placeholder 的 roll 语法（单一事实源），返回 {result, expr}。
          const expr = _args[0] as string | undefined
          if (expr) {
            const res = await rollApi.roll(expr)
            result = res.ok ? res.data : { ok: false, error: res.error }
          } else {
            result = { ok: false, error: "roll requires an expression string" }
          }
          break
        }
        case "send": {
          if (_args[0] && onSend) { onSend(_args[0] as string); result = true }
          break
        }
        case "openDirector": {
          // 沙盒唤起导演栏（纯前端，不触发生成）——把信号交给宿主去展开折叠的导演栏。
          onOpenDirector?.()
          result = true
          break
        }
        case "openDM": {
          // 沙盒唤起 DM 栏（纯前端，不触发生成）——宿主展开导演栏并切到 DM 标签页。
          onOpenDM?.()
          result = true
          break
        }
        case "sessionCreate": {
          // { enabled_tools?: string[], reasoning_effort?: string } → creates a child sub-session, returns {session_id}.
          if (instanceId) {
            const opts = (_args[0] as { enabled_tools?: string[]; reasoning_effort?: string } | undefined) || {}
            const res = await instancesApi.createSession(instanceId, opts.enabled_tools, opts.reasoning_effort)
            // 统一返回 {ok, data|error}：成功时包装为 {ok:true, data:{session_id, enabled_tools}}，沙盒端用 res.ok 判断。
            result = res.ok ? { ok: true, data: res.data } : { ok: false, error: res.error }
          } else {
            result = { ok: false, error: t("sandbox.sessionCreateError") }
          }
          break
        }
        case "sessionSend": {
          // { session_id, message } → route a message to a specific sub-session.
          const p = _args[0] as { session_id?: string; sessionId?: string; message?: string } | undefined
          const sid = p?.session_id || p?.sessionId
          if (instanceId && sid && p?.message) {
            useSessionStore.getState().setPendingSessionSend({ sessionId: sid, message: p.message })
            result = { ok: true, data: true }
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
            result = res.ok ? { ok: true, data: true } : { ok: false, error: res.error }
          } else {
            result = { ok: false, error: "sessionDestroy requires {session_id}" }
          }
          break
        }
        case "gitDiscard": {
          // B 按钮：重写 = git 回档。复用 /git/discard（git checkout -- . + clean -fd，
          // 连 untracked 的 floor-N-draft.md 一并清除）。广播 workspace_changed。
          if (instanceId) {
            const res = await gitApi.discard(instanceId)
            result = res.ok ? { ok: true, data: true } : { ok: false, error: res.error }
          } else {
            result = { ok: false, error: "gitDiscard requires instance context" }
          }
          break
        }
        case "commitDraft": {
          // 转正：后端一次完成「重算变量 → 冻结快照 → 改名 → git 提交」。
          if (!instanceId || typeof _args[0] !== "number") {
            result = { ok: false, error: "commitDraft requires {num}" }
            break
          }
          const res = await floorsApi.commitDraft(instanceId, _args[0])
          if (res.ok) {
            sendToSandbox("draft.committed", res.data)
            sendToSandbox("output.refresh", { path: "*" })
            result = { ok: true, data: res.data }
          } else {
            result = { ok: false, error: res.error }
          }
          break
        }
        case "refresh": {
          // 沙盒改过 draft / 变量后调用。后端 /runtime-vars 的读路径会做 bootstrap +
          // 软重算，故一次读取即可把工作值刷新到最新，并回传给它更新显示。
          if (!instanceId) {
            result = { ok: false, error: "refresh requires instance context" }
            break
          }
          const res = await sandboxVarsApi.get(instanceId, [])
          result = res.ok
            ? { ok: true, data: { vars: res.data?.vars ?? [] } }
            : { ok: false, error: res.error }
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
  }, [instanceId, instanceName, onSend, onOpenDirector, onOpenDM, textStyleRules, hostIsDark, hostScale])

  useEffect(() => {
    window.addEventListener("message", handleMessage)
    return () => window.removeEventListener("message", handleMessage)
  }, [handleMessage])

  // ---- empty state: no sandbox code at all ----
  if (!instanceId || !hasSandbox) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground">
        <div className="text-center">
          <p className="text-sm">{t("sandbox.waiting")}</p>
        </div>
      </div>
    )
  }

  return (
    <iframe
      ref={iframeRef}
      className="w-full h-full border-0 bg-white dark:bg-background"
      sandbox="allow-scripts"
      title="Teahouse Sandbox"
      srcDoc={srcdoc}
      style={{ minHeight: "400px" }}
    />
  )
}
