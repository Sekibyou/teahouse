import { useEffect, useState, useCallback, useMemo, useRef } from "react"
import {
  GitBranch as GitBranchIcon, GitCommitHorizontal, Loader2,
  CheckCircle2, AlertCircle, X, RotateCcw, GitFork,
  History, FileText, FilePlus, FileMinus, FileEdit,
  Save, Trash2, Pencil, CornerDownRight, Undo2,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { gitApi } from "@/lib/api"
import type { GitStatus, GitBranch, GitLogEntry, GitFileStatus } from "@/lib/types"
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  Handle,
  Position,
  type Node,
  type Edge,
  type NodeProps,
} from "reactflow"
import "reactflow/dist/style.css"

interface GitDialogProps {
  instanceId: string
  open: boolean
  onClose: () => void
  onRefresh: () => void
}

type TabKey = "graph" | "commit"

const COMMIT_PREFIXES = [
  { value: "楼层", label: "楼层" },
  { value: "总结", label: "总结" },
  { value: "暂存", label: "暂存" },
] as const

type CommitType = (typeof COMMIT_PREFIXES)[number]["value"]

function commitTypeLabel(msg: string): { type: CommitType | "其他"; display: string } {
  for (const p of COMMIT_PREFIXES) {
    if (msg.startsWith(p.value)) return { type: p.value, display: msg }
  }
  return { type: "其他", display: msg }
}

const STATUS_MAP: Record<string, { label: string; icon: typeof FileText; color: string }> = {
  M: { label: "修改", icon: FileEdit, color: "text-yellow-500" },
  A: { label: "新建", icon: FilePlus, color: "text-green-500" },
  D: { label: "删除", icon: FileMinus, color: "text-red-500" },
  "?": { label: "未跟踪", icon: FilePlus, color: "text-blue-500" },
  R: { label: "重命名", icon: FileEdit, color: "text-purple-500" },
}

function nextTempName(): string {
  return `temp-${Date.now().toString(36)}`
}

export function GitDialog({ instanceId, open, onClose, onRefresh }: GitDialogProps) {
  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const [fileStatuses, setFileStatuses] = useState<GitFileStatus[]>([])
  const [filesLoading, setFilesLoading] = useState(false)

  // Commit form
  const [commitPrefix, setCommitPrefix] = useState<CommitType>("楼层")
  const [commitMessage, setCommitMessage] = useState("")
  const [committing, setCommitting] = useState(false)
  const [commitBranchName, setCommitBranchName] = useState("")
  const [commitAndBranch, setCommitAndBranch] = useState(false)

  // Node context menu (click on self = HEAD)
  const [contextNode, setContextNode] = useState<{ hash: string; msg: string; branchName?: string; isSelf: boolean; isOnCurrentBranch: boolean } | null>(null)
  const [renaming, setRenaming] = useState(false)
  const [newBranchName, setNewBranchName] = useState("")
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  const [tab, setTab] = useState<TabKey>("graph")

  const loadStatus = useCallback(async () => {
    if (!instanceId) return
    setLoading(true)
    const res = await gitApi.getStatus(instanceId)
    if (res.ok) {
      setGitStatus(res.data!)
    } else {
      setError(res.error || "加载 git 状态失败")
    }
    setLoading(false)
  }, [instanceId])

  const loadFileStatuses = useCallback(async () => {
    if (!instanceId) return
    setFilesLoading(true)
    const res = await gitApi.fileStatus(instanceId)
    if (res.ok) {
      setFileStatuses(res.data!.files || [])
    }
    setFilesLoading(false)
  }, [instanceId])

  useEffect(() => {
    if (open) {
      loadStatus()
      loadFileStatuses()
    }
  }, [open, loadStatus, loadFileStatuses])

  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setContextNode(null)
        setConfirmingDelete(false)
        setRenaming(false)
      }
    }
    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [open])

  const handleCommit = async () => {
    const fullMsg = `${commitPrefix}: ${commitMessage.trim()}`
    if (fullMsg.length <= 2) return
    setCommitting(true)
    setError("")

    if (commitAndBranch && commitBranchName.trim()) {
      const brRes = await gitApi.branch(instanceId, "create", commitBranchName.trim())
      if (!brRes.ok) {
        setError(brRes.error || "创建分支失败")
        setCommitting(false)
        return
      }
    }

    const res = await gitApi.commit(instanceId, fullMsg)
    if (res.ok) {
      setCommitMessage("")
      setCommitBranchName("")
      setCommitAndBranch(false)
      await loadStatus()
      await loadFileStatuses()
      onRefresh()
    } else {
      setError(res.error || "提交失败")
    }
    setCommitting(false)
  }

  /** Click on any node → always open context menu */
  const handleNodeClick = useCallback(
    (hash: string, msg: string, isCurrentBranchHead: boolean, isOnCurrentBranch: boolean, branchName: string) => {
      setError("")
      setContextNode({ hash, msg, branchName, isSelf: isCurrentBranchHead, isOnCurrentBranch })
    },
    []
  )

  const executeNavigate = async (hash: string, branchName: string, isOtherLatest: boolean) => {
    setError("")
    const tempName = nextTempName()
    try {
      if (isOtherLatest) {
        const swRes = await gitApi.branch(instanceId, "switch", branchName)
        if (!swRes.ok) throw new Error(swRes.error || "切换失败")
      } else {
        await gitApi.branch(instanceId, "create", tempName, hash)
        await gitApi.branch(instanceId, "switch", tempName)
      }
      await loadStatus()
      await loadFileStatuses()
      onRefresh()
    } catch (e: any) {
      setError(e.message || "操作失败")
    }
  }

  const handleRename = async () => {
    if (!contextNode?.branchName || !newBranchName.trim()) return
    setError("")
    const res = await gitApi.renameBranch(instanceId, contextNode.branchName, newBranchName.trim())
    if (res.ok) {
      setContextNode(null)
      setRenaming(false)
      setNewBranchName("")
      await loadStatus()
      onRefresh()
    } else {
      setError(res.error || "改名失败")
    }
  }

  const handleDeleteNode = async () => {
    if (!contextNode) return
    setError("")
    if (!contextNode.isOnCurrentBranch) {
      const swRes = await gitApi.branch(instanceId, "switch", contextNode.branchName!)
      if (!swRes.ok) {
        setError(swRes.error || "切换分支失败")
        return
      }
    }
    const res = await gitApi.deleteNode(instanceId, contextNode.hash, contextNode.branchName!)
    if (res.ok) {
      setContextNode(null)
      setConfirmingDelete(false)
      await loadStatus()
      await loadFileStatuses()
      onRefresh()
    } else {
      setError(res.error || "删除失败")
    }
  }

  const handleDiscardAll = async () => {
    setError("")
    const res = await gitApi.discard(instanceId)
    if (res.ok) {
      setContextNode(null)
      await loadFileStatuses()
      await loadStatus()
      onRefresh()
    } else {
      setError(res.error || "丢弃失败")
    }
  }

  const handleRestoreFile = async (filePath: string) => {
    setError("")
    const res = await gitApi.discard(instanceId, filePath)
    if (res.ok) {
      await loadFileStatuses()
      await loadStatus()
    } else {
      setError(res.error || "还原失败")
    }
  }

  if (!open) return null

  const currentBranch = gitStatus?.current_branch || "main"
  const branches = gitStatus?.branches || []
  const commits = gitStatus?.recent_commits || []
  const hasUncommitted = gitStatus?.has_uncommitted

  const fullCommitMsg = `${commitPrefix}: ${commitMessage}`

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-background rounded-lg shadow-xl flex flex-col overflow-hidden"
        style={{ width: "90vw", height: "90vh", maxWidth: 1400, maxHeight: 900 }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-3 border-b border-border shrink-0">
          <div className="flex items-center gap-2">
            <GitBranchIcon className="h-4 w-4 text-primary" />
            <span className="font-semibold">版本控制</span>
            <span className="text-xs font-mono bg-muted px-2 py-0.5 rounded text-muted-foreground">
              {currentBranch}
            </span>
            {hasUncommitted && (
              <span className="flex items-center gap-1 text-[10px] text-yellow-500">
                <AlertCircle className="h-3 w-3" />
                有未提交变更
              </span>
            )}
            {!hasUncommitted && gitStatus && (
              <span className="flex items-center gap-1 text-[10px] text-green-500">
                <CheckCircle2 className="h-3 w-3" />
                干净
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {loading && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
            <button className="p-1 rounded hover:bg-muted" onClick={onClose}>
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Error bar */}
        {error && (
          <div className="px-6 py-2 bg-red-500/10 border-b border-red-500/20 text-xs text-red-500 shrink-0 flex items-center gap-2">
            <AlertCircle className="h-3 w-3 shrink-0" />
            <span className="flex-1">{error}</span>
            <button className="underline shrink-0" onClick={() => setError("")}>关闭</button>
          </div>
        )}

        {/* Body: sidebar + content */}
        <div className="flex flex-1 overflow-hidden">
          {/* Left sidebar */}
          <div className="w-44 shrink-0 border-r border-border flex flex-col bg-muted/10">
            <div className="flex flex-col gap-0.5 p-2">
              <button
                className={`flex items-center gap-2.5 px-3 py-2.5 text-sm rounded-md transition-colors text-left ${
                  tab === "graph"
                    ? "bg-accent text-accent-foreground font-medium"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
                }`}
                onClick={() => setTab("graph")}
              >
                <GitFork className="h-4 w-4 shrink-0" />
                分支图
              </button>
              <button
                className={`flex items-center gap-2.5 px-3 py-2.5 text-sm rounded-md transition-colors text-left ${
                  tab === "commit"
                    ? "bg-accent text-accent-foreground font-medium"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
                }`}
                onClick={() => setTab("commit")}
              >
                <GitCommitHorizontal className="h-4 w-4 shrink-0" />
                提交管理
              </button>
            </div>
          </div>

          {/* Right content */}
          <div className="flex-1 overflow-hidden">
            {loading && !gitStatus ? (
              <div className="flex items-center justify-center h-full">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : !gitStatus ? (
              <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
                无法加载 git 信息
              </div>
            ) : (
              <>
                {/* ── Tab: 分支图 ── */}
                {tab === "graph" && (
                  <div className="h-full flex flex-col">
                    <div className="px-5 py-3 border-b border-border shrink-0 flex items-center justify-between">
                      <p className="text-xs text-muted-foreground">
                        分支图 · 点击节点切换/回退
                      </p>
                    </div>
                    <div className="flex-1 p-4 relative">
                      {commits.length > 0 ? (
                        <div className="w-full h-full border border-border rounded-lg bg-muted/10 overflow-hidden">
                          <GitGraphView
                            commits={commits}
                            branches={branches}
                            currentBranch={currentBranch}
                            fileStatuses={fileStatuses}
                            onNodeClick={handleNodeClick}
                          />
                        </div>
                      ) : (
                        <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
                          暂无提交记录
                        </div>
                      )}

                      {/* Node context menu (self = HEAD) */}
                      {contextNode && (
                        <div className="absolute inset-0 bg-black/20 flex items-center justify-center z-10" onClick={() => { setContextNode(null); setRenaming(false); setConfirmingDelete(false) }}>
                          <div
                            className="bg-background rounded-lg shadow-xl border border-border w-80 p-4 space-y-3"
                            onClick={e => e.stopPropagation()}
                          >
                            <div className="flex items-center justify-between">
                              <h4 className="text-sm font-medium">节点操作</h4>
                              <button className="p-0.5 rounded hover:bg-muted" onClick={() => { setContextNode(null); setRenaming(false); setConfirmingDelete(false) }}>
                                <X className="h-3.5 w-3.5" />
                              </button>
                            </div>

                            <div className="text-xs text-muted-foreground space-y-1">
                              <p><span className="font-mono">{contextNode.hash}</span></p>
                              <p className="truncate">{contextNode.msg}</p>
                              {contextNode.branchName && (
                                <p className="text-[10px]">分支：{contextNode.branchName}</p>
                              )}
                            </div>

                            <div className="border-t border-border pt-2 space-y-2">
                              {/* Navigate actions (non-self nodes only) */}
                              {!contextNode.isSelf && (() => {
                                const brInfo = gitStatus?.branches?.find(b => b.name === contextNode.branchName)
                                const isBranchHead = brInfo?.commit_hash === contextNode.hash
                                return (
                                <>
                                  {isBranchHead ? (
                                    <Button
                                      variant="outline"
                                      size="sm"
                                      className="w-full justify-start"
                                      onClick={() => {
                                        setError("")
                                        if (gitStatus?.has_uncommitted) {
                                          setError("有未提交的变更，请先提交或丢弃")
                                          return
                                        }
                                        setContextNode(null)
                                        executeNavigate(contextNode.hash, contextNode.branchName!, true)
                                      }}
                                    >
                                      <GitBranchIcon className="h-3.5 w-3.5 mr-2" />
                                      切换到「{contextNode.branchName}」
                                    </Button>
                                  ) : (
                                    <>
                                      <Button
                                        variant="outline"
                                        size="sm"
                                        className="w-full justify-start"
                                        onClick={() => {
                                          setError("")
                                          if (gitStatus?.has_uncommitted) {
                                            setError("有未提交的变更，请先提交或丢弃")
                                            return
                                          }
                                          setContextNode(null)
                                          executeNavigate(contextNode.hash, contextNode.branchName!, true)
                                        }}
                                      >
                                        <GitBranchIcon className="h-3.5 w-3.5 mr-2" />
                                        切换到「{contextNode.branchName}」最新
                                      </Button>
                                      <Button
                                        variant="outline"
                                        size="sm"
                                        className="w-full justify-start"
                                        onClick={() => {
                                          setError("")
                                          if (gitStatus?.has_uncommitted) {
                                            setError("有未提交的变更，请先提交或丢弃")
                                            return
                                          }
                                          setContextNode(null)
                                          executeNavigate(contextNode.hash, contextNode.branchName!, false)
                                        }}
                                      >
                                        <CornerDownRight className="h-3.5 w-3.5 mr-2" />
                                        回退到此节点（创建临时分支）
                                      </Button>
                                    </>
                                  )}
                                </>
                                )
                              })()}

                              {/* Discard all (self node only) */}
                              {contextNode.isSelf && (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="w-full justify-start text-amber-600 hover:text-amber-600"
                                  onClick={() => {
                                    setContextNode(null)
                                    handleDiscardAll()
                                  }}
                                >
                                  <Undo2 className="h-3.5 w-3.5 mr-2" />
                                  丢弃所有未保存修改
                                </Button>
                              )}

                              {/* Rename */}
                              {!renaming ? (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="w-full justify-start"
                                  onClick={() => {
                                    setRenaming(true)
                                    setNewBranchName(contextNode.branchName || "")
                                    setConfirmingDelete(false)
                                  }}
                                >
                                  <Pencil className="h-3.5 w-3.5 mr-2" />
                                  修改分支名称
                                </Button>
                              ) : (
                                <div className="space-y-2">
                                  <Input
                                    value={newBranchName}
                                    onChange={e => setNewBranchName(e.target.value)}
                                    placeholder="新分支名称"
                                    className="text-sm"
                                    autoFocus
                                    onKeyDown={e => {
                                      if (e.key === "Enter") handleRename()
                                      if (e.key === "Escape") { setRenaming(false); setNewBranchName("") }
                                    }}
                                  />
                                  <div className="flex gap-2">
                                    <Button size="sm" variant="outline" className="flex-1" onClick={() => { setRenaming(false); setNewBranchName("") }}>
                                      取消
                                    </Button>
                                    <Button size="sm" className="flex-1" onClick={handleRename} disabled={!newBranchName.trim()}>
                                      <Pencil className="h-3.5 w-3.5 mr-1.5" />
                                      确认改名
                                    </Button>
                                  </div>
                                </div>
                              )}

                              {/* Delete node — disabled for HEAD self when it's the only commit on the branch */}
                              {(() => {
                                const cbHead = gitStatus?.branches?.find(b => b.name === contextNode.branchName)
                                // Can't delete if this is self AND the branch only has this commit
                                const isOnlyCommit = contextNode.isSelf && cbHead && cbHead.commit_hash === contextNode.hash && commits.length <= 1
                                return !confirmingDelete ? (
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    className={`w-full justify-start ${isOnlyCommit ? "text-muted-foreground cursor-not-allowed" : "text-red-500 hover:text-red-500"}`}
                                    disabled={isOnlyCommit}
                                    onClick={() => {
                                      if (isOnlyCommit) return
                                      setConfirmingDelete(true)
                                      setRenaming(false)
                                    }}
                                  >
                                    <Trash2 className="h-3.5 w-3.5 mr-2" />
                                    {isOnlyCommit ? "无法删除（唯一提交）" : "删除此节点及后续提交"}
                                  </Button>
                                ) : (
                                  <div className="space-y-2 rounded-lg border border-red-500/30 bg-red-500/5 p-3">
                                    <p className="text-xs text-red-500">
                                      此操作将删除该节点及其之后的所有提交，不可恢复。是否确认？
                                    </p>
                                    <div className="flex gap-2">
                                      <Button size="sm" variant="outline" className="flex-1" onClick={() => setConfirmingDelete(false)}>
                                        取消
                                      </Button>
                                      <Button size="sm" variant="destructive" className="flex-1" onClick={handleDeleteNode}>
                                        <Trash2 className="h-3.5 w-3.5 mr-1.5" />
                                        确认删除
                                      </Button>
                                    </div>
                                  </div>
                                )
                              })()}
                            </div>
                          </div>
                        </div>
                      )}

                      {/* Confirm navigation/reset dialog */}
                      {}
                    </div>
                  </div>
                )}

                {/* ── Tab: 提交管理 ── */}
                {tab === "commit" && (
                  <div className="h-full flex">
                    {/* Left: uncommitted files */}
                    <div className="flex-1 flex flex-col min-w-0 border-r border-border">
                      <div className="flex-1 overflow-auto p-4">
                        <h4 className="text-xs font-medium text-muted-foreground mb-3 flex items-center gap-1.5">
                          <FileText className="h-3.5 w-3.5" />
                          未提交的文件
                        </h4>
                        {filesLoading ? (
                          <div className="flex items-center justify-center py-8">
                            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                          </div>
                        ) : fileStatuses.length === 0 ? (
                          <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
                            工作区干净，没有未提交的文件
                          </div>
                        ) : (
                          <div className="space-y-0.5">
                            {fileStatuses.map(f => {
                              const info = STATUS_MAP[f.status] || { label: f.status, icon: FileText, color: "text-muted-foreground" }
                              const Icon = info.icon
                              return (
                                <div key={f.path} className="flex items-center gap-2 px-2 py-1.5 rounded text-xs hover:bg-muted/30 group">
                                  <Icon className={`h-3.5 w-3.5 shrink-0 ${info.color}`} />
                                  <span className="text-[10px] font-mono w-8 shrink-0 uppercase text-muted-foreground">{f.status}</span>
                                  <span className="flex-1 truncate">{f.path}</span>
                                  <button
                                    className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-all shrink-0"
                                    title="还原此文件"
                                    onClick={() => handleRestoreFile(f.path)}
                                  >
                                    <Undo2 className="h-3 w-3" />
                                  </button>
                                </div>
                              )
                            })}
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Right: commit form + recent commits */}
                    <div className="w-96 shrink-0 flex flex-col">
                      {/* Commit form */}
                      <div className="p-4 border-b border-border space-y-3 shrink-0">
                        <div className="flex gap-2">
                          <select
                            className="w-16 shrink-0 rounded-md border border-input bg-background px-1 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
                            value={commitPrefix}
                            onChange={e => setCommitPrefix(e.target.value as CommitType)}
                          >
                            {COMMIT_PREFIXES.map(p => (
                              <option key={p.value} value={p.value}>{p.value}</option>
                            ))}
                          </select>
                          <Input
                            value={commitMessage}
                            onChange={e => setCommitMessage(e.target.value)}
                            placeholder="提交内容描述"
                            className="flex-1 text-sm"
                            onKeyDown={e => { if (e.key === "Enter" && !committing && fullCommitMsg.length > 2) handleCommit() }}
                          />
                        </div>
                        <p className="text-[10px] text-muted-foreground font-mono">
                          完整消息：{fullCommitMsg || <span className="text-muted-foreground/50">（输入内容后自动拼接）</span>}
                        </p>

                        <Button
                          onClick={handleCommit}
                          disabled={fullCommitMsg.length <= 2 || committing}
                          className="w-full"
                        >
                          {committing ? (
                            <Loader2 className="h-4 w-4 animate-spin mr-1.5" />
                          ) : (
                            <Save className="h-4 w-4 mr-1.5" />
                          )}
                          提交
                        </Button>

                        <div className="space-y-2">
                          <label className="flex items-center gap-2 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={commitAndBranch}
                              onChange={e => setCommitAndBranch(e.target.checked)}
                              className="rounded border-border"
                            />
                            <span className="text-xs text-muted-foreground">提交并创建新分支</span>
                          </label>
                          {commitAndBranch && (
                            <Input
                              value={commitBranchName}
                              onChange={e => setCommitBranchName(e.target.value)}
                              placeholder="新分支名称"
                              className="text-sm"
                            />
                          )}
                        </div>
                      </div>

                      {/* Recent commits */}
                      <div className="flex-1 overflow-auto p-3">
                        <h4 className="text-xs font-medium text-muted-foreground mb-3 flex items-center gap-1.5">
                          <History className="h-3.5 w-3.5" />
                          最近提交
                        </h4>
                        {commits.length === 0 ? (
                          <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
                            暂无提交
                          </div>
                        ) : (
                          <div className="space-y-1">
                            {commits.map((c, idx) => {
                              const { type } = commitTypeLabel(c.message)
                              return (
                                <div
                                  key={c.hash}
                                  className={`rounded-lg border p-3 text-xs space-y-1.5 transition-colors hover:bg-muted/20 ${
                                    idx === 0 ? "border-primary/30 bg-primary/5" : "border-border"
                                  }`}
                                >
                                  <div className="flex items-center gap-1.5">
                                    <CommitTypeIcon type={type} />
                                    <span className="font-mono text-[10px] text-muted-foreground">{c.hash}</span>
                                    {idx === 0 && (
                                      <span className="text-[9px] bg-primary/10 text-primary px-1 rounded ml-auto">最新</span>
                                    )}
                                  </div>
                                  <p className="leading-relaxed">{c.message}</p>
                                  <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                                    <span>{c.author}</span>
                                    <span>{c.date?.slice(0, 10)}</span>
                                  </div>
                                </div>
                              )
                            })}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function CommitTypeIcon({ type }: { type: CommitType | "其他" }) {
  const cls = "h-3 w-3 shrink-0"
  if (type === "楼层") return <GitCommitHorizontal className={`${cls} text-indigo-500`} />
  if (type === "总结") return <CheckCircle2 className={`${cls} text-emerald-500`} />
  if (type === "暂存") return <Save className={`${cls} text-amber-500`} />
  return <GitCommitHorizontal className={`${cls} text-muted-foreground`} />
}

// ─── ReactFlow Git Graph ───

import dagre from "dagre"

const COMMIT_NODE_TYPE = "commitNode"

interface GitGraphViewProps {
  commits: GitLogEntry[]
  branches: GitBranch[]
  currentBranch: string
  fileStatuses: GitFileStatus[]
  onNodeClick: (hash: string, msg: string, isCurrentHead: boolean, isOnCurrentBranch: boolean, branchName: string) => void
}

function GitGraphView({ commits, branches, currentBranch, fileStatuses, onNodeClick }: GitGraphViewProps) {
  const { nodes, edges } = useMemo(() => {
    // Map hash → list of branches pointing to it
    const hashToBranches = new Map<string, string[]>()
    for (const b of branches) {
      const list = hashToBranches.get(b.commit_hash) || []
      list.push(b.name)
      hashToBranches.set(b.commit_hash, list)
    }

    // Determine which commits are on the current branch (walk back from HEAD)
    const currentBranchCommits = new Set<string>()
    if (currentBranch) {
      const cbInfo = branches.find(b => b.name === currentBranch)
      if (cbInfo) {
        const headCommit = commits.find(c => c.hash === cbInfo.commit_hash)
        if (headCommit) {
          const visited = new Set<string>()
          const queue = [headCommit]
          while (queue.length > 0) {
            const c = queue.shift()!
            if (visited.has(c.hash)) continue
            visited.add(c.hash)
            currentBranchCommits.add(c.hash)
            for (const parentHash of c.parents) {
              const parent = commits.find(p => p.hash === parentHash)
              if (parent) queue.push(parent)
            }
          }
        }
      }
    }

    // Build nodes and edges with dagre layout
    const nodeList: Node[] = []
    const edgeList: Edge[] = []

    // Deduplicate commits by hash (in case --all returns duplicates)
    const seen = new Set<string>()
    const uniqueCommits = commits.filter(c => {
      if (seen.has(c.hash)) return false
      seen.add(c.hash)
      return true
    })

    // Assign each commit to a branch name (for display labels, NOT for color)
    const hashToBranch = new Map<string, string>()
    for (const c of uniqueCommits) {
      const refs = hashToBranches.get(c.hash) || []
      if (currentBranchCommits.has(c.hash)) {
        hashToBranch.set(c.hash, currentBranch)
      } else if (refs.length > 0) {
        hashToBranch.set(c.hash, refs[0])
      } else if (c.parents.length > 0) {
        hashToBranch.set(c.hash, hashToBranch.get(c.parents[0]) || currentBranch)
      } else {
        hashToBranch.set(c.hash, currentBranch)
      }
    }

    // Dagre: rankdir=TB (top to bottom), nodesep for vertical spacing
    const g = new dagre.graphlib.Graph()
    g.setDefaultEdgeLabel(() => ({}))
    g.setGraph({ rankdir: "TB", nodesep: 40, ranksep: 40, marginx: 20, marginy: 20 })

    const NODE_W = 180
    const NODE_H = 52

    for (const c of uniqueCommits) {
      g.setNode(c.hash, { width: NODE_W, height: NODE_H })
    }

    for (const c of uniqueCommits) {
      for (const parent of c.parents) {
        g.setEdge(parent, c.hash)
      }
    }

    dagre.layout(g)

    for (const c of uniqueCommits) {
      const refs = hashToBranches.get(c.hash) || []
      const branchName = hashToBranch.get(c.hash) || currentBranch
      const isOnCurrentBranch = currentBranchCommits.has(c.hash)
      const { type } = commitTypeLabel(c.message)
      // Color by commit type (when on current branch), otherwise gray
      const activeColor = type === "总结" ? "#22c55e" : type === "暂存" ? "#f59e0b" : "#a855f7"
      const bgColor = isOnCurrentBranch ? activeColor : "#9ca3af"
      const nodeW = type === "总结" ? 110 : 180
      const isBranchHead = refs.length > 0
      const isHead = isBranchHead && refs.includes(currentBranch)
      const isHeadOfAny = refs.length > 0

      // Check if this is the latest commit on any of its branches
      let isLatestOnAnyBranch = false
      for (const ref of refs) {
        const b = branches.find(b => b.name === ref)
        if (b && b.commit_hash === c.hash) { isLatestOnAnyBranch = true; break }
      }

      const dagreNode = g.node(c.hash)

      nodeList.push({
        id: c.hash,
        type: COMMIT_NODE_TYPE,
        position: { x: dagreNode.x - nodeW / 2, y: dagreNode.y - NODE_H / 2 },
        data: {
          hash: c.hash,
          message: c.message,
          commitType: type,
          date: c.date?.slice(0, 10) || "",
          isLatest: isLatestOnAnyBranch,
          isBranchHead,
          branchRefs: refs,
          branchName,
          currentBranch,
          bgColor,
          nodeW,
          isOnCurrentBranch,
          isCurrentBranchHead: isHead && isLatestOnAnyBranch,
          onNodeClick,
        },
      })
    }

    // Edges: color follows the child commit's branch status
    for (const c of uniqueCommits) {
      const isOnCurrentBranch = currentBranchCommits.has(c.hash)
      const edgeColor = isOnCurrentBranch ? "#a855f7" : "#9ca3af"
      for (const parent of c.parents) {
        edgeList.push({
          id: `${c.hash}->${parent}`,
          source: parent,
          target: c.hash,
          type: "smoothstep",
          style: { stroke: edgeColor, strokeWidth: 2, opacity: isOnCurrentBranch ? 0.7 : 0.25 },
        })
      }
    }

    return { nodes: nodeList, edges: edgeList }
  }, [commits, branches, currentBranch, onNodeClick])

  if (nodes.length === 0) {
    return <div className="flex items-center justify-center h-full text-sm text-muted-foreground">暂无提交记录</div>
  }

  return (
    <div className="relative w-full h-full">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        attributionPosition="bottom-left"
        minZoom={0.3}
        maxZoom={2}
        panOnDrag
        zoomOnScroll
        selectNodesOnDrag={false}
      >
        <Background gap={20} size={1} />
        <Controls showInteractive={false} />
        <MiniMap
          nodeColor={(n) => {
            const d = n.data as CommitNodeData
            if (!d.isOnCurrentBranch) return `${d.bgColor}40`
            return d.bgColor
          }}
          style={{ width: 120, height: 80 }}
        />
      </ReactFlow>
    </div>
  )
}

interface CommitNodeData {
  hash: string
  message: string
  commitType: CommitType | "其他"
  date: string
  isLatest: boolean
  isBranchHead: boolean
  branchRefs: string[]
  branchName: string
  currentBranch: string
  bgColor: string
  nodeW: number
  isOnCurrentBranch: boolean
  isCurrentBranchHead: boolean
  onNodeClick: (hash: string, msg: string, isCurrentHead: boolean, isOnCurrentBranch: boolean, branchName: string) => void
}

function CommitNode({ data }: NodeProps<CommitNodeData>) {
  const isDim = !data.isOnCurrentBranch

  return (
    <div
      className={`rounded-lg border-2 bg-background shadow-sm hover:shadow-md transition-all cursor-pointer ${
        isDim ? "opacity-35 hover:opacity-65" : ""
      }`}
      style={{ borderColor: data.bgColor, width: data.nodeW }}
      onClick={() => data.onNodeClick(data.hash, data.message, data.isCurrentBranchHead, data.isOnCurrentBranch, data.branchName)}
    >
      <Handle type="target" position={Position.Top} style={{ background: data.bgColor, width: 7, height: 7 }} />
      <div className="px-2.5 py-1.5 space-y-0.5">
        {/* Line 1: hash + branch name + date */}
        <div className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full shrink-0" style={{ background: data.bgColor }} />
          <span className="text-[10px] font-mono font-medium">{data.hash}</span>
          {data.branchRefs.length > 0 && (
            <span className="text-[8px] font-mono bg-muted/60 text-muted-foreground px-1 rounded truncate max-w-[70px]">
              {data.branchRefs[0]}
            </span>
          )}
          <span className="text-[8px] text-muted-foreground ml-auto">{data.date.slice(5)}</span>
        </div>
        {/* Line 2: type + HEAD */}
        <div className="flex items-center gap-1 min-h-[18px]">
          {data.commitType === "楼层" && (
            <span className="text-[11px] leading-tight truncate">{data.message}</span>
          )}
          {data.commitType === "总结" && (
            <div className="flex items-center gap-1 text-[10px] text-emerald-600 dark:text-emerald-400">
              <CheckCircle2 className="h-2.5 w-2.5" />
              <span>总结</span>
            </div>
          )}
          {data.commitType === "暂存" && (
            <span className="text-[11px] leading-tight truncate text-amber-600 dark:text-amber-400">{data.message}</span>
          )}
          {data.commitType === "其他" && (
            <span className="text-[10px] text-muted-foreground truncate">{data.message}</span>
          )}
          {data.isCurrentBranchHead && (
            <span className="text-[8px] bg-primary/10 text-primary font-medium px-1 rounded ml-auto">HEAD</span>
          )}
        </div>
      </div>
      <Handle type="source" position={Position.Bottom} style={{ background: data.bgColor, width: 7, height: 7 }} />
    </div>
  )
}

const nodeTypes = { [COMMIT_NODE_TYPE]: CommitNode }
