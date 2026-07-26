import { useEffect, useState, useCallback, useRef } from "react"
import { useNavigate } from "react-router-dom"
import { MonacoEditor } from "@/components/MonacoEditor"
import {
  File, Folder, FolderOpen, Plus, Trash2, Loader2,
  ChevronRight, ChevronDown, Save, ArrowLeft, FileText,
  GitBranch as GitBranchIcon, Edit3,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { instancesApi, gitApi } from "@/lib/api"
import { useSessionStore } from "@/stores/sessionStore"
import { ChatPanel } from "@/components/ChatPanel"
import { GitDialog } from "@/components/GitDialog"
import { ConfirmDialog } from "@/components/ConfirmDialog"
import type { FileTreeNode, GitStatus, GitFileStatus } from "@/lib/types"

// Monaco Editor theme follows system dark mode — handled by MonacoEditor component

export function WorkspacePage() {
  const navigate = useNavigate()
  const activeInstance = useSessionStore((s) => s.activeInstance)
  const setActiveInstance = useSessionStore((s) => s.setActiveInstance)

  const [fileTree, setFileTree] = useState<FileTreeNode[]>([])
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  // Increment on file switch to force MonacoEditor remount
  const [editorKey, setEditorKey] = useState(0)
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
  // Track whether the file content has finished loading, so MonacoEditor
  // only mounts with a fully-populated model (no undo-"back-to-empty" artifact).
  const [contentReady, setContentReady] = useState(false)

  // Create dialog state
  const [showCreate, setShowCreate] = useState<{ parentPath: string; type: "file" | "directory" } | null>(null)
  const [createName, setCreateName] = useState("")

  // Rename / delete — not yet implemented, but structure ready
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)

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
      loadFileStatuses()
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
    await loadFileTree()
    loadFileStatuses()
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
    await loadFileTree()
    loadFileStatuses()
  }

  const handleLeaveSession = () => {
    setActiveInstance(null)
    navigate("/", { replace: true })
  }

  // Keep a ref for latest selectedFile so onFileChanged callback always has current value
  const selectedFileRef = useRef(selectedFile)
  selectedFileRef.current = selectedFile

  const onFileChanged = useCallback(async (filePath: string) => {
    if (!instId) return
    // Refresh file tree
    const res = await instancesApi.listFiles(instId)
    if (res.ok) setFileTree(res.data || [])
    // Reload editor if the modified file is currently open
    const currentSelected = selectedFileRef.current
    if (currentSelected && (!filePath || filePath === currentSelected)) {
      const [fileRes, headRes] = await Promise.all([
        instancesApi.readFile(instId, currentSelected),
        gitApi.showFile(instId, currentSelected),
      ])
      if (fileRes.ok) {
        const diskContent = fileRes.data!.content
        setFileContent(diskContent)
        setEditedContent(diskContent)
        const headContent = headRes.ok && headRes.data?.content != null ? headRes.data.content : ""
        setGitHeadContent(headContent)
        setIsDirty(false)
      }
    }
  }, [instId])

  const toggleExpand = (path: string) => {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  if (!activeInstance) return null

  return (
    <div className="h-full flex overflow-hidden">
      {/* Left panel — File tree */}
      <aside className="w-64 border-r border-border shrink-0 flex flex-col bg-muted/20">
        <div className="p-3 border-b border-border flex items-center justify-between">
          <div className="flex items-center gap-2 min-w-0">
            <button
              className="p-0.5 rounded hover:bg-muted shrink-0"
              onClick={handleLeaveSession}
              title="返回会话选择"
            >
              <ArrowLeft className="h-4 w-4" />
            </button>
            <span className="text-sm font-semibold truncate" title={activeInstance.name}>
              {activeInstance.name}
            </span>
          </div>
          <div className="flex items-center gap-0.5 shrink-0">
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

        {/* Git status bar — click to open git dialog */}
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border cursor-pointer hover:bg-muted/30 transition-colors" onClick={() => setShowGitDialog(true)}>
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
                // Force MonacoEditor to fully remount by clearing then re-setting
                setSelectedFile(null)
                setFileContent("")
                setEditedContent("")
                setIsDirty(false)
                // Use setTimeout to let React flush the unmount before setting new file
                setTimeout(() => {
                  setEditorKey(k => k + 1)
                  setSelectedFile(path)
                }, 0)
              }}
              onCreateFile={(parentPath) => { setShowCreate({ parentPath, type: "file" }); setCreateName("") }}
              onCreateFolder={(parentPath) => { setShowCreate({ parentPath, type: "directory" }); setCreateName("") }}
              onDelete={handleDeleteEntry}
              fileStatuses={fileStatuses}
              dirtyFile={isDirty ? selectedFile : null}
            />
          )}
        </div>
      </aside>

      {/* Middle panel — Editor */}
      <div className="flex-[2] flex flex-col bg-background min-w-0">
        {selectedFile && contentReady ? (
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
                key={editorKey}
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

      {/* Right panel — Chat */}
      <aside className="flex-[3] border-l border-border flex flex-col bg-muted/10 min-w-0">
        <ChatPanel onFileChanged={onFileChanged} />
      </aside>

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
        onRefresh={async () => {
          loadGitStatus()
          loadFileTree()
          loadFileStatuses()
          // Reload currently open file if any
          if (instId && selectedFile) {
            setContentReady(false)
            const res = await instancesApi.readFile(instId, selectedFile)
            if (res.ok) {
              setFileContent(res.data!.content)
              setEditedContent(res.data!.content)
              setIsDirty(false)
              setContentReady(true)
            }
          }
        }}
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
    </div>
  )
}

// ---- File tree recursive component ----

function FileTreeView({
  nodes, expanded, selectedFile, onToggle, onSelect,
  onCreateFile, onCreateFolder, onDelete, fileStatuses, depth = 0,
  dirtyFile,
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
  dirtyFile?: string | null
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
            {node.type === "file" && dirtyFile === node.path && (
              <span className="shrink-0 w-2 h-2 rounded-full bg-orange-500" title="未保存到磁盘" />
            )}

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
              dirtyFile={dirtyFile}
            />
            )}
          </div>
        ))}
    </>
  )
}
