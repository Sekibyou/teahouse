import { useEffect, useState, useCallback, useMemo } from "react"
import { useTranslation } from "react-i18next"
import {
  GitBranch as GitBranchIcon, GitCommitHorizontal, Loader2,
  CheckCircle2, AlertCircle, X, GitFork,
  History, FileText, FilePlus, FileMinus, FileEdit,
  Save, Trash2, Pencil, CornerDownRight, Undo2, ChevronLeft,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useIsMobile } from "@/hooks/useMediaQuery"
import { useDialogBackClose } from "@/hooks/useDialogBackClose"
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
  { value: "floor" },
  { value: "summary" },
  { value: "other" },
] as const

type CommitType = (typeof COMMIT_PREFIXES)[number]["value"]

function commitTypeLabel(msg: string): { type: CommitType; display: string } {
  if (/^floor-\d+:/.test(msg)) return { type: "floor", display: msg }
  if (msg.startsWith("summary-")) return { type: "summary", display: msg }
  return { type: "other", display: msg }
}

const STATUS_MAP: Record<string, { icon: typeof FileText; color: string }> = {
  M: { icon: FileEdit, color: "text-yellow-500" },
  A: { icon: FilePlus, color: "text-green-500" },
  D: { icon: FileMinus, color: "text-red-500" },
  "?": { icon: FilePlus, color: "text-blue-500" },
  R: { icon: FileEdit, color: "text-purple-500" },
}

function nextTempName(): string {
  return `temp-${Date.now().toString(36)}`
}

export function GitDialog({ instanceId, open, onClose, onRefresh }: GitDialogProps) {
  const { t } = useTranslation("git")
  const isMobile = useIsMobile()
  useDialogBackClose(open, onClose)
  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const [fileStatuses, setFileStatuses] = useState<GitFileStatus[]>([])
  const [filesLoading, setFilesLoading] = useState(false)

  // Commit form
  const [commitPrefix, setCommitPrefix] = useState<CommitType>("floor")
  const [commitMessage, setCommitMessage] = useState("")
  const [floorNumber, setFloorNumber] = useState<number>(1)
  const [summaryStart, setSummaryStart] = useState<number>(1)
  const [summaryEnd, setSummaryEnd] = useState<number>(1)
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
      setError(res.error || t("error.loadStatus"))
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
    const message = commitMessage.trim()
    if (message.length === 0) return

    const params: { type: string; number?: number; start?: number; end?: number; message: string } = {
      type: commitPrefix,
      message,
    }
    if (commitPrefix === "floor") {
      params.number = floorNumber
    } else if (commitPrefix === "summary") {
      params.start = summaryStart
      params.end = summaryEnd
    }

    setCommitting(true)
    setError("")

    if (commitAndBranch && commitBranchName.trim()) {
      const brRes = await gitApi.branch(instanceId, "create", commitBranchName.trim())
      if (!brRes.ok) {
        setError(brRes.error || t("error.createBranch"))
        setCommitting(false)
        return
      }
    }

    const res = await gitApi.commit(instanceId, params)
    if (res.ok) {
      setCommitMessage("")
      setCommitBranchName("")
      setCommitAndBranch(false)
      await loadStatus()
      await loadFileStatuses()
      onRefresh()
    } else {
      setError(res.error || t("error.commit"))
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
        if (!swRes.ok) throw new Error(swRes.error || t("error.switch"))
      } else {
        await gitApi.branch(instanceId, "create", tempName, hash)
        await gitApi.branch(instanceId, "switch", tempName)
      }
      await loadStatus()
      await loadFileStatuses()
      onRefresh()
    } catch (e: any) {
      setError(e.message || t("error.operation"))
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
      setError(res.error || t("error.rename"))
    }
  }

  const handleDeleteNode = async () => {
    if (!contextNode) return
    setError("")
    if (!contextNode.isOnCurrentBranch) {
      const swRes = await gitApi.branch(instanceId, "switch", contextNode.branchName!)
      if (!swRes.ok) {
        setError(swRes.error || t("error.switchBranch"))
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
      setError(res.error || t("error.delete"))
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
      setError(res.error || t("error.discard"))
    }
  }

  const handleRestoreFile = async (filePath: string) => {
    setError("")
    const res = await gitApi.discard(instanceId, filePath)
    if (res.ok) {
      await loadFileStatuses()
      await loadStatus()
      onRefresh()
    } else {
      setError(res.error || t("error.restore"))
    }
  }

  if (!open) return null

  const currentBranch = gitStatus?.current_branch || "main"
  const branches = gitStatus?.branches || []
  const commits = gitStatus?.recent_commits || []
  const hasUncommitted = gitStatus?.has_uncommitted

  const fullCommitMsg = (() => {
    const msg = commitMessage.trim()
    if (!msg) return ""
    if (commitPrefix === "floor") return `floor-${floorNumber}: ${msg}`
    if (commitPrefix === "summary") {
      if (summaryStart === summaryEnd) return `summary-${summaryStart}: ${msg}`
      return `summary-${summaryStart}-${summaryEnd}: ${msg}`
    }
    return `other: ${msg}`
  })()

  return (
    <div
      className={`fixed inset-0 z-50 ${isMobile ? "bg-background" : "bg-background/70 backdrop-blur-lg flex items-center justify-center"}`}
      onClick={onClose}
    >
      <div
        className={`flex flex-col overflow-hidden ${isMobile
          ? "h-full w-full"
          : "bg-background rounded-lg shadow-xl"
        }`}
        style={
          isMobile
            ? undefined
            : { width: "90vw", height: "90vh", maxWidth: 1400, maxHeight: 900 }
        }
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        {isMobile ? (
          <div className="relative h-10 border-b border-border flex items-center justify-center shrink-0 z-10">
            <button
              className="absolute left-2 p-2 rounded hover:bg-muted flex items-center justify-center"
              onClick={onClose}
              aria-label={t("aria.back")}
            >
              <ChevronLeft className="h-5 w-5" />
            </button>
            <span className="font-semibold text-sm">{t("title")}</span>
            <span className="absolute right-2 flex items-center gap-2">
              {loading && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
              {hasUncommitted ? (
                <span className="flex items-center gap-1 text-[10px] text-yellow-500">
                  <AlertCircle className="h-3 w-3" />
                </span>
              ) : (null)}
            </span>
          </div>
        ) : (
          <div className="flex items-center justify-between px-6 py-3 border-b border-border shrink-0">
            <div className="flex items-center gap-2">
              <GitBranchIcon className="h-4 w-4 text-primary" />
              <span className="font-semibold">{t("title")}</span>
              <span className="text-xs font-mono bg-muted px-2 py-0.5 rounded text-muted-foreground">
                {currentBranch}
              </span>
              {hasUncommitted && (
                <span className="flex items-center gap-1 text-[10px] text-yellow-500">
                  <AlertCircle className="h-3 w-3" />
                  {t("status.dirty")}
                </span>
              )}
              {!hasUncommitted && gitStatus && (
                <span className="flex items-center gap-1 text-[10px] text-green-500">
                  <CheckCircle2 className="h-3 w-3" />
                  {t("status.clean")}
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
        )}

        {/* Error bar */}
        {error && (
          <div className="px-6 py-2 bg-red-500/10 border-b border-red-500/20 text-xs text-red-500 shrink-0 flex items-center gap-2">
            <AlertCircle className="h-3 w-3 shrink-0" />
            <span className="flex-1">{error}</span>
            <button className="underline shrink-0" onClick={() => setError("")}>{t("error.close")}</button>
          </div>
        )}

        {/* Body: tab selector + content */}
        <div className={`flex-1 overflow-hidden ${isMobile ? "flex flex-col" : "flex"}`}>
          {/* Tab selector — vertical sidebar (desktop) or horizontal bar (mobile) */}
          {isMobile ? (
            <div className="shrink-0 border-b border-border flex bg-muted/10">
              <button
                className={`flex-1 flex items-center justify-center gap-2 px-3 py-2.5 text-sm transition-colors ${
                  tab === "graph"
                    ? "bg-accent text-accent-foreground font-medium"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
                }`}
                onClick={() => setTab("graph")}
              >
                <GitFork className="h-4 w-4 shrink-0" />
                {t("tab.graph")}
              </button>
              <button
                className={`flex-1 flex items-center justify-center gap-2 px-3 py-2.5 text-sm transition-colors ${
                  tab === "commit"
                    ? "bg-accent text-accent-foreground font-medium"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
                }`}
                onClick={() => setTab("commit")}
              >
                <GitCommitHorizontal className="h-4 w-4 shrink-0" />
                {t("tab.commit")}
              </button>
            </div>
          ) : (
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
                  {t("tab.graph")}
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
                  {t("tab.commit")}
                </button>
              </div>
            </div>
          )}

          {/* Right content */}
          <div className="flex-1 overflow-hidden">
            {loading && !gitStatus ? (
              <div className="flex items-center justify-center h-full">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : !gitStatus ? (
              <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
                {t("graph.loadFail")}
              </div>
            ) : (
              <>
                {/* ── Tab: 分支图 ── */}
                {tab === "graph" && (
                  <div className="h-full flex flex-col">
                    <div className="px-5 py-3 border-b border-border shrink-0 flex items-center justify-between">
                      <p className="text-xs text-muted-foreground">
                        {t("graph.hint")}
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
                          {t("commit.empty")}
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
                              <h4 className="text-sm font-medium">{t("node.title")}</h4>
                              <button className="p-0.5 rounded hover:bg-muted" onClick={() => { setContextNode(null); setRenaming(false); setConfirmingDelete(false) }}>
                                <X className="h-3.5 w-3.5" />
                              </button>
                            </div>

                            <div className="text-xs text-muted-foreground space-y-1">
                              <p><span className="font-mono">{contextNode.hash}</span></p>
                              <p className="truncate">{contextNode.msg}</p>
                              {contextNode.branchName && (
                                <p className="text-[10px]">{t("node.branchLabel", { branch: contextNode.branchName })}</p>
                              )}
                            </div>

                            <div className="border-t border-border pt-3 space-y-2">
                              {/* Navigate actions (non-self nodes only) */}
                              {!contextNode.isSelf && (() => {
                                const brInfo = gitStatus?.branches?.find(b => b.name === contextNode.branchName)
                                const isBranchHead = brInfo?.commit_hash === contextNode.hash
                                return (
                                <>
                                  <Button
                                    size="default"
                                    className="w-full justify-start"
                                    onClick={() => {
                                      setError("")
                                      if (gitStatus?.has_uncommitted) {
                                        setError(t("node.uncommittedWarn"))
                                        return
                                      }
                                      setContextNode(null)
                                      executeNavigate(contextNode.hash, contextNode.branchName!, true)
                                    }}
                                  >
                                    <GitBranchIcon className="h-4 w-4 mr-2" />
                                    {t("node.switch", { branch: contextNode.branchName })}
                                  </Button>
                                  {!isBranchHead && (
                                    <Button
                                      variant="secondary"
                                      size="default"
                                      className="w-full justify-start"
                                      onClick={() => {
                                        setError("")
                                        if (gitStatus?.has_uncommitted) {
                                          setError(t("node.uncommittedWarn"))
                                          return
                                        }
                                        setContextNode(null)
                                        executeNavigate(contextNode.hash, contextNode.branchName!, false)
                                      }}
                                    >
                                      <CornerDownRight className="h-4 w-4 mr-2" />
                                      {t("node.reset")}
                                    </Button>
                                  )}
                                </>
                                )
                              })()}

                              {/* Discard all (self node only) */}
                              {contextNode.isSelf && (
                                <Button
                                  variant="secondary"
                                  size="default"
                                  className="w-full justify-start"
                                  onClick={() => {
                                    setContextNode(null)
                                    handleDiscardAll()
                                  }}
                                >
                                  <Undo2 className="h-4 w-4 mr-2" />
                                  {t("node.discardAll")}
                                </Button>
                              )}

                              {/* Secondary actions row */}
                              <div className="flex gap-2 pt-1">
                                {/* Rename */}
                                {!renaming ? (
                                  <button
                                    className="flex-1 flex items-center justify-center gap-1 py-1.5 rounded text-xs text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                                    onClick={() => {
                                      setRenaming(true)
                                      setNewBranchName(contextNode.branchName || "")
                                      setConfirmingDelete(false)
                                    }}
                                  >
                                    <Pencil className="h-3 w-3" />
                                    {t("node.rename")}
                                  </button>
                                ) : (
                                  <div className="flex-[2] space-y-2">
                                    <Input
                                      value={newBranchName}
                                      onChange={e => setNewBranchName(e.target.value)}
                                      placeholder={t("branch.namePlaceholder")}
                                      className="text-sm h-7"
                                      autoFocus
                                      onKeyDown={e => {
                                        if (e.key === "Enter") handleRename()
                                        if (e.key === "Escape") { setRenaming(false); setNewBranchName("") }
                                      }}
                                    />
                                    <div className="flex gap-2">
                                      <Button size="sm" variant="outline" className="flex-1" onClick={() => { setRenaming(false); setNewBranchName("") }}>
                                        {t("common.cancel")}
                                      </Button>
                                      <Button size="sm" className="flex-1" onClick={handleRename} disabled={!newBranchName.trim()}>
                                        {t("common.confirm")}
                                      </Button>
                                    </div>
                                  </div>
                                )}

                                {/* Delete node */}
                                {(() => {
                                  const cbHead = gitStatus?.branches?.find(b => b.name === contextNode.branchName)
                                  const isOnlyCommit = contextNode.isSelf && cbHead && cbHead.commit_hash === contextNode.hash && commits.length <= 1
                                  return !confirmingDelete ? (
                                    <button
                                      className={`flex-1 flex items-center justify-center gap-1 py-1.5 rounded text-xs transition-colors ${
                                        isOnlyCommit
                                          ? "text-muted-foreground/50 cursor-not-allowed"
                                          : "text-red-500 hover:text-red-400 hover:bg-red-500/10"
                                      }`}
                                      disabled={isOnlyCommit}
                                      onClick={() => {
                                        if (isOnlyCommit) return
                                        setConfirmingDelete(true)
                                        setRenaming(false)
                                      }}
                                    >
                                      <Trash2 className="h-3 w-3" />
                                      {isOnlyCommit ? t("node.cantDelete") : t("node.delete")}
                                    </button>
                                  ) : (
                                    <div className="flex-[2] space-y-2 rounded-lg border border-red-500/30 bg-red-500/5 p-2">
                                      <p className="text-xs text-red-500">
                                        {t("node.deleteConfirm")}
                                      </p>
                                      <div className="flex gap-2">
                                        <Button size="sm" variant="outline" className="flex-1" onClick={() => setConfirmingDelete(false)}>
                                          {t("common.cancel")}
                                        </Button>
                                        <Button size="sm" variant="destructive" className="flex-1" onClick={handleDeleteNode}>
                                          {t("node.deleteConfirmBtn")}
                                        </Button>
                                      </div>
                                    </div>
                                  )
                                })()}
                              </div>
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
                  <div className={`flex-1 overflow-hidden ${isMobile ? "flex flex-col" : "flex"}`}>
                    {/* Left: uncommitted files */}
                    <div className={`flex-1 flex flex-col min-w-0 ${isMobile ? "" : "border-r border-border"}`}>
                      <div className="flex-1 overflow-auto p-4">
                        <h4 className="text-xs font-medium text-muted-foreground mb-3 flex items-center gap-1.5">
                          <FileText className="h-3.5 w-3.5" />
                          {t("commit.uncommittedTitle")}
                        </h4>
                        {filesLoading ? (
                          <div className="flex items-center justify-center py-8">
                            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                          </div>
                        ) : fileStatuses.length === 0 ? (
                          <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
                            {t("commit.clean")}
                          </div>
                        ) : (
                          <div className="space-y-0.5">
                            {fileStatuses.map(f => {
                              const info = STATUS_MAP[f.status] || { icon: FileText, color: "text-muted-foreground" }
                              const Icon = info.icon
                              return (
                                <div key={f.path} className="flex items-center gap-2 px-2 py-1.5 rounded text-xs hover:bg-muted/30 group">
                                  <Icon className={`h-3.5 w-3.5 shrink-0 ${info.color}`} />
                                  <span className="text-[10px] font-mono w-8 shrink-0 uppercase text-muted-foreground">{f.status}</span>
                                  <span className="flex-1 truncate">{f.path}</span>
                                  <button
                                    className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-all shrink-0"
                                    title={t("commit.restoreTip")}
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
                    <div className={`shrink-0 flex flex-col ${isMobile ? "flex-1 border-t border-border" : "w-96"}`}>
                      {/* Commit form */}
                      <div className="p-4 border-b border-border space-y-3 shrink-0">
                        <div className="flex gap-2">
                          <select
                            className="w-20 shrink-0 rounded-md border border-input bg-background px-1 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
                            value={commitPrefix}
                            onChange={e => setCommitPrefix(e.target.value as CommitType)}
                          >
                            {COMMIT_PREFIXES.map(p => (
                              <option key={p.value} value={p.value}>{t(`commit.type.${p.value}`)}</option>
                            ))}
                          </select>
                          <Input
                            value={commitMessage}
                            onChange={e => setCommitMessage(e.target.value)}
                            placeholder={t("commit.msgPlaceholder")}
                            className="flex-1 text-sm"
                            onKeyDown={e => { if (e.key === "Enter" && !committing && fullCommitMsg.length > 2) handleCommit() }}
                          />
                        </div>
                        {commitPrefix === "floor" && (
                          <div className="flex items-center gap-2">
                            <label className="text-xs text-muted-foreground shrink-0">{t("commit.floorNumber")}</label>
                            <Input
                              type="number"
                              value={floorNumber}
                              onChange={e => setFloorNumber(Number(e.target.value))}
                              className="w-24 text-sm"
                              min={1}
                            />
                          </div>
                        )}
                        {commitPrefix === "summary" && (
                          <div className="flex items-center gap-2">
                            <label className="text-xs text-muted-foreground shrink-0">{t("commit.startFloor")}</label>
                            <Input
                              type="number"
                              value={summaryStart}
                              onChange={e => setSummaryStart(Number(e.target.value))}
                              className="w-24 text-sm"
                              min={1}
                            />
                            <label className="text-xs text-muted-foreground shrink-0">{t("commit.endFloor")}</label>
                            <Input
                              type="number"
                              value={summaryEnd}
                              onChange={e => setSummaryEnd(Number(e.target.value))}
                              className="w-24 text-sm"
                              min={1}
                            />
                          </div>
                        )}
                        <p className="text-[10px] text-muted-foreground font-mono">
                          {t("commit.fullMsg")}: {fullCommitMsg || <span className="text-muted-foreground/50">{t("commit.autoJoin")}</span>}
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
                          {t("commit.button")}
                        </Button>

                        <div className="space-y-2">
                          <label className="flex items-center gap-2 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={commitAndBranch}
                              onChange={e => setCommitAndBranch(e.target.checked)}
                              className="rounded border-border"
                            />
                            <span className="text-xs text-muted-foreground">{t("commit.andBranch")}</span>
                          </label>
                          {commitAndBranch && (
                            <Input
                              value={commitBranchName}
                              onChange={e => setCommitBranchName(e.target.value)}
                              placeholder={t("branch.namePlaceholder")}
                              className="text-sm"
                            />
                          )}
                        </div>
                      </div>

                      {/* Recent commits */}
                      <div className="flex-1 overflow-auto p-3">
                        <h4 className="text-xs font-medium text-muted-foreground mb-3 flex items-center gap-1.5">
                          <History className="h-3.5 w-3.5" />
                          {t("commit.recentTitle")}
                        </h4>
                        {commits.length === 0 ? (
                          <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
                            {t("commit.empty")}
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
                                      <span className="text-[9px] bg-primary/10 text-primary px-1 rounded ml-auto">{t("commit.latest")}</span>
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

function CommitTypeIcon({ type }: { type: CommitType }) {
  const cls = "h-3 w-3 shrink-0"
  if (type === "floor") return <GitCommitHorizontal className={`${cls} text-purple-500`} />
  if (type === "summary") return <CheckCircle2 className={`${cls} text-emerald-500`} />
  return <GitCommitHorizontal className={`${cls} text-amber-500`} />
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

function GitGraphView({ commits, branches, currentBranch, onNodeClick }: GitGraphViewProps) {
  const { t } = useTranslation("git")
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
    // Strategy: walk back from each branch HEAD; nodes on the current branch
    // get the current branch name; other-branch nodes get their branch's name.
    const hashToBranch = new Map<string, string>()
    // First pass: walk back from every other branch's HEAD
    for (const b of branches) {
      if (b.name === currentBranch) continue
      const headCommit = commits.find(c => c.hash === b.commit_hash)
      if (!headCommit) continue
      const visited = new Set<string>()
      const queue = [headCommit]
      while (queue.length > 0) {
        const c = queue.shift()!
        if (visited.has(c.hash)) continue
        visited.add(c.hash)
        // Only label if not already on the current branch
        if (!currentBranchCommits.has(c.hash)) {
          if (!hashToBranch.has(c.hash)) {
            hashToBranch.set(c.hash, b.name)
          }
        } else {
          continue // stop at current-branch boundary
        }
        for (const parentHash of c.parents) {
          const parent = commits.find(p => p.hash === parentHash)
          if (parent) queue.push(parent)
        }
      }
    }
    // Second pass: remaining unlabeled nodes default to currentBranch
    for (const c of uniqueCommits) {
      if (!hashToBranch.has(c.hash)) {
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
      const activeColor = type === "floor" ? "#a855f7" : type === "summary" ? "#22c55e" : "#f59e0b"
      const bgColor = isOnCurrentBranch ? activeColor : "#9ca3af"
      const nodeW = type === "summary" ? 110 : 180
      const isBranchHead = refs.length > 0
      const isHead = isBranchHead && refs.includes(currentBranch)

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

    // Edges: always gray
    for (const c of uniqueCommits) {
      const edgeColor = "#9ca3af"
      for (const parent of c.parents) {
        edgeList.push({
          id: `${c.hash}->${parent}`,
          source: parent,
          target: c.hash,
          type: "smoothstep",
          style: { stroke: edgeColor, strokeWidth: 2, opacity: 0.35 },
        })
      }
    }

    return { nodes: nodeList, edges: edgeList }
  }, [commits, branches, currentBranch, onNodeClick])

  if (nodes.length === 0) {
    return <div className="flex items-center justify-center h-full text-sm text-muted-foreground">{t("commit.empty")}</div>
  }

  return (
    <div className="relative w-full h-full">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        proOptions={{ hideAttribution: true }}
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
  commitType: CommitType
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
  const { t } = useTranslation("git")
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
        {/* Line 2: type label + message + HEAD */}
        <div className="flex items-center gap-1 min-h-[18px]">
          {data.commitType === "floor" && (
            <span className="text-[10px] font-medium text-purple-600 dark:text-purple-400 bg-purple-500/10 px-1 rounded shrink-0">{t("commit.type.floor")}</span>
          )}
          {data.commitType === "summary" && (
            <span className="text-[10px] font-medium text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 px-1 rounded shrink-0">{t("commit.type.summary")}</span>
          )}
          <span className="text-[11px] leading-tight truncate">{data.message}</span>
          {data.isCurrentBranchHead && (
            <span className="text-[8px] bg-primary/10 text-primary font-medium px-1 rounded ml-auto shrink-0">HEAD</span>
          )}
        </div>
      </div>
      <Handle type="source" position={Position.Bottom} style={{ background: data.bgColor, width: 7, height: 7 }} />
    </div>
  )
}

const nodeTypes = { [COMMIT_NODE_TYPE]: CommitNode }
