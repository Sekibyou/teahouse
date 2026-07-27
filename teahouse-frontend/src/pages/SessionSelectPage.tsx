import { useEffect, useState } from "react"
import { useNavigate } from "react-router-dom"
import { Play, FolderOpen, Loader2, Plus, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ConfirmDialog } from "@/components/ConfirmDialog"
import { prototypesApi, instancesApi, sessionApi } from "@/lib/api"
import { useSessionStore } from "@/stores/sessionStore"
import type { Prototype, Instance } from "@/lib/types"

export function SessionSelectPage() {
  const navigate = useNavigate()
  const setActiveInstance = useSessionStore((s) => s.setActiveInstance)

  const [prototypes, setPrototypes] = useState<Prototype[]>([])
  const [instances, setInstances] = useState<Instance[]>([])
  const [isLoading, setIsLoading] = useState(true)

  // Dialog state
  const [showNewSession, setShowNewSession] = useState(false)
  const [showOpenSession, setShowOpenSession] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)
  const [selectedProtoId, setSelectedProtoId] = useState<string>("")
  const [instanceName, setInstanceName] = useState("")
  const [actionLoading, setActionLoading] = useState(false)
  const [error, setError] = useState("")

  useEffect(() => {
    loadData()
  }, [])

  const loadData = async () => {
    setIsLoading(true)
    const [pRes, iRes] = await Promise.all([
      prototypesApi.list(),
      instancesApi.list(),
    ])
    if (pRes.ok) setPrototypes(pRes.data || [])
    if (iRes.ok) setInstances(iRes.data || [])
    setIsLoading(false)
  }

  const handleStartSession = async () => {
    if (!selectedProtoId || !instanceName.trim()) return
    setActionLoading(true)
    setError("")

    const res = await instancesApi.create(selectedProtoId, instanceName.trim())
    if (!res.ok) {
      setError(res.error || "创建失败")
      setActionLoading(false)
      return
    }

    const inst = res.data!
    // Register as active session on backend
    await sessionApi.setActive(inst.id)
    setActiveInstance({ id: inst.id, name: inst.name })
    setShowNewSession(false)
    navigate("/workspace")
  }

  const handleOpenSession = async (inst: Instance) => {
    setActionLoading(true)
    await sessionApi.setActive(inst.id)
    setActiveInstance({ id: inst.id, name: inst.name })
    setShowOpenSession(false)
    navigate("/workspace")
  }

  const handleDeleteInstance = async (e: React.MouseEvent, instId: string) => {
    e.stopPropagation()
    setDeleteTarget(instId)
  }

  const confirmDeleteInstance = async () => {
    if (!deleteTarget) return
    await instancesApi.delete(deleteTarget)
    setDeleteTarget(null)
    await loadData()
  }

  const openNewSession = () => {
    setSelectedProtoId("")
    setInstanceName("")
    setError("")
    setShowNewSession(true)
  }

  if (isLoading) {
    return (
      <div className="h-full flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col items-center justify-center gap-8">
      <div className="text-center">
        <h1 className="text-3xl font-bold mb-2">LowStar's Teahouse</h1>
        <p className="text-muted-foreground text-sm">基于 Harness Engineering 的小说创作引擎</p>
      </div>

      <div className="flex gap-4">
        <Button size="lg" onClick={openNewSession} className="gap-2">
          <Play className="h-4 w-4" />
          开始会话
        </Button>
        <Button size="lg" variant="outline" onClick={() => setShowOpenSession(true)} className="gap-2">
          <FolderOpen className="h-4 w-4" />
          打开会话
        </Button>
      </div>

      {/* New Session Dialog */}
      {showNewSession && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={() => setShowNewSession(false)}>
          <div className="bg-background rounded-lg shadow-lg w-full max-w-md mx-4 p-6 space-y-4" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h3 className="font-semibold text-lg">开始新会话</h3>
              <button onClick={() => setShowNewSession(false)} className="p-1 rounded hover:bg-muted">
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">选择原型</label>
              <div className="max-h-48 overflow-y-auto space-y-1 border rounded-md p-2">
                {prototypes.length === 0 ? (
                  <p className="text-sm text-muted-foreground p-2">暂无可用原型</p>
                ) : (
                  prototypes.map((p) => (
                    <button
                      key={p.id}
                      className={`w-full text-left px-3 py-2 rounded-md text-sm transition-colors ${
                        selectedProtoId === p.id
                          ? "bg-primary text-primary-foreground"
                          : "hover:bg-muted"
                      }`}
                      onClick={() => setSelectedProtoId(p.id)}
                    >
                      <div className="font-medium">{p.name}</div>
                      {p.description && (
                        <div className="text-xs opacity-70 mt-0.5">{p.description}</div>
                      )}
                      {p.is_builtin ? (
                        <div className="text-xs opacity-50 mt-0.5">内置</div>
                      ) : null}
                    </button>
                  ))
                )}
              </div>
            </div>

            <div className="space-y-1">
              <label className="text-sm font-medium">实例名称</label>
              <Input
                value={instanceName}
                onChange={e => { setInstanceName(e.target.value); setError("") }}
                placeholder="为这次会话起个名字"
                autoFocus
              />
            </div>

            {error && <p className="text-sm text-red-500">{error}</p>}

            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" size="sm" onClick={() => setShowNewSession(false)}>取消</Button>
              <Button size="sm" onClick={handleStartSession} disabled={!selectedProtoId || !instanceName.trim() || actionLoading}>
                {actionLoading && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}
                创建并进入
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Open Session Dialog */}
      {showOpenSession && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={() => setShowOpenSession(false)}>
          <div className="bg-background rounded-lg shadow-lg w-full max-w-md mx-4 p-6 space-y-4" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h3 className="font-semibold text-lg">打开会话</h3>
              <button onClick={() => setShowOpenSession(false)} className="p-1 rounded hover:bg-muted">
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="max-h-72 overflow-y-auto space-y-1">
              {instances.length === 0 ? (
                <p className="text-sm text-muted-foreground p-4 text-center">暂无历史会话</p>
              ) : (
                instances.map((inst) => (
                  <button
                    key={inst.id}
                    className="w-full flex items-center justify-between px-3 py-3 rounded-md text-sm hover:bg-muted transition-colors text-left"
                    onClick={() => handleOpenSession(inst)}
                    disabled={actionLoading}
                  >
                    <div>
                      <div className="font-medium">{inst.name}</div>
                      <div className="text-xs text-muted-foreground mt-0.5">
                        楼层 {inst.floor_count} · {inst.status === "active" ? "进行中" : inst.status}
                      </div>
                    </div>
                    <button
                      className="p-1 rounded hover:bg-background text-muted-foreground hover:text-red-500 transition-colors"
                      onClick={(e) => handleDeleteInstance(e, inst.id)}
                      title="删除实例"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </button>
                ))
              )}
            </div>

            {actionLoading && (
              <div className="flex justify-center">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            )}
          </div>
        </div>
      )}

      {/* Confirm delete instance dialog */}
      <ConfirmDialog
        open={deleteTarget !== null}
        title="确认删除实例"
        message="删除实例将永久删除该实例的所有数据，包括所有楼层和设置。此操作不可撤销。"
        variant="destructive"
        confirmText="删除"
        onConfirm={confirmDeleteInstance}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  )
}
