import { useEffect, useState, useCallback, useRef } from "react"
import { useNavigate, useOutletContext } from "react-router-dom"
import { MonacoEditor } from "@/components/MonacoEditor"
import {
  File, Folder, FolderOpen, Plus, Trash2, Loader2,
  ChevronRight, ChevronDown, Save, FileText,
  Puzzle, PanelLeftOpen, GripVertical, Archive, RefreshCw,
  BookOpen, MessageCircle, FolderTree, Menu, X, Gamepad2, Wrench,
  GitBranch, Sun, Moon, LogOut, Settings, ArrowLeft, ChevronLeft,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { instancesApi, gitApi, prototypesApi } from "@/lib/api"
import { useSessionStore } from "@/stores/sessionStore"
import { useViewModeStore } from "@/stores/viewModeStore"
import { useGitStore } from "@/stores/gitStore"
import { useAuthActions } from "@/stores/authStore"
import { useSettingsDialogStore } from "@/stores/settingsDialogStore"
import { ChatPanel } from "@/components/ChatPanel"
import { OutputPanel } from "@/components/OutputPanel"
import { ConfirmDialog } from "@/components/ConfirmDialog"
import { GitDialog } from "@/components/GitDialog"
import { useWorkspaceRefresh } from "@/hooks/useWorkspaceRefresh"
import { useSSERefresh } from "@/hooks/useSSERefresh"
import { useIsMobile } from "@/hooks/useMediaQuery"
import type { FileTreeNode } from "@/lib/types"

// Monaco Editor theme follows system dark mode — handled by MonacoEditor component

export function WorkspacePage() {
  const navigate = useNavigate()
  const activeInstance = useSessionStore((s) => s.activeInstance)
  const setActiveInstance = useSessionStore((s) => s.setActiveInstance)
  const mode = useViewModeStore((s) => s.mode)
  const chatWidth = useViewModeStore((s) => s.chatWidth)
  const chatCollapsed = useViewModeStore((s) => s.chatCollapsed)
  const setChatWidth = useViewModeStore((s) => s.setChatWidth)
  const isMobile = useIsMobile()
  const { toggleTheme } = useOutletContext<{ isMobile: boolean; toggleTheme: () => void }>()
  const { clearAuth } = useAuthActions()

  // Mobile state
  const [showFileTree, setShowFileTree] = useState(false)
  const [showMobileMenu, setShowMobileMenu] = useState(false)
  const [fullscreenPanel, setFullscreenPanel] = useState<"director" | "settings" | "git" | null>(null)
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
  const [isLoading, setIsLoading] = useState(true)
  const initialLoadRef = useRef(true)
  const [isSaving, setIsSaving] = useState(false)
  const [saveToast, setSaveToast] = useState<boolean>(false)
  const saveToastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const saveToastRef = useRef<HTMLSpanElement | null>(null)

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
  const [contentReady, setContentReady] = useState(false)

  const [showCreate, setShowCreate] = useState<{ parentPath: string; type: "file" | "directory" } | null>(null)
  const [createName, setCreateName] = useState("")

  // Rename / delete — not yet implemented, but structure ready
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)

  // Export prototype state
  const [showExportDialog, setShowExportDialog] = useState(false)
  const [exportName, setExportName] = useState("")
  const [exportDescription, setExportDescription] = useState("")
  const [exportAuthor, setExportAuthor] = useState("")
  const [exportVersion, setExportVersion] = useState("1.0.0")
  const [exportLoading, setExportLoading] = useState(false)
  const [exportError, setExportError] = useState("")

  const instId = activeInstance?.id

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

  // Load file content when selected
  useEffect(() => {
    if (!instId || !selectedFile) {
      setFileContent("")
      setEditedContent("")
      setGitHeadContent("")
      setIsDirty(false)
      setContentReady(false)
      setSaveToast(null)
      return
    }
    ;(async () => {
      const [fileRes, headRes] = await Promise.all([
        instancesApi.readText(instId, selectedFile),
        gitApi.showFile(instId, selectedFile),
      ])
      if (fileRes.ok) {
        const diskContent = fileRes.data!.content
        setFileContent(diskContent)
        setEditedContent(diskContent)
        // git HEAD content: null if file doesn't exist in HEAD (new/untracked)
        const headContent = headRes.ok && headRes.data?.content != null ? headRes.data.content : ""
        setGitHeadContent(headContent)
        setIsDirty(false)
        setContentReady(true)
      } else {
        // File no longer exists — clear editor
        setSelectedFile(null)
        setFileContent("")
        setEditedContent("")
        setGitHeadContent("")
        setContentReady(false)
        setIsDirty(false)
      }
    })()
  }, [instId, selectedFile])

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
      refresh({ fileTree: false, gitStatus: true, editor: false, clearDirty: false })
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
    await refresh({ editor: false, clearDirty: false })
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
    await refresh({ editor: false, clearDirty: false })
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

  // Unified refresh hook
  const refresh = useWorkspaceRefresh({
    instId,
    selectedFileRef,
    loadFileTree,
    setFileContent,
    setEditedContent,
    setGitHeadContent,
    setIsDirty,
    setContentReady,
    setSelectedFile,
  })

  // SSE-driven refresh — backend broadcasts file_changed / workspace_changed events
  useSSERefresh({
    instanceId: instId,
    instanceName: activeInstance?.name,
    onFileChanged: (path: string) => {
      if (!path) {
        // empty path means the changed file is the currently open one
        // AND it's dirty — just refresh tree + git, skip editor
        refresh({ editor: false })
        return
      }
      const currentFile = selectedFileRef.current
      if (currentFile && path === currentFile && isDirtyRef.current) {
        // Dirty file was modified externally — refresh tree + git but
        // preserve user's unsaved edits in the editor.
        refresh({ editor: false })
        return
      }
      // Refresh tree + git, AND reload editor if this file is open
      refresh({ editor: false })
      if (currentFile && path === currentFile) {
        // Update editor content in-place without unmounting Monaco.
        instancesApi.readText(instId!, currentFile).then(fileRes => {
          if (fileRes.ok) {
            setFileContent(fileRes.data!.content)
            setEditedContent(fileRes.data!.content)
            setIsDirty(false)
            gitApi.showFile(instId!, currentFile).then(headRes => {
              if (headRes.ok) {
                setGitHeadContent(headRes.data?.content ?? "")
              }
            })
          } else {
            // File no longer exists — clear editor
            setSelectedFile(null)
            setFileContent("")
            setEditedContent("")
            setGitHeadContent("")
            setContentReady(false)
            setIsDirty(false)
          }
        })
      }
    },
    onWorkspaceChanged: () => {
      // Full refresh: tree + git status, then re-read editor content
      // in-place without unmounting Monaco (avoids "InstantiationService
      // has been disposed" when events arrive rapidly).
      refresh({ editor: false })
      const currentFile = selectedFileRef.current
      if (currentFile && instId) {
        instancesApi.readText(instId, currentFile).then(fileRes => {
          if (fileRes.ok) {
            setFileContent(fileRes.data!.content)
            setEditedContent(fileRes.data!.content)
            setIsDirty(false)
            gitApi.showFile(instId, currentFile).then(headRes => {
              if (headRes.ok) {
                setGitHeadContent(headRes.data?.content ?? "")
              }
            })
          } else {
            // File no longer exists — clear editor
            setSelectedFile(null)
            setFileContent("")
            setEditedContent("")
            setGitHeadContent("")
            setContentReady(false)
            setIsDirty(false)
          }
        })
      }
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
            <div className="h-10 border-b border-border flex items-center gap-2 px-2 shrink-0">
              <button className="p-1 rounded hover:bg-muted" onClick={() => setFullscreenPanel(null)}>
                <ChevronLeft className="h-5 w-5" />
              </button>
              <span className="font-semibold text-sm">导演</span>
            </div>
            <div className="flex-1 flex flex-col min-h-0">
              <ChatPanel onGitRefresh={() => refresh({ editor: false })} />
            </div>
          </div>
        )}

        {fullscreenPanel === "settings" && (
          <div className="absolute inset-0 z-50 bg-background flex flex-col">
            <div className="h-10 border-b border-border flex items-center gap-2 px-2 shrink-0">
              <button className="p-1 rounded hover:bg-muted" onClick={() => setFullscreenPanel(null)}>
                <ChevronLeft className="h-5 w-5" />
              </button>
              <span className="font-semibold text-sm">设置</span>
            </div>
            <div className="flex-1 overflow-auto p-4">
              {/* Inline settings content — simplified for mobile */}
              <MobileSettingsContent
                instId={instId!}
                activeInstance={activeInstance}
                onClose={() => setFullscreenPanel(null)}
              />
            </div>
          </div>
        )}

        {fullscreenPanel === "git" && (
          <div className="absolute inset-0 z-50 bg-background flex flex-col">
            <GitDialog
              instanceId={instId!}
              open={true}
              onClose={() => setFullscreenPanel(null)}
              onRefresh={() => { refresh({ editor: false }); setFullscreenPanel(null) }}
            />
          </div>
        )}

        {/* Main content area */}
        <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
          {mode === "play" ? (
            <OutputPanel instanceId={instId} instanceName={activeInstance?.name} onSend={(msg) => useSessionStore.getState().setPendingMessage(msg)} />
          ) : (
            /* Backstage mode — textarea editor */
            <div className="flex-1 flex flex-col min-h-0">
              {selectedFile ? (
                <>
                  <div className="flex items-center justify-between px-3 py-2 border-b border-border shrink-0">
                    <span className="text-sm text-muted-foreground truncate">{selectedFile}</span>
                    <div className="flex items-center gap-2 shrink-0">
                      {isDirty && <span className="text-xs text-orange-500">未保存</span>}
                      <Button size="sm" variant="outline" onClick={handleSave} disabled={!isDirty || isSaving} className="gap-1">
                        {isSaving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
                        保存
                      </Button>
                    </div>
                  </div>
                  <textarea
                    className="flex-1 w-full resize-none bg-background text-foreground p-4 font-mono text-sm outline-none border-0"
                    value={editedContent}
                    onChange={(e) => { setEditedContent(e.target.value); setIsDirty(e.target.value !== fileContent) }}
                    spellCheck={false}
                  />
                </>
              ) : (
                <div className="flex-1 flex items-center justify-center text-muted-foreground">
                  <div className="text-center">
                    <File className="h-12 w-12 mx-auto mb-3 opacity-20" />
                    <p className="text-sm">点击左上角文件图标选择文件</p>
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
                <button className="p-1 rounded hover:bg-muted" onClick={() => setShowFileTree(false)}>
                  <X className="h-4 w-4" />
                </button>
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
                      if (path === selectedFile) return
                      setEditedContent("")
                      setFileContent("")
                      setGitHeadContent("")
                      setIsDirty(false)
                      setSelectedFile(path)
                      setShowFileTree(false)
                    }}
                    onCreateFile={(parentPath) => { setShowCreate({ parentPath, type: "file" }); setCreateName("") }}
                    onCreateFolder={(parentPath) => { setShowCreate({ parentPath, type: "directory" }); setCreateName("") }}
                    onDelete={handleDeleteEntry}
                    fileStatuses={fileStatuses}
                    isMobile
                  />
                )}
              </div>
            </div>
          </>
        )}

        {/* Floating balls + bottom bar */}
        {/* Top-left: file tree trigger (only in backstage mode) */}
        {mode === "backstage" && !fullscreenPanel && (
          <div className="fixed top-3 left-3 z-30">
            <button
              className="w-10 h-10 rounded-full bg-primary text-primary-foreground shadow-lg flex items-center justify-center active:scale-95 transition-transform"
              onClick={() => setShowFileTree(true)}
            >
              <File className="h-5 w-5" />
            </button>
          </div>
        )}

        {/* Top-right: menu trigger */}
        {!fullscreenPanel && (
          <div className="fixed top-3 right-3 z-30">
            <button
              className="px-3 py-2 rounded-full bg-primary text-primary-foreground shadow-lg flex items-center gap-1.5 text-xs font-medium active:scale-95 transition-transform"
              onClick={() => setShowMobileMenu(!showMobileMenu)}
            >
              {mode === "play" ? <Gamepad2 className="h-3.5 w-3.5" /> : <Wrench className="h-3.5 w-3.5" />}
              <span>{mode === "play" ? "游玩" : "后台"}</span>
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
                    onClick={() => { setFullscreenPanel("settings"); setShowMobileMenu(false) }}
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
                  className="p-0.5 rounded hover:bg-muted"
                  onClick={() => { if (instId) useGitStore.getState().fetchGitStatus(instId) }}
                  title="刷新文件状态"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                </button>
                <button
                  className="p-0.5 rounded hover:bg-muted"
                  onClick={() => { setShowExportDialog(true); setExportName(""); setExportDescription(""); setExportAuthor(""); setExportVersion("1.0.0"); setExportError("") }}
                  title="导出为原型"
                >
                  <Archive className="h-3.5 w-3.5" />
                </button>
                <button
                  className="p-0.5 rounded hover:bg-muted"
                  onClick={() => { setShowCreate({ parentPath: "", type: "file" }); setCreateName("") }}
                  title="新建文件"
                >
                  <Plus className="h-3.5 w-3.5" />
                </button>
                <button
                  className="p-0.5 rounded hover:bg-muted"
                  onClick={() => { setShowCreate({ parentPath: "", type: "directory" }); setCreateName("") }}
                  title="新建文件夹"
                >
                  <Folder className="h-3.5 w-3.5" />
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
                    if (path === selectedFile) return
                    // Reset content immediately so the editor shows a blank
                    // slate while the new file loads.
                    setEditedContent("")
                    setFileContent("")
                    setGitHeadContent("")
                    setIsDirty(false)
                    setSelectedFile(path)
                  }}
                  onCreateFile={(parentPath) => { setShowCreate({ parentPath, type: "file" }); setCreateName("") }}
                  onCreateFolder={(parentPath) => { setShowCreate({ parentPath, type: "directory" }); setCreateName("") }}
                  onDelete={handleDeleteEntry}
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
                    <Button size="sm" variant="outline" onClick={handleSave} disabled={!isDirty || isSaving} className="gap-1">
                      {isSaving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
                      保存
                    </Button>
                  </div>
                </div>
                <div className="flex-1 w-full overflow-hidden">
                  <MonacoEditor
                    path={selectedFile}
                    value={editedContent}
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
          <OutputPanel instanceId={instId} instanceName={activeInstance?.name} onSend={(msg) => useSessionStore.getState().setPendingMessage(msg)} />
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
              <ChatPanel onGitRefresh={() => refresh({ editor: false })} />
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
  onCreateFile, onCreateFolder, onDelete, fileStatuses, depth = 0, isMobile = false,
}: {
  nodes: FileTreeNode[]
  expanded: Set<string>
  selectedFile: string | null
  onToggle: (path: string) => void
  onSelect: (path: string) => void
  onCreateFile: (parentPath: string) => void
  onCreateFolder: (parentPath: string) => void
  onDelete: (path: string) => void
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
                    className="p-0.5 rounded hover:bg-muted"
                    onClick={e => { e.stopPropagation(); onCreateFile(node.path) }}
                    title="新建文件"
                  >
                    <Plus className="h-3 w-3" />
                  </button>
                  <button
                    className="p-0.5 rounded hover:bg-muted"
                    onClick={e => { e.stopPropagation(); onCreateFolder(node.path) }}
                    title="新建文件夹"
                  >
                    <Folder className="h-3 w-3" />
                  </button>
                </>
              )}
              <button
                className="p-0.5 rounded hover:bg-muted text-muted-foreground hover:text-red-500"
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

// ============================================================================
// MobileSettingsContent — simplified settings for mobile overlay
// ============================================================================
function MobileSettingsContent({
  instId,
  activeInstance,
  onClose,
}: {
  instId: string
  activeInstance: { id: string; name: string } | null
  onClose: () => void
}) {
  const navigate = useNavigate()
  const setActiveInstance = useSessionStore((s) => s.setActiveInstance)
  const { clearAuth } = useAuthActions()
  const openSettings = useSettingsDialogStore((s) => s.openSettings)

  return (
    <div className="space-y-4">
      {/* Instance info */}
      {activeInstance && (
        <div className="p-3 rounded-md border border-border">
          <p className="text-sm font-medium">{activeInstance.name}</p>
          <p className="text-xs text-muted-foreground">ID: {activeInstance.id}</p>
        </div>
      )}

      {/* Navigation actions */}
      <div className="space-y-2">
        <Button
          variant="outline"
          className="w-full justify-start gap-2"
          onClick={() => {
            openSettings()
            onClose()
          }}
        >
          <Settings className="h-4 w-4" />
          完整设置
        </Button>

        <Button
          variant="outline"
          className="w-full justify-start gap-2"
          onClick={() => {
            openSettings("plugins")
            onClose()
          }}
        >
          <Puzzle className="h-4 w-4" />
          插件管理
        </Button>
      </div>

      {/* Exit */}
      <div className="pt-2 border-t border-border">
        <Button
          variant="outline"
          className="w-full justify-start gap-2"
          onClick={() => {
            setActiveInstance(null)
            navigate("/", { replace: true })
          }}
        >
          <ArrowLeft className="h-4 w-4" />
          退出到主页
        </Button>
      </div>
    </div>
  )
}
