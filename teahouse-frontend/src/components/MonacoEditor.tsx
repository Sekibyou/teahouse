import { useEffect, useRef, useMemo, useCallback } from "react"
import Editor, { DiffEditor as ReactDiffEditor, type OnMount, loader } from "@monaco-editor/react"
import type * as Monaco from "monaco-editor"
import DiffMatchPatch from "diff-match-patch"

// ---- CDN config ----
loader.config({
  paths: {
    vs: "https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min/vs",
  },
})

// ---- Theme helpers ----
// Background set to transparent — parent container provides the correct --background.

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

// ---- Inline diff decorations ----
// Uses diff-match-patch for line-level Myers diff, then merges adjacent
// DELETE+INSERT pairs into MODIFIED when similarity exceeds threshold.

interface DiffLineInfo {
  lineNumber: number
  type: "added" | "deleted" | "modified"
}

const SIMILARITY_THRESHOLD = 0.6

/**
 * Levenshtein edit distance between two strings.
 * O(n*m) — fine for typical line lengths (<200 chars).
 */
function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length
  // Use two-row DP to save memory
  let prev = new Array<number>(n + 1)
  let curr = new Array<number>(n + 1)
  for (let j = 0; j <= n; j++) prev[j] = j
  for (let i = 1; i <= m; i++) {
    curr[0] = i
    for (let j = 1; j <= n; j++) {
      curr[j] = a[i - 1] === b[j - 1]
        ? prev[j - 1]
        : 1 + Math.min(prev[j], curr[j - 1], prev[j - 1])
    }
    ;[prev, curr] = [curr, prev]
  }
  return prev[n]
}

/**
 * Normalised similarity in [0, 1].
 * 1 = identical, 0 = completely different.
 */
function lineSimilarity(a: string, b: string): number {
  if (a === b) return 1
  if (a.length === 0 || b.length === 0) return 0
  const dist = levenshtein(a, b)
  return 1 - dist / Math.max(a.length, b.length)
}

/**
 * Compute changed lines between original and modified text.
 *
 * Strategy: run diff-match-patch at the character level, then walk the
 * character-level edit script and aggregate changes onto line boundaries.
 *
 * Each newline in the char-level diff naturally separates lines.  We
 * maintain old-side and new-side content fragments per line, so we can
 * tell whether a line was inserted, deleted, or modified.
 */
function computeLineDiff(original: string, modified: string): DiffLineInfo[] {
  if (original === modified) return []

  const dmp = new DiffMatchPatch()
  let diffs = dmp.diff_main(original, modified, true)
  dmp.diff_cleanupSemantic(diffs)

  // Per-line buffers: walk char by char, split on \n.
  // A LineBuf accumulates old-side and new-side characters for one
  // conceptual "line".  When we hit \n, the current line is finalised
  // and a new empty line starts — EXCEPT for the \n character itself,
  // which is always EQUAL (both sides have it, it's a line separator).
  // We treat \n as always-unchanged and never render it as part of a
  // diff annotation.

  interface LineBuf {
    oldChars: string
    newChars: string
  }

  const lines: LineBuf[] = [{ oldChars: "", newChars: "" }]
  let li = 0 // current line index

  for (const [op, text] of diffs) {
    for (const ch of text) {
      if (ch === "\n") {
        // Newline — advance to next line regardless of op.
        // The \n itself is structural, never part of content diff.
        li++
        if (li >= lines.length) lines.push({ oldChars: "", newChars: "" })
      } else if (op === DiffMatchPatch.DIFF_EQUAL) {
        lines[li].oldChars += ch
        lines[li].newChars += ch
      } else if (op === DiffMatchPatch.DIFF_DELETE) {
        lines[li].oldChars += ch
      } else if (op === DiffMatchPatch.DIFF_INSERT) {
        lines[li].newChars += ch
      }
    }
  }

  // Second pass: classify each line by what it has on old vs new side.
  // Lines where old===new are unchanged and skipped.
  const result: DiffLineInfo[] = []

  for (let i = 0; i < lines.length; i++) {
    const { oldChars, newChars } = lines[i]
    const modifiedLine = i + 1

    if (oldChars === newChars) {
      // Unchanged — skip
      continue
    }

    if (oldChars !== "" && newChars !== "") {
      // Both sides have content → modified (with similarity check)
      const sim = lineSimilarity(oldChars, newChars)
      result.push({ lineNumber: modifiedLine, type: sim >= SIMILARITY_THRESHOLD ? "modified" : "added" })
    } else if (newChars !== "") {
      // Only new side → pure insert
      result.push({ lineNumber: modifiedLine, type: "added" })
    } else if (oldChars !== "") {
      // Only old side → pure delete (line exists in old, not in new)
      result.push({ lineNumber: modifiedLine, type: "deleted" })
    }
  }

  return result
}

function applyDiffDecorations(
  editor: Monaco.editor.IStandaloneCodeEditor,
  original: string,
  modified: string,
): Monaco.editor.IEditorDecorationsCollection | null {
  const model = editor.getModel()
  if (!model) return null

  const diff = computeLineDiff(original, modified)

  const decorations: Monaco.editor.IModelDeltaDecoration[] = diff
    .filter(d => d.type !== "deleted") // deleted lines don't exist in the current model
    .map(d => {
      return {
      range: {
        startLineNumber: d.lineNumber,
        startColumn: 1,
        endLineNumber: d.lineNumber,
        endColumn: 1,
      },
      options: {
        isWholeLine: true,
        className: d.type === "modified" ? "monaco-diff-modified-line" : "monaco-diff-added-line",
        glyphMarginClassName: d.type === "modified" ? "monaco-diff-glyph-modified" : "monaco-diff-glyph-added",
        glyphMarginHoverMessage: { value: d.type === "modified" ? "修改行" : "新增行" },
      },
    }
    })

  return editor.createDecorationsCollection(decorations)
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
  minimap = false,
  readOnly = false,
  className,
}: MonacoEditorProps) {
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null)
  const monacoRef = useRef<typeof Monaco | null>(null)
  const decorationsRef = useRef<Monaco.editor.IEditorDecorationsCollection | null>(null)

  const handleMount: OnMount = useCallback((editor, monaco) => {
    editorRef.current = editor
    monacoRef.current = monaco
    defineThemes(monaco)
    monaco.editor.setTheme(isDarkMode() ? DARK_THEME : LIGHT_THEME)
    onMount?.(editor, monaco)
  }, [onMount])

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

  // Apply diff decorations
  useEffect(() => {
    const editor = editorRef.current
    if (!editor || !original) return

    if (decorationsRef.current) {
      decorationsRef.current.clear()
    }

    if (value === original) return // clean

    decorationsRef.current = applyDiffDecorations(editor, original, value)
  }, [value, original])

  // Apply initial decorations on mount if already dirty
  useEffect(() => {
    const editor = editorRef.current
    if (!editor || !original) return
    if (value === original || decorationsRef.current) return

    decorationsRef.current = applyDiffDecorations(editor, original, value)
  }, [original, value])

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
    ...options,
  }), [minimap, readOnly, options])

  return (
    <div className={className} style={{ height, width: "100%" }}>
      <Editor
        height="100%"
        language={language}
        value={value}
        onChange={(val) => onChange?.(val || "")}
        theme={isDarkMode() ? DARK_THEME : LIGHT_THEME}
        onMount={handleMount}
        options={mergedOptions}
      />
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
