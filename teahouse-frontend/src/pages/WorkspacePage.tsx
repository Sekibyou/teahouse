import { useEffect, useState, useCallback, useRef } from "react"
import { useNavigate } from "react-router-dom"
import { MonacoEditor } from "@/components/MonacoEditor"
import {
  File, Folder, FolderOpen, Plus, Trash2, Loader2,
  ChevronRight, ChevronDown, Save, FileText,
  GitBranch as GitBranchIcon, Edit3, Puzzle,
  PanelLeftOpen, GripVertical, Archive,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { instancesApi, gitApi, pluginsApi, prototypesApi } from "@/lib/api"
import { useSessionStore } from "@/stores/sessionStore"
import { useViewModeStore } from "@/stores/viewModeStore"
import { ChatPanel } from "@/components/ChatPanel"
import { OutputPanel } from "@/components/OutputPanel"
import { GitDialog } from "@/components/GitDialog"
import { ConfirmDialog } from "@/components/ConfirmDialog"
import { PluginPanel } from "@/components/PluginPanel"
import { useWorkspaceRefresh } from "@/hooks/useWorkspaceRefresh"
import { useSSERefresh } from "@/hooks/useSSERefresh"
import type { FileTreeNode, GitStatus, GitFileStatus } from "@/lib/types"
import type { Plugin } from "@/lib/pluginTypes"

// Monaco Editor theme follows system dark mode — handled by MonacoEditor component

export function WorkspacePage() {
  const navigate = useNavigate()
  const activeInstance = useSessionStore((s) => s.activeInstance)
  const setActiveInstance = useSessionStore((s) => s.setActiveInstance)
  const mode = useViewModeStore((s) => s.mode)
  const chatWidth = useViewModeStore((s) => s.chatWidth)
  const chatCollapsed = useViewModeStore((s) => s.chatCollapsed)
  const setChatWidth = useViewModeStore((s) => s.setChatWidth)

  const [fileTree, setFileTree] = useState<FileTreeNode[]>([])
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [fileContent, setFileContent] = useState("")
  const [editedContent, setEditedContent] = useState("")
  const [isDirty, setIsDirty] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
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

  // Plugin panels state
  const [enabledPlugins, setEnabledPlugins] = useState<Plugin[]>([])
  const [pluginPanel, setPluginPanel] = useState<string | null>(null)

  const loadPlugins = useCallback(async () => {
    const res = await pluginsApi.list()
    if (res.ok) {
      setEnabledPlugins(res.data!.plugins.filter(p => p.enabled && p.has_frontend))
    }
  }, [])
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

  // Git state
  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null)
  const [gitLoading, setGitLoading] = useState(false)
  const [showGitDialog, setShowGitDialog] = useState(false)
  const [fileStatuses, setFileStatuses] = useState<Map<string, string>>(new Map())
  const [fileStatusLoading, setFileStatusLoading] = useState(false)

  const loadGitStatus = useCallback(async () => {
    if (!instId) return
    setGitLoading(true)
    const res = await gitApi.getStatus(instId)
    if (res.ok) {
      setGitStatus(res.data!)
    }
    setGitLoading(false)
  }, [instId])

  const loadFileStatuses = useCallback(async () => {
    if (!instId) return
    setFileStatusLoading(true)
    const res = await gitApi.fileStatus(instId)
    if (res.ok && res.data?.files) {
      const m = new Map<string, string>()
      for (const f of res.data.files) {
        m.set(f.path, f.status)
      }
      setFileStatuses(m)
    }
    setFileStatusLoading(false)
  }, [instId])

  useEffect(() => {
    loadGitStatus()
  }, [loadGitStatus])

  useEffect(() => {
    loadFileStatuses()
    // Poll file statuses every 5s for real-time updates
    const interval = setInterval(loadFileStatuses, 5000)
    return () => clearInterval(interval)
  }, [loadFileStatuses])

  // Load plugin panels
  useEffect(() => {
    loadPlugins()
  }, [loadPlugins])

  // Redirect if no active instance
  useEffect(() => {
    if (!activeInstance) {
      navigate("/", { replace: true })
    }
  }, [activeInstance, navigate])

  // Load file tree
  const loadFileTree = useCallback(async () => {
    if (!instId) return
    setIsLoading(true)
    const res = await instancesApi.listFiles(instId)
    if (res.ok) {
      setFileTree(res.data || [])
    }
    setIsLoading(false)
  }, [instId])

  useEffect(() => {
    loadFileTree()
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
        instancesApi.readFile(instId, selectedFile),
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
      instId, "_prototype", exportName.trim(), exportDescription.trim(),
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

  // Unified refresh hook — used by GitDialog (after user git operations),
  // save handlers, and SSE-driven events from the backend.
  const refresh = useWorkspaceRefresh({
    instId,
    selectedFileRef,
    loadFileTree,
    loadGitStatus,
    loadFileStatuses,
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
        instancesApi.readFile(instId!, currentFile).then(fileRes => {
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
        instancesApi.readFile(instId, currentFile).then(fileRes => {
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

  const handleDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    setIsDragging(true)
  }, [])

  useEffect(() => {
    if (!isDragging) return
    const handleMouseMove = (e: MouseEvent) => {
      if (!containerRef.current) return
      const rect = containerRef.current.getBoundingClientRect()
      const newWidthPx = rect.right - e.clientX
      const newWidthPct = (newWidthPx / rect.width) * 100
      setChatWidth(Math.min(Math.max(newWidthPct, 20), 60))
    }
    const handleMouseUp = () => setIsDragging(false)
    window.addEventListener("mousemove", handleMouseMove)
    window.addEventListener("mouseup", handleMouseUp)
    return () => {
      window.removeEventListener("mousemove", handleMouseMove)
      window.removeEventListener("mouseup", handleMouseUp)
    }
  }, [isDragging, setChatWidth])

  if (!activeInstance) return null

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

            {/* Git status bar — at bottom */}
            <div className="flex items-center gap-2 px-3 py-2 border-t border-border cursor-pointer hover:bg-muted/30 transition-colors shrink-0" onClick={() => setShowGitDialog(true)}>
              {gitLoading ? (
                <Loader2 className="h-3 w-3 animate-spin shrink-0" />
              ) : gitStatus ? (
                <>
                  <GitBranchIcon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  <span className="text-xs font-mono flex-1 truncate" title={gitStatus.current_branch}>
                    {gitStatus.current_branch || "main"}
                  </span>
                  {(() => {
                    const counts = { added: 0, modified: 0, deleted: 0, untracked: 0 }
                    for (const st of fileStatuses.values()) {
                      if (st === "A" || st === "?") counts.added++
                      else if (st === "M") counts.modified++
                      else if (st === "D") counts.deleted++
                      else if (st === "R") counts.modified++
                    }
                    const total = counts.added + counts.modified + counts.deleted
                    return total > 0 ? (
                      <div className="flex items-center gap-1 shrink-0">
                        {counts.added > 0 && (
                          <span className="text-[9px] bg-green-500/15 text-green-600 dark:text-green-400 font-medium px-1 py-0.5 rounded leading-none">
                            +{counts.added}
                          </span>
                        )}
                        {counts.modified > 0 && (
                          <span className="text-[9px] bg-yellow-500/15 text-yellow-600 dark:text-yellow-400 font-medium px-1 py-0.5 rounded leading-none">
                            ~{counts.modified}
                          </span>
                        )}
                        {counts.deleted > 0 && (
                          <span className="text-[9px] bg-red-500/15 text-red-600 dark:text-red-400 font-medium px-1 py-0.5 rounded leading-none">
                            -{counts.deleted}
                          </span>
                        )}
                      </div>
                    ) : null
                  })()}
                  <Edit3 className="h-3 w-3 text-muted-foreground shrink-0" />
                </>
              ) : (
                <span className="text-[10px] text-muted-foreground">Git 不可用</span>
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
            onMouseDown={handleDragStart}
          >
            <GripVertical className="h-4 w-4 absolute top-1/2 -translate-y-1/2 -left-[7px] text-muted-foreground/40 group-hover:text-muted-foreground pointer-events-none" />
          </div>
          {/* Chat panel */}
          <aside
            className="border-l border-border flex flex-col bg-muted/10 min-w-0 shrink-0"
            style={{ width: `${chatWidth}%` }}
          >
            {/* Plugin panel tabs */}
            {enabledPlugins.length > 0 && (
              <div className="flex items-center gap-0 border-b border-border shrink-0 overflow-x-auto">
                {enabledPlugins.map((p) => (
                  <button
                    key={p.id}
                    className={`px-3 py-1.5 text-xs font-medium transition-colors shrink-0 border-r border-border ${
                      pluginPanel === p.id
                        ? "bg-primary text-primary-foreground"
                        : "hover:bg-muted text-muted-foreground"
                    }`}
                    onClick={() => setPluginPanel(pluginPanel === p.id ? null : p.id)}
                    title={p.description}
                  >
                    <Puzzle className="h-3 w-3 inline mr-1" />
                    {p.name}
                  </button>
                ))}
              </div>
            )}
            <div className="flex-1 flex flex-col min-h-0">
              {pluginPanel ? (
                <PluginPanel pluginId={pluginPanel} />
              ) : (
                <ChatPanel />
              )}
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

      {/* Git Dialog — single unified dialog */}
      <GitDialog
        instanceId={instId || ""}
        open={showGitDialog}
        onClose={() => setShowGitDialog(false)}
        onRefresh={() => refresh({ editor: false })}
      />

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
              将实例的 <code className="bg-muted px-1 rounded">_prototype/</code> 目录打包为可复用的原型。请先使用导演构建该目录。
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
  onCreateFile, onCreateFolder, onDelete, fileStatuses, depth = 0,
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
            className={`flex items-center gap-1 px-2 py-1 cursor-pointer hover:bg-muted/50 transition-colors group ${
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
            />
            )}
          </div>
        ))}
    </>
  )
}
