import { useEffect, useState, useCallback, useMemo } from "react"
import {
  GitBranch as GitBranchIcon, GitCommitHorizontal, Loader2,
  CheckCircle2, AlertCircle, X, RotateCcw, GitFork, Plus,
  History, ArrowLeftRight,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { gitApi } from "@/lib/api"
import type { GitStatus, GitBranch, GitLogEntry } from "@/lib/types"
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

export function GitDialog({ instanceId, open, onClose, onRefresh }: GitDialogProps) {
  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")

  // Commit form
  const [commitMessage, setCommitMessage] = useState("")
  const [committing, setCommitting] = useState(false)

  // Branch form
  const [branchAction, setBranchAction] = useState<"create" | "switch">("create")
  const [branchName, setBranchName] = useState("")
  const [branching, setBranching] = useState(false)

  // Revert form
  const [revertTargetHash, setRevertTargetHash] = useState("")
  const [revertTargetMsg, setRevertTargetMsg] = useState("")
  const [showRevertConfirm, setShowRevertConfirm] = useState(false)

  // Active tab
  const [tab, setTab] = useState<"graph" | "commit" | "branch">("graph")

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

  useEffect(() => {
    if (open) loadStatus()
  }, [open, loadStatus])

  const handleCommit = async () => {
    if (!commitMessage.trim()) return
    setCommitting(true)
    setError("")
    const res = await gitApi.commit(instanceId, commitMessage.trim())
    if (res.ok) {
      setCommitMessage("")
      await loadStatus()
      onRefresh()
    } else {
      setError(res.error || "提交失败")
    }
    setCommitting(false)
  }

  const handleBranch = async () => {
    if (branchAction === "create" && !branchName.trim()) return
    setBranching(true)
    setError("")
    const res = await gitApi.branch(instanceId, branchAction, branchName.trim() || undefined)
    if (res.ok) {
      setBranchName("")
      await loadStatus()
      onRefresh()
    } else {
      setError(res.error || "分支操作失败")
    }
    setBranching(false)
  }

  const handleRevertCheckout = async (hash: string, msg: string) => {
    setRevertTargetHash(hash)
    setRevertTargetMsg(msg)
    setShowRevertConfirm(true)
  }

  const confirmRevertCheckout = async () => {
    if (!revertTargetHash) return
    setError("")
    // 基于历史 commit 创建新分支回档
    const branchName = `revert-${revertTargetHash}`
    const res = await gitApi.branch(instanceId, "create", branchName)
    if (res.ok) {
      // checkout 到该 commit 后重置 HEAD
      // 用 git reset --hard 到目标 commit
      const resetRes = await gitApi.branch(instanceId, "switch", branchName)
      if (resetRes.ok) {
        setShowRevertConfirm(false)
        await loadStatus()
        onRefresh()
      } else {
        setError(resetRes.error || "切换分支失败")
      }
    } else {
      setError(res.error || "创建分支失败")
    }
  }

  const confirmRevertSoft = async () => {
    if (!revertTargetHash) return
    setError("")
    // 基于目标 commit 创建新分支，保留工作区文件
    const branchName = `checkout-${revertTargetHash}`
    const res = await gitApi.branch(instanceId, "create", branchName)
    if (res.ok) {
      setShowRevertConfirm(false)
      await loadStatus()
      onRefresh()
    } else {
      setError(res.error || "创建分支失败")
    }
  }

  if (!open) return null

  const currentBranch = gitStatus?.current_branch || "main"
  const branches = gitStatus?.branches || []
  const commits = gitStatus?.recent_commits || []
  const hasUncommitted = gitStatus?.has_uncommitted

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-background rounded-lg shadow-xl w-full max-w-3xl mx-4 max-h-[85vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-border shrink-0">
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

        {/* Tabs */}
        <div className="flex gap-1 px-4 pt-3 border-b border-border shrink-0">
          {[
            { key: "graph", label: "分支图", icon: GitFork },
            { key: "commit", label: "提交", icon: GitCommitHorizontal },
            { key: "branch", label: "分支管理", icon: ArrowLeftRight },
          ].map(t => (
            <button
              key={t.key}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-t-md transition-colors ${
                tab === t.key
                  ? "bg-muted/50 text-foreground font-medium border border-border border-b-background -mb-px"
                  : "text-muted-foreground hover:text-foreground"
              }`}
              onClick={() => setTab(t.key as typeof tab)}
            >
              <t.icon className="h-3.5 w-3.5" />
              {t.label}
            </button>
          ))}
        </div>

        {/* Error */}
        {error && (
          <div className="px-4 py-2 bg-red-500/10 border-b border-red-500/20 text-xs text-red-500">
            {error}
            <button className="ml-2 underline" onClick={() => setError("")}>关闭</button>
          </div>
        )}

        {/* Body */}
        <div className="flex-1 overflow-auto p-4">
          {loading && !gitStatus ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : !gitStatus ? (
            <div className="text-center py-16 text-sm text-muted-foreground">
              无法加载 git 信息
            </div>
          ) : (
            <>
              {/* Tab: 分支图 — ReactFlow */}
              {tab === "graph" && (
                <div className="space-y-3">
                  <p className="text-xs text-muted-foreground mb-2">
                    提交历史（共 {commits.length} 条）。点击任一提交可回档或创建分支。
                  </p>

                  {commits.length > 0 ? (
                    <div style={{ height: Math.max(300, commits.length * 72 + 60) }} className="border border-border rounded-lg bg-muted/10 overflow-hidden relative">
                      <GitGraphView
                        commits={commits}
                        branches={branches}
                        currentBranch={currentBranch}
                        onRevert={handleRevertCheckout}
                      />
                    </div>
                  ) : (
                    <div className="text-center py-8 text-sm text-muted-foreground">
                      暂无提交记录。新建楼层后提交即可显示。
                    </div>
                  )}

                  {/* Revert confirmation dialog */}
                  {showRevertConfirm && (
                    <div className="rounded-lg border border-border bg-muted/30 p-4 space-y-3">
                      <h4 className="text-sm font-medium flex items-center gap-1.5">
                        <RotateCcw className="h-3.5 w-3.5" />
                        回档选项
                      </h4>
                      <p className="text-xs text-muted-foreground">
                        目标提交：<span className="font-mono">{revertTargetHash}</span> — {revertTargetMsg}
                      </p>
                      <div className="flex flex-col gap-2">
                        <Button size="sm" variant="outline" className="justify-start" onClick={confirmRevertCheckout}>
                          <RotateCcw className="h-3.5 w-3.5 mr-2" />
                          硬回档：在此提交点创建新分支，文件恢复到当时的状态
                        </Button>
                        <p className="text-[10px] text-muted-foreground ml-1">
                          创建一个以该 commit 为起始的新分支，之后的所有提交将基于此点继续。
                        </p>
                        <Button size="sm" variant="outline" className="justify-start" onClick={confirmRevertSoft}>
                          <GitFork className="h-3.5 w-3.5 mr-2" />
                          软回档：基于此提交创建新分支，保留当前工作区文件
                        </Button>
                        <p className="text-[10px] text-muted-foreground ml-1">
                          创建一个新分支，但不改变当前文件状态。之后可以继续编辑再提交。
                        </p>
                        <div className="flex justify-end gap-2 mt-1">
                          <Button variant="outline" size="sm" onClick={() => setShowRevertConfirm(false)}>取消</Button>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Tab: 提交 */}
              {tab === "commit" && (
                <div className="space-y-4">
                  <div>
                    <p className="text-xs text-muted-foreground mb-2">
                      当前分支：<span className="font-mono">{currentBranch}</span>
                      {hasUncommitted
                        ? "（检测到未提交的变更，提交后将锁定当前所有文件状态）"
                        : "（工作区干净）"}
                    </p>
                    <div className="flex gap-2">
                      <Input
                        value={commitMessage}
                        onChange={e => setCommitMessage(e.target.value)}
                        placeholder="提交信息（建议格式：floor-NNN: 简短描述）"
                        className="flex-1"
                        onKeyDown={e => { if (e.key === "Enter" && !committing) handleCommit() }}
                      />
                      <Button onClick={handleCommit} disabled={!commitMessage.trim() || committing}>
                        {committing ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <GitCommitHorizontal className="h-3 w-3 mr-1" />}
                        提交
                      </Button>
                    </div>
                  </div>

                  {/* Recent commits */}
                  <div>
                    <h4 className="text-xs font-medium text-muted-foreground mb-2 flex items-center gap-1">
                      <History className="h-3 w-3" />
                      最近提交
                    </h4>
                    <div className="space-y-1 max-h-60 overflow-y-auto">
                      {commits.length === 0 ? (
                        <p className="text-xs text-muted-foreground text-center py-4">暂无提交</p>
                      ) : (
                        commits.map(c => (
                          <div key={c.hash} className="flex items-center gap-2 px-2 py-1.5 rounded text-xs hover:bg-muted/50">
                            <span className="font-mono text-[10px] text-muted-foreground w-14 shrink-0">{c.hash}</span>
                            <span className="flex-1 truncate">{c.message}</span>
                            <span className="text-[10px] text-muted-foreground shrink-0">{c.date?.slice(0, 10)}</span>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                </div>
              )}

              {/* Tab: 分支管理 */}
              {tab === "branch" && (
                <div className="space-y-4">
                  {/* Branch list */}
                  <div>
                    <h4 className="text-xs font-medium text-muted-foreground mb-2">已有分支</h4>
                    <div className="space-y-1 max-h-40 overflow-y-auto">
                      {branches.length === 0 ? (
                        <p className="text-xs text-muted-foreground text-center py-4">暂无分支</p>
                      ) : (
                        branches.map(b => (
                          <div key={b.name} className="flex items-center gap-2 px-2 py-1.5 rounded text-xs hover:bg-muted/50">
                            <GitBranchIcon className="h-3 w-3 text-muted-foreground shrink-0" />
                            <span className={`font-mono ${b.is_current ? "font-bold text-primary" : ""}`}>
                              {b.name}
                            </span>
                            {b.is_current && (
                              <span className="text-[10px] bg-primary/10 text-primary px-1.5 rounded">当前</span>
                            )}
                            <span className="text-[10px] text-muted-foreground ml-auto">{b.commit_hash}</span>
                          </div>
                        ))
                      )}
                    </div>
                  </div>

                  {/* Create / Switch */}
                  <div className="flex gap-1 bg-muted rounded-lg p-1 w-fit">
                    <button
                      className={`px-3 py-1 text-xs rounded-md transition-colors ${branchAction === "create" ? "bg-background shadow-sm font-medium" : "text-muted-foreground hover:text-foreground"}`}
                      onClick={() => setBranchAction("create")}
                    >
                      创建分支
                    </button>
                    <button
                      className={`px-3 py-1 text-xs rounded-md transition-colors ${branchAction === "switch" ? "bg-background shadow-sm font-medium" : "text-muted-foreground hover:text-foreground"}`}
                      onClick={() => setBranchAction("switch")}
                    >
                      切换分支
                    </button>
                  </div>

                  {branchAction === "create" ? (
                    <div className="flex gap-2">
                      <Input
                        value={branchName}
                        onChange={e => setBranchName(e.target.value)}
                        placeholder="新分支名称（如 retro-回到星罗城）"
                        className="flex-1"
                        onKeyDown={e => { if (e.key === "Enter" && !branching) handleBranch() }}
                      />
                      <Button onClick={handleBranch} disabled={!branchName.trim() || branching}>
                        {branching ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <Plus className="h-3 w-3 mr-1" />}
                        创建
                      </Button>
                    </div>
                  ) : (
                    <div className="flex gap-2">
                      <select
                        className="flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
                        value={branchName}
                        onChange={e => setBranchName(e.target.value)}
                      >
                        <option value="">选择分支...</option>
                        {branches.filter(b => !b.is_current).map(b => (
                          <option key={b.name} value={b.name}>{b.name} ({b.commit_hash})</option>
                        ))}
                      </select>
                      <Button onClick={handleBranch} disabled={!branchName || branching}>
                        {branching ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <ArrowLeftRight className="h-3 w-3 mr-1" />}
                        切换
                      </Button>
                    </div>
                  )}
                  <p className="text-[10px] text-muted-foreground">
                    切换分支前请先提交当前变更。未提交的变更将被拒绝切换。
                  </p>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// ---- ReactFlow Git Graph ----

const COMMIT_NODE_TYPE = "commitNode"

interface GitGraphViewProps {
  commits: GitLogEntry[]
  branches: GitBranch[]
  currentBranch: string
  onRevert: (hash: string, msg: string) => void
}

function GitGraphView({ commits, branches, currentBranch, onRevert }: GitGraphViewProps) {
  // Assign a "lane" (column) to each branch based on parent relationships
  const { nodes, edges } = useMemo(() => {
    const nodeList: Node[] = []
    const edgeList: Edge[] = []
    const branchColors = ["#6366f1", "#22c55e", "#f59e0b", "#ef4444", "#06b6d4", "#a855f7", "#ec4899"]
    const branchColorMap = new Map<string, string>()

    // Build a map: commit hash → list of branch names pointing to it
    const hashToBranches = new Map<string, string[]>()
    for (const b of branches) {
      const list = hashToBranches.get(b.commit_hash) || []
      list.push(b.name)
      hashToBranches.set(b.commit_hash, list)
    }

    // Assign colors to branches
    let colorIdx = 0
    for (const b of branches) {
      if (!branchColorMap.has(b.name)) {
        branchColorMap.set(b.name, branchColors[colorIdx++ % branchColors.length])
      }
    }

    // Assign lanes (x position) — simple approach: each unique parent chain gets its own lane
    const hashToLane = new Map<string, number>()
    const laneBranchName = new Map<number, string>()
    let nextLane = 0

    // Process commits from newest (index 0) to oldest
    for (const c of commits) {
      const branchRefs = hashToBranches.get(c.hash) || []

      // Determine lane: if this commit is a branch head, use that branch's lane
      let lane = -1
      if (branchRefs.length > 0) {
        // First branch pointing here gets the lane
        for (const bName of branchRefs) {
          for (const [l, bn] of laneBranchName) {
            if (bn === bName) { lane = l; break }
          }
          if (lane >= 0) break
        }
        if (lane < 0) {
          lane = nextLane++
          laneBranchName.set(lane, branchRefs[0])
        }
      } else {
        // Follow parent's lane
        if (c.parents.length > 0) {
          lane = hashToLane.get(c.parents[0]) ?? 0
        } else {
          lane = 0
        }
      }
      hashToLane.set(c.hash, lane)

      // Determine color based on branch
      let bgColor = branchColorMap.get(currentBranch) || "#6366f1"
      if (branchRefs.length > 0) {
        const branchName = branchRefs[0]
        bgColor = branchColorMap.get(branchName) || bgColor
      } else {
        // Inherit from parent
        if (c.parents.length > 0) {
          for (const [bName, bInfo] of Object.entries(
            Object.fromEntries(branches.map(b => [b.name, b]))
          )) {
            if (c.parents.includes(bInfo.commit_hash)) {
              bgColor = branchColorMap.get(bName) || bgColor
              break
            }
          }
        }
      }

      const isLatest = commits.indexOf(c) === 0
      const isBranchHead = branchRefs.length > 0

      nodeList.push({
        id: c.hash,
        type: COMMIT_NODE_TYPE,
        position: { x: lane * 220 + 20, y: commits.indexOf(c) * 80 + 10 },
        data: {
          hash: c.hash,
          message: c.message,
          date: c.date?.slice(0, 10) || "",
          isLatest,
          isBranchHead,
          branchRefs,
          currentBranch,
          bgColor,
          onRevert,
        },
      })

      // Create edges to parents
      for (const parent of c.parents) {
        edgeList.push({
          id: `${c.hash}->${parent}`,
          source: parent,
          target: c.hash,
          type: "smoothstep",
          style: { stroke: bgColor, strokeWidth: 2, opacity: 0.6 },
          animated: isLatest,
        })
      }
    }

    return { nodes: nodeList, edges: edgeList }
  }, [commits, branches, currentBranch, onRevert])

  if (nodes.length === 0) {
    return <div className="text-center py-8 text-sm text-muted-foreground">暂无提交记录</div>
  }

  return (
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
        nodeColor={(n) => (n.data as CommitNodeData)?.bgColor || "#6366f1"}
        style={{ width: 120, height: 80 }}
      />
    </ReactFlow>
  )
}

interface CommitNodeData {
  hash: string
  message: string
  date: string
  isLatest: boolean
  isBranchHead: boolean
  branchRefs: string[]
  currentBranch: string
  bgColor: string
  onRevert: (hash: string, msg: string) => void
}

function CommitNode({ data }: NodeProps<CommitNodeData>) {
  return (
    <div
      className="group rounded-lg border-2 bg-background shadow-sm hover:shadow-md transition-shadow min-w-[180px] cursor-pointer"
      style={{ borderColor: data.bgColor }}
      onClick={() => data.onRevert(data.hash, data.message)}
    >
      <Handle type="target" position={Position.Top} style={{ background: data.bgColor, width: 8, height: 8 }} />
      <div className="px-3 py-2 space-y-1">
        <div className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full shrink-0" style={{ background: data.bgColor }} />
          <span className="text-[10px] font-mono font-medium">{data.hash}</span>
          {data.isLatest && (
            <span className="text-[9px] bg-primary/10 text-primary px-1 rounded ml-auto">
              HEAD
            </span>
          )}
        </div>
        {data.branchRefs.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {data.branchRefs.map(br => (
              <span
                key={br}
                className={`text-[9px] px-1.5 rounded ${
                  br === data.currentBranch
                    ? "bg-primary/10 text-primary font-medium"
                    : "bg-muted text-muted-foreground"
                }`}
              >
                {br}
              </span>
            ))}
          </div>
        )}
        <p className="text-xs leading-tight line-clamp-2">{data.message}</p>
        <p className="text-[9px] text-muted-foreground">{data.date}</p>
      </div>
      <div className="hidden group-hover:flex absolute -bottom-4 left-1/2 -translate-x-1/2 gap-1">
        <span className="text-[9px] bg-muted text-muted-foreground px-1.5 py-0.5 rounded whitespace-nowrap">
          回档/分支
        </span>
      </div>
      <Handle type="source" position={Position.Bottom} style={{ background: data.bgColor, width: 8, height: 8 }} />
    </div>
  )
}

const nodeTypes = { [COMMIT_NODE_TYPE]: CommitNode }
