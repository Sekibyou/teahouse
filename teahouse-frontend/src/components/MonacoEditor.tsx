import { useEffect, useRef, useMemo, useCallback, useState } from "react"
import Editor, { type OnMount, loader } from "@monaco-editor/react"
import * as Monaco from "monaco-editor"
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker"
import { useTranslation } from "react-i18next"
import i18n from "@/i18n/config"
import { useUiScaleStore } from "@/stores/uiScaleStore"
import { scanBrace, findPlaceholderStart, findClickTargetAtColumn } from "@/lib/placeholderPath"

// ---- Local Monaco bundle (no CDN) ----
// Bundle Monaco locally via Vite and hand the instance to @monaco-editor/react,
// so its "Loading..." never depends on a remote jsdelivr fetch.
self.MonacoEnvironment = {
  // All languages we enable share the base editor worker.
  getWorker() {
    return new EditorWorker()
  },
}
loader.config({ monaco: Monaco })

// ---- Custom "teahouse" language: placeholder syntax highlighting ----
// A bespoke language for markdown / yaml / plaintext files that carry teahouse
// placeholder syntax. We ship a deliberately small grammar: the placeholders +
// a minimal markdown subset (headings & fenced code blocks). Other host
// languages (py/ts/js/css/html/shell) keep their native highlighting untouched.
//
// We use a hand-written TokensProvider (not Monarch) because placeholder
// boundaries need **brace-depth matching**: the end of `${...}` is the `}` that
// balances the outermost `{`, and inner `{{切片}}` / f-string `{}` must not
// truncate it. Monarch regex rules can't count arbitrary nesting, so a stateful
// scanner is the faithful mirror of the engine's `_match_brace_group`.
Monaco.languages.register({ id: "teahouse" })

class TeahouseState implements Monaco.languages.IState {
  readonly inCodeblock: boolean
  readonly braceDepth: number
  readonly placeholderToken: string

  constructor(inCodeblock: boolean, braceDepth: number, placeholderToken: string) {
    this.inCodeblock = inCodeblock
    this.braceDepth = braceDepth
    this.placeholderToken = placeholderToken
  }

  clone(): TeahouseState {
    return new TeahouseState(this.inCodeblock, this.braceDepth, this.placeholderToken)
  }

  equals(other: Monaco.languages.IState): boolean {
    return (
      other instanceof TeahouseState &&
      other.inCodeblock === this.inCodeblock &&
      other.braceDepth === this.braceDepth &&
      other.placeholderToken === this.placeholderToken
    )
  }
}

// Classify the inner text of a `${...}` placeholder. `closed` is true when the
// matching `}` was found on the same line (single-line placeholder).
function classifyPlaceholder(inner: string, closed: boolean): string {
  const s = inner.trim()
  if (s === "@note" || s.startsWith("@note ")) return "comment.teahouse"
  if (closed) {
    if (s === "@var" || s.startsWith("@var ") || s === "@type" || s.startsWith("@type ")) {
      return "variable.teahouse"
    }
    // bare variable: no @ / return / colon / whitespace
    if (s !== "" && !s.startsWith("@") && !s.includes("return") && !s.includes(":") && !/\s/.test(s)) {
      return "variable.teahouse"
    }
  }
  return "keyword.teahouse"
}

function tokenize(line: string, state: Monaco.languages.IState): Monaco.languages.ILineTokens {
  const s = state as TeahouseState
  const tokens: Monaco.languages.IToken[] = []
  let i = 0

  // Fenced code block: whole line is codeblock until a closing ``` fence.
  if (s.inCodeblock) {
    const closes = /^\s*```/.test(line)
    tokens.push({ startIndex: 0, scopes: "codeblock" })
    return { tokens, endState: new TeahouseState(!closes, 0, "") }
  }

  // Continue a multi-line placeholder opened on a previous line.
  let depth = s.braceDepth
  let phToken = s.placeholderToken
  if (depth > 0) {
    let end = 0
    while (end < line.length && depth > 0) {
      const ch = line[end]
      if (ch === "{") depth++
      else if (ch === "}") depth--
      end++
    }
    tokens.push({ startIndex: 0, scopes: phToken })
    i = end
    if (depth > 0) {
      return { tokens, endState: new TeahouseState(false, depth, phToken) }
    }
  }

  // Emit a default-foreground token over [from, to). These ensure a token
  // boundary exists at every column: Monaco force-starts the first token at 0
  // and runs the last to end-of-line, so without these a lone placeholder
  // would swallow the whole line's color.
  const pushPlain = (from: number, to: number) => {
    if (to > from) tokens.push({ startIndex: from, scopes: "" })
  }

  while (i < line.length) {
    if (i === 0) {
      if (/^\s*```/.test(line)) {
        tokens.push({ startIndex: 0, scopes: "codeblock" })
        return { tokens, endState: new TeahouseState(true, 0, "") }
      }
      if (/^#{1,6}/.test(line)) {
        tokens.push({ startIndex: 0, scopes: "header.teahouse" })
        return { tokens, endState: new TeahouseState(false, 0, "") }
      }
    }

    const start = findPlaceholderStart(line, i)
    if (start < 0) {
      pushPlain(i, line.length)
      break
    }

    pushPlain(i, start)
    const c = line[start]
    const isVar = c === "$"
    const { end, depth: d } = scanBrace(line, start)
    const closed = d === 0
    if (isVar) {
      const inner = closed ? line.slice(start + 2, end - 1) : line.slice(start + 2)
      const token = classifyPlaceholder(inner, closed)
      tokens.push({ startIndex: start, scopes: token })
      if (!closed) {
        return { tokens, endState: new TeahouseState(false, d, token) }
      }
    } else {
      tokens.push({ startIndex: start, scopes: "string.teahouse" })
      if (!closed) {
        return { tokens, endState: new TeahouseState(false, d, "string.teahouse") }
      }
    }
    i = end
  }

  return { tokens, endState: new TeahouseState(false, 0, "") }
}

Monaco.languages.setTokensProvider("teahouse", {
  getInitialState: () => new TeahouseState(false, 0, ""),
  tokenize,
})

// Hover 提示：指针悬停在可跳的 {{path}} 文件引用上时提示 Ctrl+Click 跳转。
// 语言级 provider(模块级注册一次，随 model 切换自适配)。仅在独立 {{...}} 且能解析出目标
// path 时返回内容；命中即给 0-based start/end 换算成 Monaco Range(start 取 col=start+1)。
Monaco.languages.registerHoverProvider("teahouse", {
  provideHover(model, position) {
    const line = model.getLineContent(position.lineNumber)
    const hit = findClickTargetAtColumn(line, position.column)
    if (!hit) return null
    const { start, end, path } = hit
    const range = new Monaco.Range(position.lineNumber, start + 1, position.lineNumber, end)
    return {
      range,
      contents: [{ value: `${i18n.t("misc:monaco.ctrlClickOpen")}${path}` }],
    }
  },
})

// ---- Theme helpers ----

const LIGHT_THEME = "teahouse-light"
const DARK_THEME = "teahouse-dark"

function defineThemes(monaco: typeof Monaco) {
  monaco.editor.defineTheme(LIGHT_THEME, {
    base: "vs",
    inherit: true,
    rules: [
      { token: "comment.teahouse", foreground: "#2e7d32", fontStyle: "italic" },
      { token: "keyword.teahouse", foreground: "#c586c0" },
      { token: "variable.teahouse", foreground: "#0c7bb8" },
      { token: "string.teahouse", foreground: "#a0472c" },
      { token: "header.teahouse", foreground: "#1a6fb5", fontStyle: "bold" },
      { token: "codeblock", foreground: "#7a7a7a" },
    ],
    colors: {
      "editor.background": "#00000000",
      "editor.foreground": "#1a1a1a",
      "editor.lineHighlightBackground": "#e8e8e8",
      "editor.selectionBackground": "#add6ff",
      "editor.inactiveSelectionBackground": "#e5ebf1",
      "editorCursor.foreground": "#1a1a1a",
      "editorLineNumber.foreground": "#888888",
      "editorLineNumber.activeForeground": "#1a1a1a",
      "editor.selectionHighlightBackground": "#d0d0d0",
      "editorBracketMatch.background": "#c8c8c8",
      "editorBracketMatch.border": "#a0a0a0",
      "editorGutter.background": "#00000000",
      "diffEditor.insertedTextBackground": "#34d39944",
      "diffEditor.removedTextBackground": "#f8717144",
      "diffEditor.diagonalFill": "#cccccc44",
    },
  })

  monaco.editor.defineTheme(DARK_THEME, {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "comment.teahouse", foreground: "#6a9955", fontStyle: "italic" },
      { token: "keyword.teahouse", foreground: "#d67fe0" },
      { token: "variable.teahouse", foreground: "#4fc1ff" },
      { token: "string.teahouse", foreground: "#ce9178" },
      { token: "header.teahouse", foreground: "#569cd6", fontStyle: "bold" },
      { token: "codeblock", foreground: "#a8a8a8" },
    ],
    colors: {
      "editor.background": "#00000000",
      "editor.foreground": "#dee5e0",
      "editor.lineHighlightBackground": "#18211d",
      "editor.selectionBackground": "#2b4d40",
      "editor.inactiveSelectionBackground": "#22302a",
      "editorCursor.foreground": "#dee5e0",
      "editorLineNumber.foreground": "#5f6d66",
      "editorLineNumber.activeForeground": "#c4cec8",
      "editor.selectionHighlightBackground": "#2b3a33",
      "editorBracketMatch.background": "#2b3a33",
      "editorBracketMatch.border": "#4a5c53",
      "editorGutter.background": "#00000000",
      "diffEditor.insertedTextBackground": "#22c55e33",
      "diffEditor.removedTextBackground": "#ef444433",
      "diffEditor.diagonalFill": "#88888822",
    },
  })
}

function isDarkMode(): boolean {
  return document.documentElement.classList.contains("dark")
}

// ---- Inline diff decorations via synchronous line diff ----

interface LineChangeBlock {
  origStart: number
  origEnd: number
  modStart: number
  modEnd: number
}

type DiffOp =
  | { type: "equal"; a: number; b: number }
  | { type: "insert"; b: number }
  | { type: "delete"; a: number }

function splitLines(s: string): string[] {
  return s === "" ? [] : s.split("\n")
}

// Myers O(ND) line diff, returning 1-based inclusive change blocks. We use this
// instead of a headless monaco createDiffEditor: that path is async
// (worker-backed) and creating/disposing one per keystroke races with editor
// disposal, intermittently throwing "InstantiationService has been disposed".
// A plain line diff is synchronous, has no editor/worker lifecycle, and yields
// the same gutter decorations.
function diffLines(orig: string[], mod: string[]): LineChangeBlock[] {
  const n = orig.length
  const m = mod.length
  const max = n + m
  const off = max
  const v = new Int32Array(2 * max + 1)
  const trace: Int32Array[] = []

  let d = 0
  outer: for (d = 0; d <= max; d++) {
    trace.push(v.slice())
    for (let k = -d; k <= d; k += 2) {
      let x
      if (k === -d || (k !== d && v[off + k - 1] < v[off + k + 1])) {
        x = v[off + k + 1]
      } else {
        x = v[off + k - 1] + 1
      }
      let y = x - k
      while (x < n && y < m && orig[x] === mod[y]) { x++; y++ }
      v[off + k] = x
      if (x >= n && y >= m) break outer
    }
  }

  const ops: DiffOp[] = []
  let x = n
  let y = m
  for (let i = trace.length - 1; i >= 1; i--) {
    const vv = trace[i]
    const k = x - y
    const prevK = k === -i || (k !== i && vv[off + k - 1] < vv[off + k + 1]) ? k + 1 : k - 1
    const prevX = vv[off + prevK]
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) { ops.push({ type: "equal", a: x - 1, b: y - 1 }); x--; y-- }
    if (x === prevX) { ops.push({ type: "insert", b: y - 1 }); y-- }
    else { ops.push({ type: "delete", a: x - 1 }); x-- }
  }
  while (x > 0 && y > 0) { ops.push({ type: "equal", a: x - 1, b: y - 1 }); x--; y-- }
  ops.reverse()

  const blocks: LineChangeBlock[] = []
  let i = 0
  while (i < ops.length) {
    if (ops[i].type === "equal") { i++; continue }
    let firstDel = -1
    let lastDel = -1
    let firstIns = -1
    let lastIns = -1
    while (i < ops.length && ops[i].type !== "equal") {
      const op = ops[i]
      if (op.type === "delete") {
        if (firstDel < 0) firstDel = op.a
        lastDel = op.a
      } else {
        if (firstIns < 0) firstIns = op.b
        lastIns = op.b
      }
      i++
    }
    // 1-based inclusive; empty side encoded as start = end + 1.
    blocks.push({
      origStart: firstDel >= 0 ? firstDel + 1 : 1,
      origEnd: firstDel >= 0 ? lastDel + 1 : 0,
      modStart: firstIns >= 0 ? firstIns + 1 : 1,
      modEnd: firstIns >= 0 ? lastIns + 1 : 0,
    })
  }
  return blocks
}

function computeLineDecorations(original: string, modified: string): Monaco.editor.IModelDeltaDecoration[] {
  const origLines = splitLines(original)
  const modLines = splitLines(modified)
  // Guard against pathological memory: the Myers trace grows with the edit
  // distance, so two large, mostly-different files would balloon it. Beyond
  // this size we skip the inline gutter diff rather than risk a hang.
  if (origLines.length + modLines.length > 4000) return []
  return diffLines(origLines, modLines).flatMap(c => {
    const decs: Monaco.editor.IModelDeltaDecoration[] = []

    const origLen = c.origEnd - c.origStart + 1
    const modLen = c.modEnd - c.modStart + 1
    const isDelete = origLen > 0 && modLen === 0
    const isInsert = origLen === 0 && modLen > 0

    const replaced = Math.min(origLen, modLen)

    for (let ln = c.modStart; ln <= c.modEnd; ln++) {
      const offset = ln - c.modStart
      const type = isDelete ? "deleted"
        : isInsert ? "added"
        : offset < replaced ? "modified"
        : "added"

      decs.push({
        range: { startLineNumber: ln, startColumn: 1, endLineNumber: ln, endColumn: 1 },
        options: {
          isWholeLine: true,
          // 只有 gutter 行标竖条，不做整行半透明高亮——整行背景会与
          // 光标行高亮(lineHighlightBackground)冲突，视觉噪。
          glyphMarginClassName: type === "deleted" ? "monaco-diff-glyph-deleted"
            : type === "added" ? "monaco-diff-glyph-added"
            : "monaco-diff-glyph-modified",
          glyphMarginHoverMessage: {
            value: type === "deleted" ? i18n.t("misc:monaco.deletedLine") : type === "added" ? i18n.t("misc:monaco.addedLine") : i18n.t("misc:monaco.modifiedLine"),
          },
        },
      })
    }
    return decs
  })
}

// ---- Editor component ----

export interface MonacoEditorProps {
  height?: string | number
  /** Content to seed the buffer on mount. Uncontrolled: the editor owns the
   *  buffer afterwards; external changes arrive via a `key` remount. */
  defaultValue?: string
  onChange?: (value: string) => void
  /** Original (saved) value — enables inline diff gutters */
  original?: string
  /** Unique identifier for the current file — used to track model swap */
  path?: string
  language?: string
  options?: Monaco.editor.IStandaloneEditorConstructionOptions
  onMount?: (editor: Monaco.editor.IStandaloneCodeEditor, monaco: typeof Monaco) => void
  /** Called when Ctrl+S is pressed inside the editor */
  onSave?: () => void
  /** Ctrl/Cmd+Click 落在 {{path}} 占位符上时回调，携带目标路径(未加 root/ 前缀)。 */
  onOpenPath?: (path: string) => void
  minimap?: boolean
  readOnly?: boolean
  className?: string
}

export function MonacoEditor({
  height = "100%",
  defaultValue = "",
  onChange,
  original,
  path,
  language = "plaintext",
  options = {},
  onMount,
  onSave,
  onOpenPath,
  minimap = false,
  readOnly = false,
  className,
}: MonacoEditorProps) {
  const { t } = useTranslation("misc")
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null)
  const monacoRef = useRef<typeof Monaco | null>(null)
  const decorationsRef = useRef<Monaco.editor.IEditorDecorationsCollection | null>(null)
  const [editorReady, setEditorReady] = useState(false)
  // The editor's own buffer, mirrored only to drive diff decorations.
  const [currentValue, setCurrentValue] = useState(defaultValue)
  // 记录已播种的 path：在复用实例/换 model 场景下，path 变化时用 defaultValue 重播种
  // 缓冲（非受控 defaultValue 只在 mount 读），避免 diff 装饰拿到上一个文件的旧内容。
  const lastPathRef = useRef<string | null>(null)
  // Ctrl+Click 跳转回调镜像：handleMount 只在首次挂载注册一次监听，读取需走 ref 避免闭包陈旧。
  const onOpenPathRef = useRef(onOpenPath)
  onOpenPathRef.current = onOpenPath
  // Ctrl+Hover 手型提示：跟踪全局 ctrl/meta 按住态 + 当前指针悬停的可跳占位符 range，
  // 二者同时满足时用一个 decoration(inlineClassName .ph-open-pointer) 让 Monaco 文本变手型。
  const ctrlHeldRef = useRef(false)
  const hoverLinkRef = useRef<{ lineNumber: number; start: number; end: number } | null>(null)
  const linkHoverDecoRef = useRef<Monaco.editor.IEditorDecorationsCollection | null>(null)
  // 由 handleMount 赋值；供组件级全局 ctrl 监听在 ctrl 态变化时重算手型 decoration。
  const updateLinkHoverRef = useRef<() => void>(() => {})
  const uiMultiplier = useUiScaleStore((s) => s.multiplier)
  const scaledFontSize = Math.round(13 * uiMultiplier)

  const handleMount: OnMount = useCallback((editor, monaco) => {
    editorRef.current = editor
    monacoRef.current = monaco
    defineThemes(monaco)
    monaco.editor.setTheme(isDarkMode() ? DARK_THEME : LIGHT_THEME)

    // Ctrl/Cmd+Click 落在可跳 {{path}} 上 → 打开目标文件。仅命中时 preventDefault，避免
    // Monaco 默认的 ctrl+click 加副光标/动选区；未命中则保留原生多光标语义。
    editor.onMouseDown((e: Monaco.editor.IEditorMouseEvent) => {
      if (!e.event.ctrlKey && !e.event.metaKey) return
      if (e.event.leftButton !== true) return
      const model = editor.getModel()
      if (!model || model.getLanguageId() !== "teahouse") return
      // 仅文本内容目标可命中；空白/行号/gutter 无 position 自然跳过。
      const t = e.target
      const pos = (t as { position?: Monaco.IPosition })?.position
      if (!pos) return
      const line = model.getLineContent(pos.lineNumber)
      const hit = findClickTargetAtColumn(line, pos.column)
      if (hit) {
        e.event.preventDefault()
        e.event.stopPropagation()
        onOpenPathRef.current?.(hit.path)
      }
    })

    // Ctrl+Hover 手型：鼠标移动时更新"悬停占位符 range"，并按 ctrl 态应用/清除手型 decoration。
    const updateLinkHover = () => {
      const editor = editorRef.current
      if (!editor) return
      if (!linkHoverDecoRef.current) {
        linkHoverDecoRef.current = editor.createDecorationsCollection()
      }
      const h = hoverLinkRef.current
      if (h && ctrlHeldRef.current) {
        linkHoverDecoRef.current.set([{
          range: new Monaco.Range(h.lineNumber, h.start + 1, h.lineNumber, h.end),
          options: { inlineClassName: "ph-open-pointer" },
        }])
      } else {
        linkHoverDecoRef.current.clear()
      }
    }
    updateLinkHoverRef.current = updateLinkHover
    editor.onMouseMove((e: Monaco.editor.IEditorMouseEvent) => {
      const model = editor.getModel()
      const t = e.target
      const pos = (t as { position?: Monaco.IPosition })?.position
      if (!model || model.getLanguageId() !== "teahouse" || !pos) {
        hoverLinkRef.current = null
        updateLinkHover()
        return
      }
      const line = model.getLineContent(pos.lineNumber)
      const hit = findClickTargetAtColumn(line, pos.column)
      hoverLinkRef.current = hit
        ? { lineNumber: pos.lineNumber, start: hit.start, end: hit.end }
        : null
      updateLinkHover()
    })

    setEditorReady(true)
    onMount?.(editor, monaco)
  }, [])  // only on initial mount

  // Theme following via MutationObserver
  useEffect(() => {
    const monaco = monacoRef.current
    if (!monaco) return

    const observer = new MutationObserver(() => {
      monaco.editor.setTheme(isDarkMode() ? DARK_THEME : LIGHT_THEME)
    })
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    })
    return () => observer.disconnect()
  }, [])

  // Ctrl+S binding
  useEffect(() => {
    const editor = editorRef.current
    if (!editor || !onSave) return
    const disposable = editor.addAction({
      id: "teahouse-save",
      label: "Save File",
      keybindings: [monacoRef.current!.KeyMod.CtrlCmd | monacoRef.current!.KeyCode.KeyS],
      run: () => onSave(),
    })
    return () => disposable.dispose()
  }, [onSave])

  // 全局 ctrl/meta 按住态跟踪：ctrl 态变化时重算手型 decoration。窗口失焦兜底清掉按住态。
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !ctrlHeldRef.current) {
        ctrlHeldRef.current = true
        updateLinkHoverRef.current()
      }
    }
    const onKeyUp = (e: KeyboardEvent) => {
      if (!e.ctrlKey && !e.metaKey && ctrlHeldRef.current) {
        ctrlHeldRef.current = false
        updateLinkHoverRef.current()
      }
    }
    const onBlur = () => { if (ctrlHeldRef.current) { ctrlHeldRef.current = false; updateLinkHoverRef.current() } }
    document.addEventListener("keydown", onKeyDown)
    document.addEventListener("keyup", onKeyUp)
    window.addEventListener("blur", onBlur)
    return () => {
      document.removeEventListener("keydown", onKeyDown)
      document.removeEventListener("keyup", onKeyUp)
      window.removeEventListener("blur", onBlur)
    }
  }, [])

  // Seed the buffer with the current file's defaultValue when the edited path
  // changes (non-controlled defaultValue is only read at mount). Under the current
  // parent it remounts per file (key change) so this only guards future reuse of a
  // single editor instance; on the initial mount defaultValue is already seeded, so
  // we record the path without re-seeding to avoid resetting the undo stack.
  useEffect(() => {
    const editor = editorRef.current
    if (!editor || !editorReady) return
    if (path === lastPathRef.current) return
    const firstSeed = lastPathRef.current === null
    lastPathRef.current = path ?? null
    if (!firstSeed) {
      editor.setValue(defaultValue)
      setCurrentValue(defaultValue)
    }
  }, [path, defaultValue, editorReady])

  // Apply diff decorations
  useEffect(() => {
    if (!editorReady) return
    const editor = editorRef.current
    if (!editor) return

    // Normalize line endings only. Trailing newline is a real content
    // difference, so it is preserved (no trimEnd) — unlike the old
    // spurious-empty-line workaround that hid a real change.
    const norm = (s: string | undefined) => (s || "").replace(/\r\n/g, "\n")
    const normalizedValue = norm(currentValue)
    const normalizedOriginal = norm(original)

    if (normalizedValue === normalizedOriginal) {
      if (decorationsRef.current) {
        decorationsRef.current.clear()
        decorationsRef.current = null
      }
      return
    }

    const decs = computeLineDecorations(normalizedOriginal, normalizedValue)
    if (decorationsRef.current) {
      decorationsRef.current.clear()
    }
    decorationsRef.current = editor.createDecorationsCollection(decs)
  }, [editorReady, currentValue, original])

  const mergedOptions: Monaco.editor.IStandaloneEditorConstructionOptions = useMemo(() => ({
    minimap: { enabled: minimap },
    // 全局字号缩放 —— @monaco-editor/react 在 options 引用变化时会对已挂载
    // 实例 updateOptions，故乘数进入 deps 即可实时跟随后台切档。调用方显式
    // 传入的 options.fontSize 仍可覆盖（...options 在后）。
    fontSize: scaledFontSize,
    lineNumbers: "on",
    scrollBeyondLastLine: false,
    wordWrap: "on",
    tabSize: 2,
    automaticLayout: true,
    padding: { top: 12 },
    readOnly,
    glyphMargin: true,
    folding: true,
    matchBrackets: "never",
    // 中文正文中全角标点（：）（U+FF1A 等）与 ASCII 易混淆，默认高亮会在
    // 每个全角冒号/括号上画黄色框，纯属噪音——默认关闭，需要时可经 options 覆盖。
    unicodeHighlight: {
      ambiguousCharacters: false,
      invisibleCharacters: false,
    },
    ...options,
  }), [minimap, readOnly, options, scaledFontSize])

  return (
    <div className={className} style={{ height, width: "100%" }}>
      <Editor
        height="100%"
        path={path}
        language={language}
        defaultValue={defaultValue}
        loading={
          <div className="flex h-full w-full items-center justify-center text-sm text-muted-foreground">
            {t("monaco.loading")}
          </div>
        }
        onChange={(val) => {
          const v = val || ""
          setCurrentValue(v)
          onChange?.(v)
        }}
        theme={isDarkMode() ? DARK_THEME : LIGHT_THEME}
        onMount={handleMount}
        options={mergedOptions}
      />
    </div>
  )
}
