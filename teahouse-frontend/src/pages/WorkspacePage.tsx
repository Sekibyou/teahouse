import { useEffect, useState, useCallback, useRef } from "react"
import { useNavigate, useOutletContext } from "react-router-dom"
import { MonacoEditor } from "@/components/MonacoEditor"
import { MarkdownRenderer } from "@/components/MarkdownRenderer"
import {
  File, Folder, FolderOpen, Plus, Trash2, Loader2,
  ChevronRight, ChevronDown, Save, FileText,
  PanelLeftOpen, GripVertical, Archive,
  MessageCircle, FolderTree, Menu, X, Gamepad2, Wrench,
  GitBranch, Sun, Moon, Settings, ArrowLeft, Upload, Pencil,
  Eye, Code2,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { instancesApi, gitApi, prototypesApi } from "@/lib/api"
import { useSessionStore } from "@/stores/sessionStore"
import { useViewModeStore } from "@/stores/viewModeStore"
import { useGitStore } from "@/stores/gitStore"
import { useSettingsDialogStore } from "@/stores/settingsDialogStore"
import { ChatPanel } from "@/components/ChatPanel"
import { OutputPanel } from "@/components/OutputPanel"
import { ConfirmDialog } from "@/components/ConfirmDialog"
import { GitDialog } from "@/components/GitDialog"
import { useWorkspaceRefresh } from "@/hooks/useWorkspaceRefresh"
import { useSSERefresh } from "@/hooks/useSSERefresh"
import { useIsMobile } from "@/hooks/useMediaQuery"
import { useDialogBackClose } from "@/hooks/useDialogBackClose"
import type { FileTreeNode } from "@/lib/types"

// Monaco Editor theme follows system dark mode — handled by MonacoEditor component

export function WorkspacePage() {
  const navigate = useNavigate()
  const activeInstance = useSessionStore((s) => s.activeInstance)
  const setActiveInstance = useSessionStore((s) => s.setActiveInstance)
  const mode = useViewModeStore((s) => s.mode)
  const chatWidth = useViewModeStore((s) => s.chatWidth)
  const chatCollapsed = useViewModeStore((s) => s.chatCollapsed)
  const setChatCollapsed = useViewModeStore((s) => s.setChatCollapsed)
  const setChatWidth = useViewModeStore((s) => s.setChatWidth)
  const isMobile = useIsMobile()
  const { toggleTheme } = useOutletContext<{ isMobile: boolean; toggleTheme: () => void }>()
  const openSettings = useSettingsDialogStore((s) => s.openSettings)

  // Mobile state
  const [showFileTree, setShowFileTree] = useState(false)
  const [showMobileMenu, setShowMobileMenu] = useState(false)
  const [fullscreenPanel, setFullscreenPanel] = useState<"director" | "git" | null>(null)
  useDialogBackClose(fullscreenPanel === "director", () => setFullscreenPanel(null))
  const [isDark, setIsDark] = useState(() => {
    const saved = localStorage.getItem("theme")
    return saved ? saved === "dark" : true
  })

  const handleToggleTheme = () => {
    setIsDark(!isDark)
    document.documentElement.classList.toggle("dark", !isDark)
    localStorage.setItem("theme", isDark ? "light" : "dark")
    if (toggleTheme) toggleTheme()
  }

  const [fileTree, setFileTree] = useState<FileTreeNode[]>([])
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [fileContent, setFileContent] = useState("")
  const [editedContent, setEditedContent] = useState("")
  const [isDirty, setIsDirty] = useState(false)
  // 外部刷新当前文件时自增，触发 Monaco 按 key 重挂载（defaultValue 仅在 mount 读取）
  const [editorEpoch, setEditorEpoch] = useState(0)
  // .md 文件可在代码编辑器与 Markdown 预览间切换
  const [editorView, setEditorView] = useState<"code" | "preview">("code")
  const [isLoading, setIsLoading] = useState(true)
  const initialLoadRef = useRef(true)
  // 文件加载/重载请求序号，丢弃过期响应（快速连点不同文件防串号）
  const loadSeqRef = useRef(0)
  const [isSaving, setIsSaving] = useState(false)
  const [saveToast, setSaveToast] = useState<boolean>(false)
  const saveToastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const saveToastRef = useRef<HTMLSpanElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const uploadPathRef = useRef<string>("")

  const showSaveToast = useCallback(() => {
    if (saveToastTimer.current) clearTimeout(saveToastTimer.current)
    setSaveToast(true)
    saveToastTimer.current = setTimeout(() => {
      const el = saveToastRef.current
      if (el) {
        el.style.transition = "opacity 500ms ease-out"
        el.style.opacity = "0"
        saveToastTimer.current = setTimeout(() => {
          setSaveToast(false)
        }, 500)
      }
    }, 1500)
  }, [])
  // Track whether the file content has finished loading

  const [showCreate, setShowCreate] = useState<{ parentPath: string; type: "file" | "directory" } | null>(null)
  const [createName, setCreateName] = useState("")

  // Rename / delete
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)
  const [renameTarget, setRenameTarget] = useState<string | null>(null)
  const [renameName, setRenameName] = useState("")

  // Export prototype state
  const [showExportDialog, setShowExportDialog] = useState(false)
  const [exportName, setExportName] = useState("")
  const [exportDescription, setExportDescription] = useState("")
  const [exportAuthor, setExportAuthor] = useState("")
  const [exportVersion, setExportVersion] = useState("1.0.0")
  const [exportLoading, setExportLoading] = useState(false)
  const [exportError, setExportError] = useState("")

  const instId = activeInstance?.id

  // 当前文件是否为 Markdown（决定是否显示预览切换）
  const isMarkdown = !!selectedFile?.endsWith(".md")

  // 进入 workspace 时按视口设置默认模式：移动端默认游玩，宽屏默认后台。
  // 用 ref 仅在首次挂载（进入）时生效，不随用户后续切换或窗口 resize 覆盖。
  const defaultModeAppliedRef = useRef(false)
  if (!defaultModeAppliedRef.current) {
    defaultModeAppliedRef.current = true
    useViewModeStore.getState().setMode(isMobile ? "play" : "backstage")
  }

  // 沙盒唤起导演栏：移动端切到全屏导演面板，桌面端展开折叠的 ChatPanel。
  const openDirector = useCallback(() => {
    if (isMobile) setFullscreenPanel("director")
    else setChatCollapsed(false)
  }, [isMobile])

  // Git state — file statuses for tree coloring from unified store
  const fileStatuses = useGitStore((s) => s.fileStatuses)

  // Redirect if no active instance
  useEffect(() => {
    if (!activeInstance) {
      navigate("/", { replace: true })
    }
  }, [activeInstance, navigate])

  // Load file tree
  const loadFileTree = useCallback(async (showSpinner = false) => {
    if (!instId) return
    if (showSpinner) setIsLoading(true)
    const res = await instancesApi.listFiles(instId)
    if (res.ok) {
      setFileTree(res.data || [])
    }
    if (showSpinner) setIsLoading(false)
  }, [instId])

  useEffect(() => {
    loadFileTree(initialLoadRef.current)
    if (initialLoadRef.current) initialLoadRef.current = false
    if (instId) {
      useGitStore.getState().fetchGitStatus(instId)
    }
  }, [loadFileTree])

  // Diff content from git HEAD (null = new file → treat as empty for diff)
  const [gitHeadContent, setGitHeadContent] = useState<string | null>(null)

  // File content is loaded by `openFile` (load-first + key remount). Reset the
  // editor state whenever the instance changes.
  useEffect(() => {
    setSelectedFile(null)
    setFileContent("")
    setEditedContent("")
    setGitHeadContent("")
    setIsDirty(false)
    setEditorView("code")
  }, [instId])

  // Ctrl+S to save
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault()
        if (isDirty && selectedFile !== null) {
          handleSave()
        }
      }
    }
    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [isDirty, selectedFile, editedContent, instId])

  const handleSave = async () => {
    if (!instId || selectedFile === null) return
    setIsSaving(true)
    const res = await instancesApi.writeFile(instId, selectedFile, editedContent)
    if (res.ok) {
      setFileContent(editedContent)
      setIsDirty(false)
      if (instId) useGitStore.getState().fetchGitStatus(instId)
      showSaveToast()
    }
    setIsSaving(false)
  }

  const handleCreateEntry = async () => {
    if (!instId || !showCreate || !createName.trim()) return
    const fullPath = showCreate.parentPath
      ? `${showCreate.parentPath}/${createName.trim()}`
      : createName.trim()
    await instancesApi.createEntry(instId, fullPath, showCreate.type)
    setShowCreate(null)
    setCreateName("")
    await refresh()
  }

  const handleDeleteEntry = async (path: string) => {
    setDeleteTarget(path)
  }

  const confirmDelete = async () => {
    if (!instId || !deleteTarget) return
    const path = deleteTarget
    setDeleteTarget(null)
    await instancesApi.deleteEntry(instId, path)
    if (selectedFile === path || selectedFile?.startsWith(path + "/")) {
      setSelectedFile(null)
      setFileContent("")
      setEditedContent("")
      setIsDirty(false)
    }
    await refresh()
  }

  const handleRenameEntry = (path: string) => {
    setRenameTarget(path)
    setRenameName(path.split("/").pop() || "")
  }

  const confirmRename = async () => {
    if (!instId || !renameTarget) return
    const oldPath = renameTarget
    const newName = renameName.trim()
    setRenameTarget(null)
    setRenameName("")
    if (!newName || newName === oldPath.split("/").pop()) return
    const res = await instancesApi.renameEntry(instId, oldPath, newName)
    if (!res.ok) return
    // Remap the open file if it is the renamed entry or lives under a renamed directory
    if (selectedFile === oldPath || selectedFile?.startsWith(oldPath + "/")) {
      const parent = oldPath.includes("/") ? oldPath.slice(0, oldPath.lastIndexOf("/")) : ""
      const newPath = parent ? `${parent}/${newName}` : newName
      setSelectedFile(
        selectedFile === oldPath ? newPath : newPath + selectedFile!.slice(oldPath.length),
      )
    }
    await refresh()
  }

  const handleUploadClick = (parentPath: string) => {
    uploadPathRef.current = parentPath
    fileInputRef.current?.click()
  }

  const handleUploadChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = "" // 允许重复选择同一文件
    if (!instId || !file) return
    const dir = uploadPathRef.current
    const fullPath = dir ? `${dir}/${file.name}` : file.name
    const res = await instancesApi.uploadFile(instId, fullPath, file)
    if (!res.ok) return // 由 API 返回错误文案；此处静默（错误可在网络面板查看）
    await refresh()
  }

  const handleExport = async () => {
    if (!instId || !exportName.trim()) return
    setExportLoading(true)
    setExportError("")
    const res = await prototypesApi.create(
      instId, exportName.trim(), exportDescription.trim(),
      exportAuthor.trim(), exportVersion.trim() || "1.0.0",
    )
    if (res.ok) {
      setShowExportDialog(false)
      setExportName("")
      setExportDescription("")
      setExportAuthor("")
      setExportVersion("1.0.0")
      showSaveToast()
    } else {
      setExportError(res.error || "导出失败")
    }
    setExportLoading(false)
  }

  // Keep a ref for latest selectedFile so callbacks always have current value
  const selectedFileRef = useRef(selectedFile)
  selectedFileRef.current = selectedFile

  // Keep a ref for isDirty so SSE callback can check without depending on state
  const isDirtyRef = useRef(isDirty)
  isDirtyRef.current = isDirty

  // Keep refs for the loaded baseline + git HEAD so async reloads can compare
  // against current state without taking a dependency on them.
  const fileContentRef = useRef(fileContent)
  fileContentRef.current = fileContent
  const gitHeadContentRef = useRef(gitHeadContent)
  gitHeadContentRef.current = gitHeadContent

  // Load a file (content + git HEAD) then open it. Loads first so Monaco mounts
  // once with the correct defaultValue and a clean undo stack.
  const openFile = useCallback(async (path: string) => {
    if (!instId || path === selectedFileRef.current) return
    const seq = ++loadSeqRef.current
    const [fileRes, headRes] = await Promise.all([
      instancesApi.readText(instId, path),
      gitApi.showFile(instId, path),
    ])
    if (seq !== loadSeqRef.current) return // stale response
    if (!fileRes.ok) return // file gone; keep current selection
    setFileContent(fileRes.data!.content)
    setEditedContent(fileRes.data!.content)
    setGitHeadContent(headRes.ok && headRes.data?.content != null ? headRes.data.content : "")
    setIsDirty(false)
    setEditorView("code")
    setSelectedFile(path)
  }, [instId])

  // Reload the open file from disk (external change). Remounts only when content
  // or git HEAD actually changed, so unrelated git commits don't reset the editor.
  const reloadOpenFile = useCallback(async () => {
    if (!instId) return
    const path = selectedFileRef.current
    if (!path) return
    const seq = ++loadSeqRef.current
    const [fileRes, headRes] = await Promise.all([
      instancesApi.readText(instId, path),
      gitApi.showFile(instId, path),
    ])
    if (seq !== loadSeqRef.current) return
    if (!fileRes.ok) {
      setSelectedFile(null)
      setFileContent("")
      setEditedContent("")
      setGitHeadContent("")
      setIsDirty(false)
      return
    }
    const content = fileRes.data!.content
    const head = headRes.ok && headRes.data?.content != null ? headRes.data.content : ""
    if (content === fileContentRef.current && head === gitHeadContentRef.current) return
    setFileContent(content)
    setEditedContent(content)
    setGitHeadContent(head)
    setIsDirty(false)
    setEditorEpoch((e) => e + 1)
  }, [instId])

  // Unified refresh hook
  const refresh = useWorkspaceRefresh({ instId, loadFileTree })

  // SSE-driven refresh — backend broadcasts file_changed / workspace_changed events
  useSSERefresh({
    instanceId: instId,
    instanceName: activeInstance?.name,
    onFileChanged: (path: string) => {
      if (!path) {
        // empty path means the changed file is the currently open one
        // AND it's dirty — just refresh tree + git, skip editor
        refresh()
        return
      }
      const currentFile = selectedFileRef.current
      if (currentFile && path === currentFile && isDirtyRef.current) {
        // Dirty file was modified externally — refresh tree + git but
        // preserve user's unsaved edits in the editor.
        refresh()
        return
      }
      refresh()
      if (currentFile && path === currentFile) {
        reloadOpenFile()
      }
    },
    onWorkspaceChanged: () => {
      // Full refresh: tree + git status, then reload the open file if it isn't
      // dirty (external commit / branch switch). Dirty edits are preserved.
      refresh()
      if (selectedFileRef.current && !isDirtyRef.current) {
        reloadOpenFile()
      }
    },

    // Periodic backstop: backend broadcasts that don't exist (e.g. Generate
    // dump_payload) never fire file_changed, so poll the tree every 5s and only
    // apply when it actually changed. Keeps the tree fresh without spraying
    // git/editor refreshes on an idle workspace. The dirty-check lives in the
    // hook; onPollTick receives the already-fetched tree, so no double fetch.
    pollIntervalMs: 5000,
    onPollFetch: async () => {
      const res = await instancesApi.listFiles(instId!)
      return res.ok ? (res.data ?? []) : []
    },
    onPollTick: (tree: FileTreeNode[]) => {
      setFileTree(tree)
      if (instId) useGitStore.getState().fetchGitStatus(instId)
    },
  })

  const toggleExpand = (path: string) => {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  // Chat panel resize via drag
  const [isDragging, setIsDragging] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  const handleDragStart = useCallback((e: React.PointerEvent) => {
    e.preventDefault()
    setIsDragging(true)
  }, [])

  useEffect(() => {
    if (!isDragging) return
    const handlePointerMove = (e: PointerEvent) => {
      if (!containerRef.current) return
      const rect = containerRef.current.getBoundingClientRect()
      const newWidthPx = rect.right - e.clientX
      const newWidthPct = (newWidthPx / rect.width) * 100
      setChatWidth(Math.min(Math.max(newWidthPct, 20), 60))
    }
    const handlePointerUp = () => setIsDragging(false)
    window.addEventListener("pointermove", handlePointerMove)
    window.addEventListener("pointerup", handlePointerUp)
    return () => {
      window.removeEventListener("pointermove", handlePointerMove)
      window.removeEventListener("pointerup", handlePointerUp)
    }
  }, [isDragging, setChatWidth])

  if (!activeInstance) return null

  // ============================================================================
  // Mobile layout
  // ============================================================================
  if (isMobile) {
    return (
      <div className="h-full flex flex-col overflow-hidden bg-background">
        {/* Fullscreen panels */}
        {fullscreenPanel === "director" && (
          <div className="absolute inset-0 z-50 bg-background flex flex-col">
            <div className="flex-1 flex flex-col min-h-0">
              <ChatPanel
                onGitRefresh={() => refresh()}
                onClosePanel={() => setFullscreenPanel(null)}
              />
            </div>
          </div>
        )}

        {fullscreenPanel === "git" && (
          <GitDialog
            instanceId={instId!}
            open={true}
            onClose={() => setFullscreenPanel(null)}
            onRefresh={() => { refresh(); setFullscreenPanel(null) }}
          />
        )}

        {/* Main content area */}
        <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
          {mode === "play" ? (
            <OutputPanel instanceId={instId} instanceName={activeInstance?.name} onSend={(msg) => useSessionStore.getState().setPendingMessage(msg)} onOpenDirector={openDirector} />
          ) : (
            /* Backstage mode — textarea editor */
            <div className="flex-1 flex flex-col min-h-0">
              {/* 顶部栏始终显示：文件树按钮 + 文件名 + 保存 */}
              <div className="flex items-center gap-2 px-2 h-14 border-b border-border shrink-0">
                <button
                  className="p-1 rounded hover:bg-muted shrink-0"
                  onClick={() => setShowFileTree(true)}
                  title="文件树"
                >
                  <FolderTree className="h-5 w-5" />
                </button>
                <span className="flex-1 text-sm text-muted-foreground truncate">
                  {selectedFile ?? "未选择文件"}
                </span>
                {selectedFile && (
                  <div className="flex items-center gap-2 shrink-0">
                    {isDirty && <span className="text-xs text-orange-500">未保存</span>}
                    {isMarkdown && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setEditorView((v) => (v === "code" ? "preview" : "code"))}
                        className="gap-1"
                        title={editorView === "code" ? "预览 Markdown" : "返回代码编辑"}
                      >
                        {editorView === "code" ? <Eye className="h-3 w-3" /> : <Code2 className="h-3 w-3" />}
                        {editorView === "code" ? "预览" : "代码"}
                      </Button>
                    )}
                    <Button size="sm" variant="outline" onClick={handleSave} disabled={!isDirty || isSaving} className="gap-1">
                      {isSaving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
                      保存
                    </Button>
                  </div>
                )}
              </div>
              {selectedFile ? (
                isMarkdown && editorView === "preview" ? (
                  <div className="flex-1 overflow-auto">
                    <MarkdownRenderer content={editedContent} />
                  </div>
                ) : (
                  <textarea
                    className="flex-1 w-full resize-none bg-background text-foreground p-4 font-mono text-sm outline-none border-0"
                    value={editedContent}
                    onChange={(e) => { setEditedContent(e.target.value); setIsDirty(e.target.value !== fileContent) }}
                    spellCheck={false}
                  />
                )
              ) : (
                <div className="flex-1 flex items-center justify-center text-muted-foreground">
                  <div className="text-center">
                    <File className="h-12 w-12 mx-auto mb-3 opacity-20" />
                    <p className="text-sm">点击左上角文件按钮选择文件</p>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* File tree overlay (half-screen) — only in backstage mode */}
        {showFileTree && (
          <>
            <div className="fixed inset-0 bg-black/40 z-40" onClick={() => setShowFileTree(false)} />
            <div className="fixed left-0 top-0 bottom-0 w-[75%] max-w-[320px] z-50 bg-background border-r border-border flex flex-col shadow-lg">
              <div className="p-3 border-b border-border flex items-center justify-between shrink-0">
                <span className="text-sm font-semibold truncate" title={activeInstance.name}>
                  {activeInstance.name}
                </span>
                <div className="flex items-center gap-1 shrink-0">
                  <button className="p-1.5 rounded hover:bg-muted" onClick={() => handleUploadClick("")} title="上传文件到根目录">
                    <Upload className="h-4 w-4" />
                  </button>
                  <button className="p-1.5 rounded hover:bg-muted" onClick={() => setShowFileTree(false)}>
                    <X className="h-4 w-4" />
                  </button>
                </div>
              </div>
              <div className="flex-1 overflow-auto py-1">
                {isLoading ? (
                  <div className="flex items-center justify-center py-8">
                    <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                  </div>
                ) : (
                  <FileTreeView
                    nodes={fileTree}
                    expanded={expanded}
                    selectedFile={selectedFile}
                    onToggle={toggleExpand}
                    onSelect={(path) => {
                      setShowFileTree(false)
                      openFile(path)
                    }}
                    onCreateFile={(parentPath) => { setShowCreate({ parentPath, type: "file" }); setCreateName("") }}
                    onCreateFolder={(parentPath) => { setShowCreate({ parentPath, type: "directory" }); setCreateName("") }}
                    onDelete={handleDeleteEntry}
                    onRename={handleRenameEntry}
                    onUpload={handleUploadClick}
                    fileStatuses={fileStatuses}
                    isMobile
                  />
                )}
              </div>
            </div>
          </>
        )}

        {/* Floating balls + bottom bar */}
        {/* Top-right: menu trigger */}
        {!fullscreenPanel && (
          <div className="fixed top-3 right-3 z-30">
            <button
              className="px-3 py-2 rounded-full bg-primary text-primary-foreground shadow-lg flex items-center gap-1.5 text-xs font-medium active:scale-95 transition-transform"
              onClick={() => setShowMobileMenu(!showMobileMenu)}
            >
              {mode === "play" ? <Gamepad2 className="h-3.5 w-3.5" /> : <Wrench className="h-3.5 w-3.5" />}
              {mode === "backstage" && <span>后台</span>}
              <Menu className="h-3.5 w-3.5" />
            </button>

            {showMobileMenu && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setShowMobileMenu(false)} />
                <div className="absolute right-0 top-full mt-1 z-50 bg-background border border-border rounded-md shadow-lg py-1 min-w-[160px]">
                  <div className="flex items-center justify-between px-3 py-2">
                    <span className="text-sm">游玩模式</span>
                    <Switch
                      checked={mode === "backstage"}
                      onCheckedChange={(v) => {
                        useViewModeStore.getState().setMode(v ? "backstage" : "play")
                        setShowMobileMenu(false)
                      }}
                    />
                  </div>
                  <div className="border-t border-border" />
                  <button
                    className="w-full flex items-center gap-2 px-3 py-2.5 text-sm hover:bg-muted"
                    onClick={() => { setFullscreenPanel("git"); setShowMobileMenu(false) }}
                  >
                    <GitBranch className="h-4 w-4" />
                    版本控制
                  </button>
                  <button
                    className="w-full flex items-center gap-2 px-3 py-2.5 text-sm hover:bg-muted"
                    onClick={() => { openSettings(); setShowMobileMenu(false) }}
                  >
                    <Settings className="h-4 w-4" />
                    设置
                  </button>
                  <button
                    className="w-full flex items-center gap-2 px-3 py-2.5 text-sm hover:bg-muted"
                    onClick={() => { handleToggleTheme(); setShowMobileMenu(false) }}
                  >
                    {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
                    主题切换
                  </button>
                  <div className="border-t border-border" />
                  <button
                    className="w-full flex items-center gap-2 px-3 py-2.5 text-sm hover:bg-muted"
                    onClick={() => {
                      setActiveInstance(null)
                      navigate("/", { replace: true })
                    }}
                  >
                    <ArrowLeft className="h-4 w-4" />
                    退出到主页
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        {/* Bottom-left: director trigger */}
        {!fullscreenPanel && (
          <div className="fixed bottom-6 left-3 z-30">
            <button
              className="w-12 h-12 rounded-full bg-secondary text-secondary-foreground shadow-lg flex items-center justify-center active:scale-95 transition-transform border border-border"
              onClick={() => setFullscreenPanel("director")}
            >
              <MessageCircle className="h-6 w-6" />
            </button>
          </div>
        )}

        {/* Create Dialog */}
        {showCreate && (
          <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={() => setShowCreate(null)}>
            <div className="bg-background rounded-lg shadow-lg w-full max-w-sm mx-4 p-6 space-y-4" onClick={e => e.stopPropagation()}>
              <h3 className="font-semibold">新建{showCreate.type === "directory" ? "文件夹" : "文件"}</h3>
              <div>
                {showCreate.parentPath && (
                  <p className="text-xs text-muted-foreground mb-2">位置：{showCreate.parentPath || "/"}</p>
                )}
                <Input
                  value={createName}
                  onChange={e => setCreateName(e.target.value)}
                  placeholder={showCreate.type === "directory" ? "文件夹名称" : "文件名"}
                  autoFocus
                  onKeyDown={e => { if (e.key === "Enter") handleCreateEntry() }}
                />
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="outline" size="sm" onClick={() => setShowCreate(null)}>取消</Button>
                <Button size="sm" onClick={handleCreateEntry} disabled={!createName.trim()}>创建</Button>
              </div>
            </div>
          </div>
        )}

        {/* Rename dialog */}
        {renameTarget && (
          <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={() => { setRenameTarget(null); setRenameName("") }}>
            <div className="bg-background rounded-lg shadow-lg w-full max-w-sm mx-4 p-6 space-y-4" onClick={e => e.stopPropagation()}>
              <h3 className="font-semibold">重命名</h3>
              <div>
                <p className="text-xs text-muted-foreground mb-2">位置：{renameTarget.includes("/") ? renameTarget.slice(0, renameTarget.lastIndexOf("/")) || "/" : "/"}</p>
                <Input
                  value={renameName}
                  onChange={e => setRenameName(e.target.value)}
                  placeholder="新名称"
                  autoFocus
                  onKeyDown={e => { if (e.key === "Enter") confirmRename() }}
                />
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="outline" size="sm" onClick={() => { setRenameTarget(null); setRenameName("") }}>取消</Button>
                <Button size="sm" onClick={confirmRename} disabled={!renameName.trim()}>确定</Button>
              </div>
            </div>
          </div>
        )}

        {/* Confirm delete dialog */}
        <ConfirmDialog
          open={deleteTarget !== null}
          title="确认删除"
          message={`确定删除 "${deleteTarget}" 吗？此操作不可撤销。`}
          variant="destructive"
          confirmText="删除"
          onConfirm={confirmDelete}
          onCancel={() => setDeleteTarget(null)}
        />

        {/* Export prototype dialog */}
        {showExportDialog && (
          <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={() => setShowExportDialog(false)}>
            <div className="bg-background rounded-lg shadow-lg w-full max-w-sm mx-4 p-6 space-y-4" onClick={e => e.stopPropagation()}>
              <h3 className="font-semibold">导出为原型</h3>
              <p className="text-xs text-muted-foreground">
                将当前实例打包为可复用的原型（排除 <code className="bg-muted px-1 rounded">building/</code> 等内部目录）。请先在实例上清理测试数据（楼层、变量、泛化 teahouse.md），再导出。
              </p>
              <div className="space-y-1">
                <label className="text-sm font-medium">原型名称</label>
                <Input
                  value={exportName}
                  onChange={e => { setExportName(e.target.value); setExportError("") }}
                  placeholder="为原型起个名字"
                  autoFocus
                />
              </div>
              <div className="space-y-1">
                <label className="text-sm font-medium">简介 <span className="text-muted-foreground font-normal">(最多50字)</span></label>
                <Input
                  value={exportDescription}
                  onChange={e => setExportDescription(e.target.value)}
                  placeholder="简要描述，用于原型列表展示"
                  maxLength={50}
                />
              </div>
              <div className="flex gap-3">
                <div className="space-y-1 flex-1">
                  <label className="text-sm font-medium">作者 <span className="text-muted-foreground font-normal">(可选)</span></label>
                  <Input
                    value={exportAuthor}
                    onChange={e => setExportAuthor(e.target.value)}
                    placeholder="作者名"
                  />
                </div>
                <div className="space-y-1 w-24">
                  <label className="text-sm font-medium">版本</label>
                  <Input
                    value={exportVersion}
                    onChange={e => setExportVersion(e.target.value)}
                    placeholder="1.0.0"
                  />
                </div>
              </div>
              {exportError && <p className="text-sm text-red-500">{exportError}</p>}
              <div className="flex justify-end gap-2">
                <Button variant="outline" size="sm" onClick={() => setShowExportDialog(false)}>取消</Button>
                <Button size="sm" onClick={handleExport} disabled={!exportName.trim() || exportLoading}>
                  {exportLoading && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}
                  导出
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>
    )
  }

  // ============================================================================
  // Desktop layout
  // ============================================================================
  return (
    <div ref={containerRef} className="h-full flex overflow-hidden">
      <input
        ref={fileInputRef}
        type="file"
        className="hidden"
        onChange={handleUploadChange}
      />
      {/* Left/center area — file tree + editor (backstage) OR output panel (play).
          Both are always mounted to keep SSE connections alive; hidden via CSS. */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Backstage — file tree + editor */}
        <div className={`flex-1 flex overflow-hidden ${mode === "backstage" ? "" : "hidden"}`}>
          {/* File tree sidebar */}
          <aside className="w-64 border-r border-border shrink-0 flex flex-col bg-muted/20">
            <div className="p-3 border-b border-border flex items-center justify-between">
              <span className="text-sm font-semibold truncate" title={activeInstance.name}>
                {activeInstance.name}
              </span>
              <div className="flex items-center gap-0.5 shrink-0">
                <button
                  className="p-0.5 rounded hover:bg-muted cursor-pointer"
                  onClick={() => { setShowExportDialog(true); setExportName(""); setExportDescription(""); setExportAuthor(""); setExportVersion("1.0.0"); setExportError("") }}
                  title="导出为原型"
                >
                  <Archive className="h-3.5 w-3.5" />
                </button>
                <button
                  className="p-0.5 rounded hover:bg-muted cursor-pointer"
                  onClick={() => { setShowCreate({ parentPath: "", type: "file" }); setCreateName("") }}
                  title="新建文件"
                >
                  <Plus className="h-3.5 w-3.5" />
                </button>
                <button
                  className="p-0.5 rounded hover:bg-muted cursor-pointer"
                  onClick={() => { setShowCreate({ parentPath: "", type: "directory" }); setCreateName("") }}
                  title="新建文件夹"
                >
                  <Folder className="h-3.5 w-3.5" />
                </button>
                <button
                  className="p-0.5 rounded hover:bg-muted cursor-pointer"
                  onClick={() => handleUploadClick("")}
                  title="上传文件到根目录"
                >
                  <Upload className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-auto py-1">
              {isLoading ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                </div>
              ) : (
                <FileTreeView
                  nodes={fileTree}
                  expanded={expanded}
                  selectedFile={selectedFile}
                  onToggle={toggleExpand}
                  onSelect={(path) => {
                    openFile(path)
                  }}
                  onCreateFile={(parentPath) => { setShowCreate({ parentPath, type: "file" }); setCreateName("") }}
                  onCreateFolder={(parentPath) => { setShowCreate({ parentPath, type: "directory" }); setCreateName("") }}
                  onDelete={handleDeleteEntry}
                  onRename={handleRenameEntry}
                  onUpload={handleUploadClick}
                  fileStatuses={fileStatuses}
                />
              )}
            </div>

          </aside>

          {/* Middle panel — Editor */}
          <div className="flex-1 flex flex-col bg-background min-w-0">
            {selectedFile ? (
              <>
                <div className="flex items-center justify-between px-3 py-2 border-b border-border shrink-0">
                  <span className="text-sm text-muted-foreground truncate">{selectedFile}</span>
                  <div className="flex items-center gap-2 shrink-0">
                    {isDirty && !saveToast && <span className="text-xs text-orange-500">未保存</span>}
                    {saveToast && <span ref={saveToastRef} className="text-xs text-green-500">已保存到磁盘</span>}
                    {isMarkdown && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setEditorView((v) => (v === "code" ? "preview" : "code"))}
                        className="gap-1"
                        title={editorView === "code" ? "预览 Markdown" : "返回代码编辑"}
                      >
                        {editorView === "code" ? <Eye className="h-3 w-3" /> : <Code2 className="h-3 w-3" />}
                        {editorView === "code" ? "预览" : "代码"}
                      </Button>
                    )}
                    <Button size="sm" variant="outline" onClick={handleSave} disabled={!isDirty || isSaving} className="gap-1">
                      {isSaving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
                      保存
                    </Button>
                  </div>
                </div>
                <div className="flex-1 w-full overflow-hidden">
                  {/* 代码编辑器常驻挂载，预览时用 CSS 隐藏以保留撤销栈与光标 */}
                  <div className={editorView === "code" ? "h-full" : "hidden"}>
                    <MonacoEditor
                      key={`${selectedFile}#${editorEpoch}`}
                      path={selectedFile}
                      defaultValue={fileContent}
                      original={gitHeadContent ?? ""}
                      onSave={handleSave}
                      onChange={(val) => { setEditedContent(val); setIsDirty(val !== fileContent) }}
                      language={
                        selectedFile?.endsWith(".md") ? "markdown" :
                        selectedFile?.endsWith(".ts") || selectedFile?.endsWith(".tsx") ? "typescript" :
                        selectedFile?.endsWith(".js") ? "javascript" :
                        selectedFile?.endsWith(".py") ? "python" :
                        selectedFile?.endsWith(".yaml") || selectedFile?.endsWith(".yml") ? "yaml" :
                        selectedFile?.endsWith(".json") ? "json" :
                        selectedFile?.endsWith(".css") ? "css" :
                        selectedFile?.endsWith(".html") ? "html" :
                        selectedFile?.endsWith(".sh") || selectedFile?.endsWith(".bash") ? "shell" :
                        "plaintext"
                      }
                    />
                  </div>
                  {isMarkdown && (
                    <div className={`h-full overflow-auto ${editorView === "preview" ? "" : "hidden"}`}>
                      <MarkdownRenderer content={editedContent} />
                    </div>
                  )}
                </div>
              </>
            ) : (
              <div className="flex-1 flex items-center justify-center text-muted-foreground">
                <div className="text-center">
                  <File className="h-12 w-12 mx-auto mb-3 opacity-20" />
                  <p className="text-sm">从左侧选择文件进行编辑</p>
                  <p className="text-xs mt-1 opacity-60">Ctrl+S 保存</p>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Play mode — Output panel (always mounted, hidden when backstage) */}
        <div className={`flex-1 flex-col min-w-0 ${mode === "play" ? "flex" : "hidden"}`}>
          <OutputPanel instanceId={instId} instanceName={activeInstance?.name} onSend={(msg) => useSessionStore.getState().setPendingMessage(msg)} onOpenDirector={openDirector} />
        </div>
      </div>

      {/* Drag handle + Chat panel (resizable, collapsible) */}
      {!chatCollapsed && (
        <>
          {/* Drag handle */}
          <div
            className={`w-1.5 border-l border-border shrink-0 cursor-col-resize hover:bg-primary/30 transition-colors relative group ${
              isDragging ? "bg-primary/50" : ""
            }`}
            onPointerDown={handleDragStart}
            style={{ touchAction: "none" }}
          >
            <GripVertical className="h-4 w-4 absolute top-1/2 -translate-y-1/2 -left-[7px] text-muted-foreground/40 group-hover:text-muted-foreground pointer-events-none" />
          </div>
          {/* Chat panel */}
          <aside
            className="border-l border-border flex flex-col bg-muted/10 min-w-0 shrink-0"
            style={{ width: `${chatWidth}%` }}
          >
            <div className="flex-1 flex flex-col min-h-0">
              <ChatPanel
                onGitRefresh={() => refresh()}
                onClosePanel={() => setChatCollapsed(true)}
              />
            </div>
          </aside>
        </>
      )}

      {/* Expand button when collapsed */}
      {chatCollapsed && (
        <div className="border-l border-border shrink-0 flex flex-col items-center pt-2 bg-muted/5">
          <button
            className="p-1 rounded hover:bg-muted text-muted-foreground"
            onClick={() => setChatCollapsed(false)}
            title="展开导演面板"
          >
            <PanelLeftOpen className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* Create Dialog */}
      {showCreate && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={() => setShowCreate(null)}>
          <div className="bg-background rounded-lg shadow-lg w-full max-w-sm mx-4 p-6 space-y-4" onClick={e => e.stopPropagation()}>
            <h3 className="font-semibold">新建{showCreate.type === "directory" ? "文件夹" : "文件"}</h3>
            <div>
              {showCreate.parentPath && (
                <p className="text-xs text-muted-foreground mb-2">位置：{showCreate.parentPath || "/"}</p>
              )}
              <Input
                value={createName}
                onChange={e => setCreateName(e.target.value)}
                placeholder={showCreate.type === "directory" ? "文件夹名称" : "文件名"}
                autoFocus
                onKeyDown={e => { if (e.key === "Enter") handleCreateEntry() }}
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setShowCreate(null)}>取消</Button>
              <Button size="sm" onClick={handleCreateEntry} disabled={!createName.trim()}>创建</Button>
            </div>
          </div>
        </div>
      )}

      {/* Rename dialog */}
      {renameTarget && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={() => { setRenameTarget(null); setRenameName("") }}>
          <div className="bg-background rounded-lg shadow-lg w-full max-w-sm mx-4 p-6 space-y-4" onClick={e => e.stopPropagation()}>
            <h3 className="font-semibold">重命名</h3>
            <div>
              <p className="text-xs text-muted-foreground mb-2">位置：{renameTarget.includes("/") ? renameTarget.slice(0, renameTarget.lastIndexOf("/")) || "/" : "/"}</p>
              <Input
                value={renameName}
                onChange={e => setRenameName(e.target.value)}
                placeholder="新名称"
                autoFocus
                onKeyDown={e => { if (e.key === "Enter") confirmRename() }}
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => { setRenameTarget(null); setRenameName("") }}>取消</Button>
              <Button size="sm" onClick={confirmRename} disabled={!renameName.trim()}>确定</Button>
            </div>
          </div>
        </div>
      )}

      {/* Confirm delete dialog */}
      <ConfirmDialog
        open={deleteTarget !== null}
        title="确认删除"
        message={`确定删除 "${deleteTarget}" 吗？此操作不可撤销。`}
        variant="destructive"
        confirmText="删除"
        onConfirm={confirmDelete}
        onCancel={() => setDeleteTarget(null)}
      />

      {/* Export prototype dialog */}
      {showExportDialog && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={() => setShowExportDialog(false)}>
          <div className="bg-background rounded-lg shadow-lg w-full max-w-sm mx-4 p-6 space-y-4" onClick={e => e.stopPropagation()}>
            <h3 className="font-semibold">导出为原型</h3>
            <p className="text-xs text-muted-foreground">
              将当前实例打包为可复用的原型（排除 <code className="bg-muted px-1 rounded">building/</code> 等内部目录）。请先在实例上清理测试数据（楼层、变量、泛化 teahouse.md），再导出。
            </p>
            <div className="space-y-1">
              <label className="text-sm font-medium">原型名称</label>
              <Input
                value={exportName}
                onChange={e => { setExportName(e.target.value); setExportError("") }}
                placeholder="为原型起个名字"
                autoFocus
              />
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium">简介 <span className="text-muted-foreground font-normal">(最多50字)</span></label>
              <Input
                value={exportDescription}
                onChange={e => setExportDescription(e.target.value)}
                placeholder="简要描述，用于原型列表展示"
                maxLength={50}
              />
            </div>
            <div className="flex gap-3">
              <div className="space-y-1 flex-1">
                <label className="text-sm font-medium">作者 <span className="text-muted-foreground font-normal">(可选)</span></label>
                <Input
                  value={exportAuthor}
                  onChange={e => setExportAuthor(e.target.value)}
                  placeholder="作者名"
                />
              </div>
              <div className="space-y-1 w-24">
                <label className="text-sm font-medium">版本</label>
                <Input
                  value={exportVersion}
                  onChange={e => setExportVersion(e.target.value)}
                  placeholder="1.0.0"
                />
              </div>
            </div>
            {exportError && <p className="text-sm text-red-500">{exportError}</p>}
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setShowExportDialog(false)}>取消</Button>
              <Button size="sm" onClick={handleExport} disabled={!exportName.trim() || exportLoading}>
                {exportLoading && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}
                导出
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Drag overlay — prevents iframe from capturing mouse during panel resize */}
      {isDragging && (
        <div
          className="fixed inset-0 z-50 cursor-col-resize"
          style={{ userSelect: "none" } as React.CSSProperties}
        />
      )}
    </div>
  )
}

// ---- File tree recursive component ----

function FileTreeView({
  nodes, expanded, selectedFile, onToggle, onSelect,
  onCreateFile, onCreateFolder, onDelete, onRename, onUpload, fileStatuses, depth = 0, isMobile = false,
}: {
  nodes: FileTreeNode[]
  expanded: Set<string>
  selectedFile: string | null
  onToggle: (path: string) => void
  onSelect: (path: string) => void
  onCreateFile: (parentPath: string) => void
  onCreateFolder: (parentPath: string) => void
  onDelete: (path: string) => void
  onRename: (path: string) => void
  onUpload: (parentPath: string) => void
  fileStatuses: Map<string, string>
  depth?: number
  isMobile?: boolean
}) {
  const stColor = (st: string | undefined) => {
    if (!st) return "text-muted-foreground"
    const m: Record<string, string> = {
      "M": "text-amber-600 dark:text-amber-400",
      "A": "text-green-600 dark:text-green-400",
      "?": "text-green-600 dark:text-green-400",
      "D": "text-red-600 dark:text-red-400",
      "R": "text-purple-600 dark:text-purple-400",
    }
    return m[st] || "text-muted-foreground"
  }

  return (
    <>
      {nodes
        .filter(n => n.name !== ".git")
        .map((node) => (
        <div key={node.path}>
          <div
            className={`flex items-center gap-1 px-2 cursor-pointer hover:bg-muted/50 transition-colors group ${
              isMobile ? "py-3" : "py-1"
            } ${
              selectedFile === node.path ? "bg-accent" : ""
            }`}
            style={{ paddingLeft: `${8 + depth * 16}px` }}
            onClick={() => {
              if (node.type === "directory") {
                onToggle(node.path)
              } else {
                onSelect(node.path)
              }
            }}
          >
            {node.type === "directory" ? (
              <>
                <span className="shrink-0">
                  {expanded.has(node.path) ? (
                    <ChevronDown className="h-3 w-3" />
                  ) : (
                    <ChevronRight className="h-3 w-3" />
                  )}
                </span>
                {(() => {
                  const Icon = expanded.has(node.path) ? FolderOpen : Folder
                  return <Icon className={`h-4 w-4 shrink-0 ${stColor(fileStatuses.get(node.path))}`} />
                })()}
              </>
            ) : (
              <>
                <span className="w-3 shrink-0" />
                <FileText className={`h-4 w-4 shrink-0 ${stColor(fileStatuses.get(node.path))}`} />
              </>
            )}
            <span className={`flex-1 truncate text-sm ${stColor(fileStatuses.get(node.path))}`}>{node.name}</span>

            {/* Action buttons — visible on hover */}
            <div className="hidden group-hover:flex items-center gap-0.5 shrink-0">
              {node.type === "directory" && (
                <>
                  <button
                    className="p-0.5 rounded hover:bg-muted cursor-pointer"
                    onClick={e => { e.stopPropagation(); onCreateFile(node.path) }}
                    title="新建文件"
                  >
                    <Plus className="h-3 w-3" />
                  </button>
                  <button
                    className="p-0.5 rounded hover:bg-muted cursor-pointer"
                    onClick={e => { e.stopPropagation(); onCreateFolder(node.path) }}
                    title="新建文件夹"
                  >
                    <Folder className="h-3 w-3" />
                  </button>
                  <button
                    className="p-0.5 rounded hover:bg-muted cursor-pointer"
                    onClick={e => { e.stopPropagation(); onUpload(node.path) }}
                    title="上传文件到此处"
                  >
                    <Upload className="h-3 w-3" />
                  </button>
                </>
              )}
              <button
                className="p-0.5 rounded hover:bg-muted cursor-pointer"
                onClick={e => { e.stopPropagation(); onRename(node.path) }}
                title="重命名"
              >
                <Pencil className="h-3 w-3" />
              </button>
              <button
                className="p-0.5 rounded hover:bg-muted text-muted-foreground hover:text-red-500 cursor-pointer"
                onClick={e => { e.stopPropagation(); onDelete(node.path) }}
                title="删除"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </div>
          </div>

          {/* Children */}
          {node.type === "directory" && expanded.has(node.path) && node.children && (
            <FileTreeView
              nodes={node.children}
              expanded={expanded}
              selectedFile={selectedFile}
              onToggle={onToggle}
              onSelect={onSelect}
              onCreateFile={onCreateFile}
              onCreateFolder={onCreateFolder}
              onDelete={onDelete}
              onRename={onRename}
              onUpload={onUpload}
              fileStatuses={fileStatuses}
              depth={depth + 1}
              isMobile={isMobile}
            />
            )}
          </div>
        ))}
    </>
  )
}

