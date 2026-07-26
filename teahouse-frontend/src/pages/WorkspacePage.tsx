import { useEffect, useState, useCallback, useRef } from "react"
import { useNavigate } from "react-router-dom"
import {
  File, Folder, FolderOpen, Plus, Trash2, Loader2,
  ChevronRight, ChevronDown, Save, ArrowLeft, FileText,
  GitCommitHorizontal, GitBranch as GitBranchIcon, GitFork,
  CheckCircle2, AlertCircle,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { instancesApi, gitApi } from "@/lib/api"
import { useSessionStore } from "@/stores/sessionStore"
import { ChatPanel } from "@/components/ChatPanel"
import type { FileTreeNode, GitBranch, GitStatus } from "@/lib/types"

export function WorkspacePage() {
  const navigate = useNavigate()
  const activeInstance = useSessionStore((s) => s.activeInstance)
  const setActiveInstance = useSessionStore((s) => s.setActiveInstance)

  const [fileTree, setFileTree] = useState<FileTreeNode[]>([])
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [fileContent, setFileContent] = useState("")
  const [editedContent, setEditedContent] = useState("")
  const [isDirty, setIsDirty] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)

  // Create dialog state
  const [showCreate, setShowCreate] = useState<{ parentPath: string; type: "file" | "directory" } | null>(null)
  const [createName, setCreateName] = useState("")

  // Rename / delete — not yet implemented, but structure ready

  const instId = activeInstance?.id

  // Git state
  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null)
  const [gitLoading, setGitLoading] = useState(false)
  const [showCommitDialog, setShowCommitDialog] = useState(false)
  const [commitMessage, setCommitMessage] = useState("")
  const [showBranchDialog, setShowBranchDialog] = useState(false)
  const [branchAction, setBranchAction] = useState<"create" | "switch">("create")
  const [branchName, setBranchName] = useState("")

  const loadGitStatus = useCallback(async () => {
    if (!instId) return
    setGitLoading(true)
    const res = await gitApi.getStatus(instId)
    if (res.ok) {
      setGitStatus(res.data!)
    }
    setGitLoading(false)
  }, [instId])

  useEffect(() => {
    loadGitStatus()
  }, [loadGitStatus])

  const handleGitCommit = async () => {
    if (!instId || !commitMessage.trim()) return
    const res = await gitApi.commit(instId, commitMessage.trim())
    if (res.ok) {
      setShowCommitDialog(false)
      setCommitMessage("")
      await loadGitStatus()
      await loadFileTree()
    }
  }

  const handleGitBranch = async () => {
    if (!instId) return
    if (branchAction === "create" && !branchName.trim()) return

    const res = await gitApi.branch(instId, branchAction, branchName.trim() || undefined)
    if (res.ok) {
      setShowBranchDialog(false)
      setBranchName("")
      await loadGitStatus()
      await loadFileTree()
    }
  }

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

  // Load file content when selected
  useEffect(() => {
    if (!instId || !selectedFile) {
      setFileContent("")
      setEditedContent("")
      setIsDirty(false)
      return
    }
    ;(async () => {
      const res = await instancesApi.readFile(instId, selectedFile)
      if (res.ok) {
        setFileContent(res.data!.content)
        setEditedContent(res.data!.content)
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
  }

  const handleDeleteEntry = async (path: string) => {
    if (!instId) return
    if (!confirm(`确定删除 "${path}" 吗？`)) return
    await instancesApi.deleteEntry(instId, path)
    if (selectedFile === path || selectedFile?.startsWith(path + "/")) {
      setSelectedFile(null)
      setFileContent("")
      setEditedContent("")
      setIsDirty(false)
    }
    await loadFileTree()
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
      const r = await instancesApi.readFile(instId, currentSelected)
      if (r.ok) {
        setFileContent(r.data!.content)
        setEditedContent(r.data!.content)
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

  const getIcon = (node: FileTreeNode) => {
    if (node.type === "directory") {
      return expanded.has(node.path) ? (
        <FolderOpen className="h-4 w-4 text-yellow-500 shrink-0" />
      ) : (
        <Folder className="h-4 w-4 text-yellow-500 shrink-0" />
      )
    }
    return <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
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
          </div>
        </div>

        {/* Git status bar */}
        <div className="px-3 py-1.5 border-b border-border flex items-center gap-2 text-xs text-muted-foreground">
          {gitLoading ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : gitStatus ? (
            <>
              <GitBranchIcon className="h-3 w-3 shrink-0" />
              <span className="font-mono truncate" title={gitStatus.current_branch}>
                {gitStatus.current_branch || "main"}
              </span>
              {gitStatus.has_uncommitted && (
                <span className="flex items-center gap-0.5 text-yellow-500 ml-auto shrink-0">
                  <AlertCircle className="h-3 w-3" />
                  <span>未提交</span>
                </span>
              )}
              {!gitStatus.has_uncommitted && (
                <span className="flex items-center gap-0.5 text-green-500 ml-auto shrink-0">
                  <CheckCircle2 className="h-3 w-3" />
                </span>
              )}
              <div className="flex items-center gap-0.5 ml-1 shrink-0">
                <button
                  className="p-0.5 rounded hover:bg-muted"
                  onClick={() => { setCommitMessage(""); setShowCommitDialog(true) }}
                  title="提交变更"
                >
                  <GitCommitHorizontal className="h-3 w-3" />
                </button>
                <button
                  className="p-0.5 rounded hover:bg-muted"
                  onClick={() => { setBranchName(""); setBranchAction("create"); setShowBranchDialog(true) }}
                  title="分支管理"
                >
                  <GitFork className="h-3 w-3" />
                </button>
              </div>
            </>
          ) : (
            <span className="text-[10px]">Git 不可用</span>
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
              onSelect={(path) => { setSelectedFile(path); setIsDirty(false) }}
              onCreateFile={(parentPath) => { setShowCreate({ parentPath, type: "file" }); setCreateName("") }}
              onCreateFolder={(parentPath) => { setShowCreate({ parentPath, type: "directory" }); setCreateName("") }}
              onDelete={handleDeleteEntry}
            />
          )}
        </div>
      </aside>

      {/* Middle panel — Editor */}
      <div className="flex-[2] flex flex-col bg-background min-w-0">
        {selectedFile ? (
          <>
            <div className="flex items-center justify-between px-3 py-2 border-b border-border shrink-0">
              <span className="text-sm text-muted-foreground truncate">{selectedFile}</span>
              <div className="flex items-center gap-2 shrink-0">
                {isDirty && <span className="text-xs text-yellow-500">未保存</span>}
                <Button size="sm" variant="outline" onClick={handleSave} disabled={!isDirty || isSaving} className="gap-1">
                  {isSaving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
                  保存
                </Button>
              </div>
            </div>
            <textarea
              className="flex-1 w-full resize-none bg-transparent p-4 font-mono text-sm outline-none border-0"
              value={editedContent}
              onChange={e => { setEditedContent(e.target.value); setIsDirty(e.target.value !== fileContent) }}
              placeholder="文件内容..."
            />
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

      {/* Commit Dialog */}
      {showCommitDialog && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={() => setShowCommitDialog(false)}>
          <div className="bg-background rounded-lg shadow-lg w-full max-w-sm mx-4 p-6 space-y-4" onClick={e => e.stopPropagation()}>
            <h3 className="font-semibold flex items-center gap-2">
              <GitCommitHorizontal className="h-4 w-4" />
              提交变更
            </h3>
            <p className="text-xs text-muted-foreground">
              当前分支：<span className="font-mono">{gitStatus?.current_branch || "main"}</span>
              {gitStatus?.has_uncommitted && "（有未提交的变更）"}
            </p>
            <Input
              value={commitMessage}
              onChange={e => setCommitMessage(e.target.value)}
              placeholder="floor-NNN: 简短描述"
              autoFocus
              onKeyDown={e => { if (e.key === "Enter") handleGitCommit() }}
            />
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setShowCommitDialog(false)}>取消</Button>
              <Button size="sm" onClick={handleGitCommit} disabled={!commitMessage.trim()}>提交</Button>
            </div>
          </div>
        </div>
      )}

      {/* Branch Dialog */}
      {showBranchDialog && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={() => setShowBranchDialog(false)}>
          <div className="bg-background rounded-lg shadow-lg w-full max-w-sm mx-4 p-6 space-y-4" onClick={e => e.stopPropagation()}>
            <h3 className="font-semibold flex items-center gap-2">
              <GitFork className="h-4 w-4" />
              分支管理
            </h3>

            {/* Branch list */}
            {gitStatus?.branches && gitStatus.branches.length > 0 && (
              <div className="space-y-1 max-h-32 overflow-y-auto">
                <p className="text-[10px] text-muted-foreground uppercase tracking-wider">已有分支</p>
                {gitStatus.branches.map(b => (
                  <div key={b.name} className="flex items-center gap-2 text-xs px-2 py-1 rounded hover:bg-muted/50">
                    <GitBranchIcon className="h-3 w-3 shrink-0" />
                    <span className={`font-mono ${b.is_current ? "font-bold text-primary" : ""}`}>
                      {b.name}
                    </span>
                    {b.is_current && <span className="text-[10px] text-muted-foreground ml-auto">当前</span>}
                  </div>
                ))}
              </div>
            )}

            {/* Tabs: create / switch */}
            <div className="flex gap-1 bg-muted rounded-lg p-1">
              <button
                className={`flex-1 text-xs py-1 rounded-md transition-colors ${branchAction === "create" ? "bg-background shadow-sm font-medium" : "text-muted-foreground hover:text-foreground"}`}
                onClick={() => setBranchAction("create")}
              >
                创建
              </button>
              <button
                className={`flex-1 text-xs py-1 rounded-md transition-colors ${branchAction === "switch" ? "bg-background shadow-sm font-medium" : "text-muted-foreground hover:text-foreground"}`}
                onClick={() => setBranchAction("switch")}
              >
                切换
              </button>
            </div>

            {branchAction === "create" ? (
              <div className="space-y-2">
                <Input
                  value={branchName}
                  onChange={e => setBranchName(e.target.value)}
                  placeholder="新分支名称（如 retro-回到星罗城）"
                  autoFocus
                  onKeyDown={e => { if (e.key === "Enter") handleGitBranch() }}
                />
                <p className="text-[10px] text-muted-foreground">基于当前 HEAD 创建新分支</p>
              </div>
            ) : (
              <div className="space-y-2">
                <select
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
                  value={branchName}
                  onChange={e => setBranchName(e.target.value)}
                >
                  <option value="">选择分支...</option>
                  {gitStatus?.branches?.filter(b => !b.is_current).map(b => (
                    <option key={b.name} value={b.name}>{b.name}</option>
                  ))}
                </select>
                <p className="text-[10px] text-muted-foreground">
                  切换到已有分支。当前未提交的变更需要先提交，否则切换将被拒绝。
                </p>
              </div>
            )}

            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setShowBranchDialog(false)}>取消</Button>
              <Button
                size="sm"
                onClick={handleGitBranch}
                disabled={branchAction === "create" ? !branchName.trim() : !branchName}
              >
                {branchAction === "create" ? "创建" : "切换"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ---- File tree recursive component ----

function FileTreeView({
  nodes, expanded, selectedFile, onToggle, onSelect,
  onCreateFile, onCreateFolder, onDelete, depth = 0,
}: {
  nodes: FileTreeNode[]
  expanded: Set<string>
  selectedFile: string | null
  onToggle: (path: string) => void
  onSelect: (path: string) => void
  onCreateFile: (parentPath: string) => void
  onCreateFolder: (parentPath: string) => void
  onDelete: (path: string) => void
  depth?: number
}) {
  return (
    <>
      {nodes.map((node) => (
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
                {expanded.has(node.path) ? (
                  <FolderOpen className="h-4 w-4 text-yellow-500 shrink-0" />
                ) : (
                  <Folder className="h-4 w-4 text-yellow-500 shrink-0" />
                )}
              </>
            ) : (
              <>
                <span className="w-3 shrink-0" />
                <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
              </>
            )}
            <span className="flex-1 truncate text-sm">{node.name}</span>

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
              depth={depth + 1}
            />
          )}
        </div>
      ))}
    </>
  )
}
