import { useEffect, useRef, useState, useCallback } from "react"
import type { TextStyleRule } from "@/lib/types"
import { getBBCodeAnimationCSS, getBBCodeTooltipScript } from "@/lib/bbcodeParser"
import { renderText, clearRenderTextCache } from "@/lib/htmlSanitizer"
import { sandboxSrcApi, floorsApi, textStyleRulesApi, instancesApi, sandboxVarsApi, gitApi } from "@/lib/api"
import type { ToolsRunStep, SandboxVarEntry } from "@/lib/api"
import { consumeVars } from "@/lib/teahouseVars"
import { useSSERefresh } from "@/hooks/useSSERefresh"
import { useSessionStore } from "@/stores/sessionStore"
import { useThemeStore } from "@/stores/themeStore"

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
  /** 沙盒请求唤起导演栏（被折叠时打开）。纯前端信号，不触发生成。 */
  onOpenDirector?: () => void
}

export function SandboxManager({ instanceId, instanceName, onSend, onOpenDirector }: SandboxManagerProps) {
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
      // srcdoc is built solely from .teahouse/output/sandbox/. Any change under
      // .teahouse/output/ that is NOT floors/ (sandbox code moved/edited/written,
      // or moved to/from output/sandbox/disabled) can alter that directory's contents,
      // so rebuild the iframe. Only floor changes are handled in-sandbox.
      const isFloors = path.includes(".teahouse/output/floors/")
      const isOutput = path.includes(".teahouse/output")
      if (isOutput && !isFloors) {
        setSrcdocVersion((v) => v + 1)
      } else {
        // floors / anything else → ask sandbox to re-read
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
        case "sessionCreate": {
          // { enabled_tools?: string[], reasoning_effort?: string } → creates a child sub-session, returns {session_id}.
          if (instanceId) {
            const opts = (_args[0] as { enabled_tools?: string[]; reasoning_effort?: string } | undefined) || {}
            const res = await instancesApi.createSession(instanceId, opts.enabled_tools, opts.reasoning_effort)
            // 统一返回 {ok, data|error}：成功时包装为 {ok:true, data:{session_id, enabled_tools}}，沙盒端用 res.ok 判断。
            result = res.ok ? { ok: true, data: res.data } : { ok: false, error: res.error }
          } else {
            result = { ok: false, error: "缺少实例上下文，无法创建子会话" }
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
          // 转正：解析 teahouse-vars → 应用变量 → 标记 msg 写回 → 改名 → git 提交。
          // 详见 tests/teahouse-commit-draft-api.md (v2)。
          if (!instanceId || typeof _args[0] !== "number") {
            result = { ok: false, error: "commitDraft requires {num}" }
            break
          }
          result = await runCommitDraft(instanceId, _args[0], sendToSandbox)
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
  }, [instanceId, instanceName, onSend, onOpenDirector, textStyleRules, hostIsDark])

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

// ============================================================
// commitDraft 宿主实现
//
// 把「解析 teahouse-vars → 应用变量 → 标记 msg 写回 → 改名 → git 提交」绑定为
// 一个请求-响应单向闸门，由沙盒 Teahouse.commitDraft(N) 触发。返回
// {num, title, commit_hash, applied, failed, committed_draft}。失败 reject。
//
// 两条分支：
//   1. floor-N-draft.md 存在（未转正）→ 正常转正。committed_draft=true。
//   2. floor-N.md 已存在且有未带 msg 的裸 action → 二次补解析(正文变量维护)。
//      committed_draft=false，git 提交 type=other。
//   3. 已全部消费 → 幂等返回（committed_draft=false，不动）。
// ============================================================
async function runCommitDraft(
  instanceId: string,
  num: number,
  sendToSandbox: (event: string, data: unknown) => void,
): Promise<unknown> {
  const draftPath = `.teahouse/output/floors/floor-${num}-draft.md`
  const finalPath = `.teahouse/output/floors/floor-${num}.md`

  // 1) 读取正文：优先草稿，否则正式稿（二次补解析）。都读不到 → 报错。
  const draftRes = await instancesApi.readText(instanceId, draftPath)
  let markdown = draftRes.ok ? draftRes.data?.content ?? null : null
  const isDraft = markdown !== null
  if (!isDraft) {
    const finalRes = await instancesApi.readText(instanceId, finalPath)
    markdown = finalRes.ok ? finalRes.data?.content ?? null : null
  }
  if (markdown === null) {
    return { ok: false, error: `未找到 ${draftPath} 或 ${finalPath}` }
  }
  const title = extractTitle(markdown) || `第 ${num} 章`

  // 2) 当前变量快照（add/append/pop/x 需要现值）
  const varsRes = await sandboxVarsApi.get(instanceId, [])
  const currentVars: SandboxVarEntry[] = varsRes.ok ? varsRes.data?.vars ?? [] : []
  const varMap: Array<{ name: string; value?: unknown }> = currentVars.map((v) => ({
    name: v.name,
    value: v.value,
  }))

  // 3) 解析 + 应用（mutate varMap 为新值；返回 updates 供一次 setVar）
  const { applied, failed, updates, markedMarkdown } = consumeVars(markdown, varMap)
  const hasConsumed = applied.length > 0

  // 若正文没有变化（既无待消费 action，又已是正式稿）→ 幂等返回，不动正文/git。
  if (!isDraft && !hasConsumed) {
    return {
      ok: true,
      data: { num, title, commit_hash: null, applied, failed, committed_draft: false },
    }
  }

  // 4) 写变量（一次 setVar，仅成功写入的 updates）
  if (Object.keys(updates).length > 0) {
    const setRes = await sandboxVarsApi.set(instanceId, { updates })
    if (!setRes.ok) return { ok: false, error: `应用变量失败：${setRes.error}` }
  }

  // 5) 写回正文：有 action 被标记则写回标记版；纯转正（有块但那章已转正）正文不变也写回无害
  if (hasConsumed) {
    const writeRes = await instancesApi.writeFile(instanceId, isDraft ? draftPath : finalPath, markedMarkdown)
    if (!writeRes.ok) return { ok: false, error: `写回正文失败：${writeRes.error}` }
  }

  // 6) 改名（仅草稿分支）：floor-N-draft.md → floor-N.md
  //    后端 rename 的 new_name 只接受"纯文件名"（不含路径分隔符）
  if (isDraft) {
    const newName = finalPath.split("/").pop() || ""
    const renameRes = await instancesApi.renameEntry(instanceId, draftPath, newName)
    if (!renameRes.ok) return { ok: false, error: `改名失败：${renameRes.error}` }
  }

  // 7) git 提交（paths 限定，避免卷入导演其它未提交工作）
  //    改名 = 新文件出现 + 旧 draft 被删两个变更。若旧 draft 曾被 tracked（以 other
  //    暂存过），删除必须一并 stage，否则提交后旧文件成脏改动；git 会自动把"同名新旧"
  //    识别为 rename(R100)。若 draft 纯 untracked，git add 未跟踪的已删文件会 fatal
  //    pathspec 报错，故只有它在 git status 里被列为变更（tracked）时才含入 paths。
  const commitPaths = [finalPath, ".teahouse/runtime_vars.jsonl"]
  if (isDraft) {
    const fileRes = await gitApi.fileStatus(instanceId)
    const listed = fileRes.ok ? fileRes.data?.files ?? [] : []
    const draftChanged = listed.some((f) => f.path === draftPath)
    if (draftChanged) commitPaths.push(draftPath)
  }
  const commitRes = await gitApi.commit(instanceId, {
    type: isDraft ? "floor" : "other",
    number: num,
    message: isDraft ? title : `第 ${num} 章正文变量维护`,
    paths: commitPaths,
  })

  const payload = {
    num,
    path: finalPath,
    title,
    commit_hash: commitRes.ok ? commitRes.data?.commit_hash ?? null : null,
    applied,
    failed,
    committed_draft: isDraft,
    commit_warning: !commitRes.ok ? commitRes.error : undefined,
  }
  // 8) 广播 draft.committed + 兜底 output.refresh（防止改名后幽灵草稿残留）
  sendToSandbox("draft.committed", payload)
  sendToSandbox("output.refresh", { path: "*" })

  return { ok: true, data: payload }
}

/** 从 markdown 首行标题提取章节名；无标题 → 默认"第 N 章"。 */
function extractTitle(markdown: string): string {
  const m = /^\s*#{1,6}\s+(.+?)\s*$/m.exec(markdown || "")
  return m ? m[1].trim() : ""
}
