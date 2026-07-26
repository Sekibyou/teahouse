import { useEffect, useRef, useMemo, useCallback, useState } from "react"
import { DiffEditor as ReactDiffEditor, loader } from "@monaco-editor/react"
import type * as Monaco from "monaco-editor"

// ---- CDN config ----
loader.config({
  paths: {
    vs: "https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min/vs",
  },
})

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

// ---- Inline diff decorations via headless Monaco DiffEditor ----

async function computeLineDecorations(
  monaco: typeof Monaco,
  original: string,
  modified: string,
  language: string,
): Promise<Monaco.editor.IModelDeltaDecoration[]> {
  const container = document.createElement("div")
  const diffEditor = monaco.editor.createDiffEditor(container, {
    diffAlgorithm: "advanced",
    ignoreTrimWhitespace: false,
  })
  const originalModel = monaco.editor.createModel(original, language)
  const modifiedModel = monaco.editor.createModel(modified, language)
  const vm = diffEditor.createViewModel({ original: originalModel, modified: modifiedModel })
  diffEditor.setModel(vm)

  try {
    await vm.waitForDiff()
    const changes = diffEditor.getLineChanges()
    if (!changes) return []

    return changes.flatMap(c => {
      const decs: Monaco.editor.IModelDeltaDecoration[] = []

      const origLen = c.originalEndLineNumber - c.originalStartLineNumber + 1
      const modLen = c.modifiedEndLineNumber - c.modifiedStartLineNumber + 1
      const isDelete = origLen > 0 && modLen === 0
      const isInsert = origLen === 0 && modLen > 0

      const replaced = Math.min(origLen, modLen)

      for (let ln = c.modifiedStartLineNumber; ln <= c.modifiedEndLineNumber; ln++) {
        const offset = ln - c.modifiedStartLineNumber
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
  } finally {
    vm.dispose()
    diffEditor.dispose()
    originalModel.dispose()
    modifiedModel.dispose()
  }
}

// ---- Editor component ----

export interface MonacoEditorProps {
  height?: string | number
  value: string
  onChange?: (value: string) => void
  /** Original (saved) value — enables inline diff gutters */
  original?: string
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
  language = "plaintext",
  options = {},
  onMount,
  onSave,
  minimap = false,
  readOnly = false,
  className,
}: MonacoEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null)
  const monacoRef = useRef<typeof Monaco | null>(null)
  const decorationsRef = useRef<Monaco.editor.IEditorDecorationsCollection | null>(null)
  const onChangeRef = useRef(onChange)
  const onSaveRef = useRef(onSave)
  const onMountRef = useRef(onMount)
  const [monacoReady, setMonacoReady] = useState<typeof Monaco | null>(null)

  // Keep callback refs up-to-date
  onChangeRef.current = onChange
  onSaveRef.current = onSave
  onMountRef.current = onMount

  // Load Monaco once
  useEffect(() => {
    let disposed = false
    loader.init().then((monaco) => {
      if (disposed) return
      defineThemes(monaco)
      monaco.editor.setTheme(isDarkMode() ? DARK_THEME : LIGHT_THEME)
      setMonacoReady(monaco)
    })
    return () => { disposed = true }
  }, [])

  // Create/dispose editor instance & model on every value/language change
  useEffect(() => {
    const monaco = monacoReady
    if (!monaco || !containerRef.current) return

    // Dispose previous editor & its model
    if (editorRef.current) {
      editorRef.current.getModel()?.dispose()
      editorRef.current.dispose()
      editorRef.current = null
    }

    // Create a fresh model (unique per value, no reuse = no stale undo stack)
    const model = monaco.editor.createModel(value, language)

    const mergedOptions: Monaco.editor.IStandaloneEditorConstructionOptions = {
      model,
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
      ...options,
    }

    const editor = monaco.editor.create(containerRef.current, mergedOptions)
    editorRef.current = editor
    monacoRef.current = monaco

    // Listen for changes
    editor.onDidChangeModelContent(() => {
      onChangeRef.current?.(editor.getValue())
    })

    // Ctrl+S
    if (onSaveRef.current) {
      editor.addAction({
        id: "teahouse-save",
        label: "Save File",
        keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
        run: () => onSaveRef.current?.(),
      })
    }

    onMountRef.current?.(editor, monaco)

    return () => {
      model.dispose()
      editor.dispose()
      editorRef.current = null
      monacoRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [monacoReady, value, language])

  // Apply diff decorations
  useEffect(() => {
    const editor = editorRef.current
    const monaco = monacoRef.current
    if (!editor || !monaco || !original) return

    if (value === original) {
      if (decorationsRef.current) {
        decorationsRef.current.clear()
        decorationsRef.current = null
      }
      return
    }

    let cancelled = false
    computeLineDecorations(monaco, original, value, language).then(decs => {
      if (cancelled) return
      if (decorationsRef.current) {
        decorationsRef.current.clear()
      }
      decorationsRef.current = editor.createDecorationsCollection(decs)
    })

    return () => { cancelled = true }
  }, [value, original, language])

  // Theme following via MutationObserver
  useEffect(() => {
    const monaco = monacoReady
    if (!monaco) return

    const observer = new MutationObserver(() => {
      monaco.editor.setTheme(isDarkMode() ? DARK_THEME : LIGHT_THEME)
    })
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    })
    return () => observer.disconnect()
  }, [monacoReady])

  return (
    <div className={className} style={{ height, width: "100%" }}>
      <div ref={containerRef} style={{ height: "100%", width: "100%" }} />
    </div>
  )
}

// ---- Diff Editor ----

export interface DiffEditorProps {
  original: string
  modified: string
  language?: string
  height?: string | number
  minimap?: boolean
  options?: Monaco.editor.IDiffEditorConstructionOptions
  className?: string
}

export function MonacoDiffEditor({
  original,
  modified,
  language = "plaintext",
  height = "100%",
  minimap = false,
  options = {},
  className,
}: DiffEditorProps) {
  const monacoRef = useRef<typeof Monaco | null>(null)

  const handleDiffMount = useCallback((_editor: unknown, monaco: typeof Monaco) => {
    monacoRef.current = monaco
    const theme = monaco.editor.getTheme()
    if (theme !== LIGHT_THEME && theme !== DARK_THEME) {
      defineThemes(monaco)
    }
    monaco.editor.setTheme(isDarkMode() ? DARK_THEME : LIGHT_THEME)
  }, [])

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

  const mergedOptions: Monaco.editor.IDiffEditorConstructionOptions = useMemo(() => ({
    minimap: { enabled: minimap },
    fontSize: 13,
    lineNumbers: "on",
    scrollBeyondLastLine: false,
    wordWrap: "on",
    tabSize: 2,
    automaticLayout: true,
    enableSplitViewResizing: true,
    renderSideBySide: true,
    diffAlgorithm: "advanced",
    ignoreTrimWhitespace: false,
    ...options,
  }), [minimap, options])

  return (
    <div className={className} style={{ height, width: "100%" }}>
      <ReactDiffEditor
        height="100%"
        language={language}
        original={original}
        modified={modified}
        theme={isDarkMode() ? DARK_THEME : LIGHT_THEME}
        onMount={handleDiffMount}
        options={mergedOptions}
      />
    </div>
  )
}
