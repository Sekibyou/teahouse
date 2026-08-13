import { useEffect, useRef, useMemo, useCallback, useState } from "react"
import Editor, { type OnMount, loader } from "@monaco-editor/react"
import * as Monaco from "monaco-editor"
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker"

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

// ---- Theme helpers ----

const LIGHT_THEME = "teahouse-light"
const DARK_THEME = "teahouse-dark"

function defineThemes(monaco: typeof Monaco) {
  monaco.editor.defineTheme(LIGHT_THEME, {
    base: "vs",
    inherit: true,
    rules: [],
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
    rules: [],
    colors: {
      "editor.background": "#00000000",
      "editor.foreground": "#e0e0e0",
      "editor.lineHighlightBackground": "#2a2a3a",
      "editor.selectionBackground": "#264f78",
      "editor.inactiveSelectionBackground": "#3a3d41",
      "editorCursor.foreground": "#e0e0e0",
      "editorLineNumber.foreground": "#666666",
      "editorLineNumber.activeForeground": "#cccccc",
      "editor.selectionHighlightBackground": "#333344",
      "editorBracketMatch.background": "#333344",
      "editorBracketMatch.border": "#555566",
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

  const ops: Array<{ type: "equal" | "insert" | "delete"; a: number; b: number }> = []
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
      if (ops[i].type === "delete") {
        if (firstDel < 0) firstDel = ops[i].a
        lastDel = ops[i].a
      } else {
        if (firstIns < 0) firstIns = ops[i].b
        lastIns = ops[i].b
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
          className: type === "deleted" ? "monaco-diff-deleted-line"
            : type === "added" ? "monaco-diff-added-line"
            : "monaco-diff-modified-line",
          glyphMarginClassName: type === "deleted" ? "monaco-diff-glyph-deleted"
            : type === "added" ? "monaco-diff-glyph-added"
            : "monaco-diff-glyph-modified",
          glyphMarginHoverMessage: {
            value: type === "deleted" ? "删除行" : type === "added" ? "新增行" : "修改行",
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
  value: string
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
  minimap?: boolean
  readOnly?: boolean
  className?: string
}

export function MonacoEditor({
  height = "100%",
  value,
  onChange,
  original,
  path,
  language = "plaintext",
  options = {},
  onMount,
  onSave,
  minimap = false,
  readOnly = false,
  className,
}: MonacoEditorProps) {
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null)
  const monacoRef = useRef<typeof Monaco | null>(null)
  const decorationsRef = useRef<Monaco.editor.IEditorDecorationsCollection | null>(null)
  const [editorReady, setEditorReady] = useState(false)

  const handleMount: OnMount = useCallback((editor, monaco) => {
    editorRef.current = editor
    monacoRef.current = monaco
    defineThemes(monaco)
    monaco.editor.setTheme(isDarkMode() ? DARK_THEME : LIGHT_THEME)

    // The library creates a model for `path`; the value effect below keeps it
    // in sync when content loads async or a file switch hands us a new path.
    setEditorReady(true)
    onMount?.(editor, monaco)
  }, [])  // only on initial mount

  // Push value into the model when it changes (e.g. file content loaded async
  // after the editor has already mounted with the same path but empty value,
  // or when switching between files where the new file's content hasn't loaded yet).
  // Must NOT use model.setValue(): it clears the whole undo stack
  // (textModel._commandManager.clear()), so Ctrl+Z stops working after any
  // SSE refresh / file switch that re-pushes content. executeEdits keeps the
  // undo stack intact and lands the sync as a single undo step; pushUndoStop
  // closes that step so the next user edit starts fresh.
  // Note: executeEdits is a no-op on a readOnly editor, so don't wrap with a
  // readOnly toggle.
  useEffect(() => {
    const editor = editorRef.current
    const monaco = monacoRef.current
    if (!editor || !monaco || !editorReady) return

    const model = editor.getModel()
    if (!model) return

    if (model.getValue(monaco.editor.EndOfLinePreference.LF) === value) return

    editor.executeEdits(
      "teahouse-sync",
      [{ range: model.getFullModelRange(), text: value, forceMoveMarkers: true }],
    )
    editor.pushUndoStop()
  }, [value, editorReady])

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

  // Apply diff decorations
  useEffect(() => {
    if (!editorReady) return
    const editor = editorRef.current
    if (!editor) return

    // Normalize trailing newlines for comparison — Monaco models always end with \n,
    // which can cause a spurious empty-line diff when original lacks a trailing newline.
    const norm = (s: string | undefined) => (s || "").replace(/\r\n/g, "\n").trimEnd()
    const normalizedValue = norm(value)
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
  }, [editorReady, value, original])

  const mergedOptions: Monaco.editor.IStandaloneEditorConstructionOptions = useMemo(() => ({
    minimap: { enabled: minimap },
    fontSize: 13,
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
  }), [minimap, readOnly, options])

  return (
    <div className={className} style={{ height, width: "100%" }}>
      <Editor
        height="100%"
        path={path}
        language={language}
        loading={
          <div className="flex h-full w-full items-center justify-center text-sm text-muted-foreground">
            正在加载编辑器…
          </div>
        }
        onChange={(val) => onChange?.(val || "")}
        theme={isDarkMode() ? DARK_THEME : LIGHT_THEME}
        onMount={handleMount}
        options={mergedOptions}
      />
    </div>
  )
}
