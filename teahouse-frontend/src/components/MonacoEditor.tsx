import { useEffect, useRef, useMemo, useCallback, useState } from "react"
import Editor, { type OnMount, loader } from "@monaco-editor/react"
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
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null)
  const monacoRef = useRef<typeof Monaco | null>(null)
  const decorationsRef = useRef<Monaco.editor.IEditorDecorationsCollection | null>(null)
  const [editorReady, setEditorReady] = useState(false)

  const handleMount: OnMount = useCallback((editor, monaco) => {
    editorRef.current = editor
    monacoRef.current = monaco
    defineThemes(monaco)
    monaco.editor.setTheme(isDarkMode() ? DARK_THEME : LIGHT_THEME)

    // The <Editor> component sets an empty model then calls setValue(text).
    // This means "undo" from the user's first edit goes through
    //   user edit → setValue → empty → nothing
    // which makes it look like you can undo back to an empty file.
    // We work around it by creating the model ourselves populated with the
    // initial text, so the undo stack starts clean.
    const existingModel = editor.getModel()
    if (existingModel) {
      // Create a fresh model pre-populated with the value,
      // then swap it in so the undo stack has nothing before the content.
      const freshModel = monaco.editor.createModel(value, language)
      editor.setModel(freshModel)
      existingModel.dispose()
    }

    setEditorReady(true)
    onMount?.(editor, monaco)
  }, [value, language, onMount])

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
    const monaco = monacoRef.current
    if (!editor || !monaco) return

    // Normalize trailing newlines for comparison — Monaco models always end with \n,
    // which can cause a spurious empty-line diff when original lacks a trailing newline.
    const norm = (s: string) => s.replace(/\r\n/g, "\n").trimEnd()
    const normalizedValue = norm(value)
    const normalizedOriginal = norm(original)

    if (normalizedValue === normalizedOriginal) {
      if (decorationsRef.current) {
        decorationsRef.current.clear()
        decorationsRef.current = null
      }
      return
    }

    let cancelled = false
    computeLineDecorations(monaco, normalizedOriginal, normalizedValue, language).then(decs => {
      if (cancelled) return
      if (decorationsRef.current) {
        decorationsRef.current.clear()
      }
      decorationsRef.current = editor.createDecorationsCollection(decs)
    })

    return () => { cancelled = true }
  }, [editorReady, value, original, language])

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
    ...options,
  }), [minimap, readOnly, options])

  return (
    <div className={className} style={{ height, width: "100%" }}>
      <Editor
        height="100%"
        language={language}
        onChange={(val) => onChange?.(val || "")}
        theme={isDarkMode() ? DARK_THEME : LIGHT_THEME}
        onMount={handleMount}
        options={mergedOptions}
      />
    </div>
  )
}
