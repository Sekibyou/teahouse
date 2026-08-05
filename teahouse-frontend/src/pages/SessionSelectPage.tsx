import { useEffect, useState, useRef } from "react"
import { useNavigate, useOutletContext } from "react-router-dom"
import { Play, Loader2, X, Download, Upload, Trash2, Clock, Hash, Info, Sun, Moon, LogOut, Settings, User, ArrowLeft } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { ConfirmDialog } from "@/components/ConfirmDialog"
import { prototypesApi, instancesApi, sessionApi } from "@/lib/api"
import { renderText } from "@/lib/htmlSanitizer"
import { getBBCodeAnimationCSS, getBBCodeTooltipScript } from "@/lib/bbcodeParser"
import { useAuthActions } from "@/stores/authStore"
import { useSessionStore } from "@/stores/sessionStore"
import { useSettingsDialogStore } from "@/stores/settingsDialogStore"
import { useIsMobile } from "@/hooks/useMediaQuery"
import type { Prototype, Instance } from "@/lib/types"

export function SessionSelectPage() {
  const navigate = useNavigate()
  const setActiveInstance = useSessionStore((s) => s.setActiveInstance)
  const isMobile = useIsMobile()
  const { toggleTheme } = useOutletContext<{ isMobile: boolean; toggleTheme: () => void }>()
  const openSettings = useSettingsDialogStore((s) => s.openSettings)

  const [prototypes, setPrototypes] = useState<Prototype[]>([])
  const [instances, setInstances] = useState<Instance[]>([])
  const [isLoading, setIsLoading] = useState(true)

  // Selection
  const [selectedProto, setSelectedProto] = useState<Prototype | null>(null)
  const [selectedInstance, setSelectedInstance] = useState<Instance | null>(null)

  // Readme panel
  const [readmeData, setReadmeData] = useState<{ metadata: Record<string, unknown>; readme: string } | null>(null)
  const [readmeLoading, setReadmeLoading] = useState(false)

  // New session inline form
  const [showNewSessionForm, setShowNewSessionForm] = useState(false)
  const [instanceName, setInstanceName] = useState("")
  const [actionLoading, setActionLoading] = useState(false)
  const [newSessionError, setNewSessionError] = useState("")

  // Delete confirmations
  const [protoToDelete, setProtoToDelete] = useState<Prototype | null>(null)
  const [instanceToDelete, setInstanceToDelete] = useState<Instance | null>(null)

  // Import
  const [importState, setImportState] = useState<"idle" | "loading">("idle")
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Mobile: tab switching and detail view
  const [mobileActiveTab, setMobileActiveTab] = useState<"prototypes" | "instances">("prototypes")
  const [mobileDetailType, setMobileDetailType] = useState<"proto" | "instance" | null>(null)
  const [mobileDetailProto, setMobileDetailProto] = useState<Prototype | null>(null)
  const [mobileDetailInstance, setMobileDetailInstance] = useState<Instance | null>(null)

  // Mobile: menu
  const [showMobileMenu, setShowMobileMenu] = useState(false)
  const { clearAuth } = useAuthActions()

  // Dark mode for mobile header
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

  useEffect(() => { loadData() }, [])

  const loadData = async () => {
    setIsLoading(true)
    const [pRes, iRes] = await Promise.all([prototypesApi.list(), instancesApi.list()])
    if (pRes.ok) setPrototypes(pRes.data || [])
    if (iRes.ok) setInstances(iRes.data || [])
    setIsLoading(false)
  }

  const reloadInstances = async () => {
    const res = await instancesApi.list()
    if (res.ok) setInstances(res.data || [])
  }

  // When selecting a prototype, load its readme
  useEffect(() => {
    if (selectedProto) {
      setReadmeLoading(true)
      setReadmeData(null)
      prototypesApi.getReadme(selectedProto.id).then(res => {
        if (res.ok) setReadmeData(res.data!)
        setReadmeLoading(false)
      })
    } else {
      setReadmeData(null)
    }
  }, [selectedProto])

  const selectProto = (proto: Prototype) => {
    setSelectedInstance(null)
    setSelectedProto(proto)
    setShowNewSessionForm(false)
    if (isMobile) {
      setMobileDetailType("proto")
      setMobileDetailProto(proto)
    }
  }

  const selectInstance = (inst: Instance) => {
    setSelectedProto(null)
    setSelectedInstance(inst)
    setShowNewSessionForm(false)
    setReadmeData(null)
    if (isMobile) {
      setMobileDetailType("instance")
      setMobileDetailInstance(inst)
    }
  }

  const backToList = () => {
    setMobileDetailType(null)
    setMobileDetailProto(null)
    setMobileDetailInstance(null)
    setSelectedProto(null)
    setSelectedInstance(null)
  }

  // ---- Actions ----

  const handleStartSession = async () => {
    if (!selectedProto || !instanceName.trim()) return
    setActionLoading(true)
    setNewSessionError("")
    const res = await instancesApi.create(selectedProto.id, instanceName.trim())
    if (!res.ok) {
      setNewSessionError(res.error || "创建失败")
      setActionLoading(false)
      return
    }
    const inst = res.data!
    await sessionApi.setActive(inst.id)
    setActiveInstance({ id: inst.id, name: inst.name })
    navigate("/workspace")
  }

  const handleContinue = async (inst: Instance) => {
    setActionLoading(true)
    await sessionApi.setActive(inst.id)
    setActiveInstance({ id: inst.id, name: inst.name })
    navigate("/workspace")
  }

  const confirmDeletePrototype = async () => {
    if (!protoToDelete) return
    await prototypesApi.delete(protoToDelete.id)
    if (selectedProto?.id === protoToDelete.id) setSelectedProto(null)
    setProtoToDelete(null)
    await loadData()
  }

  const confirmDeleteInstance = async () => {
    if (!instanceToDelete) return
    await instancesApi.delete(instanceToDelete.id)
    if (selectedInstance?.id === instanceToDelete.id) setSelectedInstance(null)
    setInstanceToDelete(null)
    await loadData()
  }

  const handleDownload = () => {
    if (!selectedProto || selectedProto.is_builtin) return
    const url = prototypesApi.downloadUrl(selectedProto.id)
    const a = document.createElement("a")
    a.href = url
    a.download = `${selectedProto.name}.teabrew`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
  }

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setImportState("loading")
    const res = await prototypesApi.import(file)
    if (res.ok && res.data) {
      if (res.data.duplicate) {
        toast.info("此原型已存在，无需重复导入")
      } else {
        toast.success("原型导入成功")
      }
      await loadData()
      setImportState("idle")
    } else {
      toast.error(res.error || "导入失败")
      setImportState("idle")
    }
    if (fileInputRef.current) fileInputRef.current.value = ""
  }

  const formatTime = (ts: number) => {
    const d = new Date(ts)
    const pad = (n: number) => String(n).padStart(2, "0")
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  }

  if (isLoading) {
    return (
      <div className="h-full flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  // ============================================================================
  // Mobile layout
  // ============================================================================
  if (isMobile) {
    // Mobile detail view — when a prototype or instance is selected
    if (mobileDetailType === "proto" && mobileDetailProto) {
      return (
        <MobileProtoDetail
          proto={mobileDetailProto}
          readmeData={readmeData}
          readmeLoading={readmeLoading}
          showNewSessionForm={showNewSessionForm}
          instanceName={instanceName}
          newSessionError={newSessionError}
          actionLoading={actionLoading}
          onInstanceNameChange={(v) => { setInstanceName(v); setNewSessionError("") }}
          onStartSession={handleStartSession}
          onShowForm={() => setShowNewSessionForm(true)}
          onHideForm={() => { setShowNewSessionForm(false); setInstanceName("") }}
          onDelete={async () => {
            if (mobileDetailProto) {
              await confirmDeletePrototype()
              backToList()
            }
          }}
          onDownload={handleDownload}
          onImport={handleImport}
          importState={importState}
          fileInputRef={fileInputRef}
          onBack={backToList}
        />
      )
    }

    if (mobileDetailType === "instance" && mobileDetailInstance) {
      return (
        <MobileInstanceDetail
          instance={mobileDetailInstance}
          actionLoading={actionLoading}
          onContinue={() => handleContinue(mobileDetailInstance)}
          onDelete={async () => {
            setInstanceToDelete(mobileDetailInstance)
          }}
          onBack={backToList}
        />
      )
    }

    return (
      <div className="h-full flex flex-col">
        {/* Mobile header */}
        <header className="h-10 border-b border-border flex items-center justify-between px-3 shrink-0">
          <span className="font-semibold text-sm">LowStar's Teahouse</span>
          <div className="relative">
            <button
              className="p-1 rounded hover:bg-muted"
              onClick={() => setShowMobileMenu(!showMobileMenu)}
            >
              <Settings className="h-4 w-4" />
            </button>
            {showMobileMenu && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setShowMobileMenu(false)} />
                <div className="absolute right-0 top-full mt-1 z-50 bg-background border border-border rounded-md shadow-lg py-1 min-w-[140px]">
                  <button
                    className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-muted"
                    onClick={() => { handleToggleTheme(); setShowMobileMenu(false) }}
                  >
                    {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
                    主题切换
                  </button>
                  <button
                    className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-muted"
                    onClick={() => { openSettings(); setShowMobileMenu(false) }}
                  >
                    <Settings className="h-4 w-4" />
                    设置
                  </button>
                  <button
                    className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-muted text-red-500"
                    onClick={() => { clearAuth(); setShowMobileMenu(false) }}
                  >
                    <LogOut className="h-4 w-4" />
                    退出登录
                  </button>
                </div>
              </>
            )}
          </div>
        </header>

        {/* Tab bar */}
        <div className="flex border-b border-border shrink-0">
          <button
            className={`flex-1 py-2 text-sm font-medium transition-colors ${
              mobileActiveTab === "prototypes"
                ? "text-foreground border-b-2 border-primary"
                : "text-muted-foreground"
            }`}
            onClick={() => setMobileActiveTab("prototypes")}
          >
            原型 ({prototypes.length})
          </button>
          <button
            className={`flex-1 py-2 text-sm font-medium transition-colors ${
              mobileActiveTab === "instances"
                ? "text-foreground border-b-2 border-primary"
                : "text-muted-foreground"
            }`}
            onClick={() => setMobileActiveTab("instances")}
          >
            实例 ({instances.length})
          </button>
        </div>

        {/* Tab content */}
        <div className="flex-1 overflow-y-auto">
          {mobileActiveTab === "prototypes" && (
            <div className="p-2 space-y-1">
              <div className="flex items-center justify-between px-2 pb-1">
                <span className="text-xs text-muted-foreground">选择原型开始新会话</span>
                <div className="flex items-center gap-1">
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".teabrew,.zip"
                    className="hidden"
                    onChange={handleImport}
                  />
                  <button
                    className="p-1 rounded hover:bg-muted text-muted-foreground"
                    disabled={importState === "loading"}
                    onClick={() => fileInputRef.current?.click()}
                    title="导入原型"
                  >
                    {importState === "loading" ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Upload className="h-3.5 w-3.5" />
                    )}
                  </button>
                </div>
              </div>
              {prototypes.length === 0 ? (
                <p className="text-xs text-muted-foreground p-3 text-center">暂无原型</p>
              ) : (
                prototypes.map((proto) => (
                  <ProtoCard
                    key={proto.id}
                    proto={proto}
                    isSelected={selectedProto?.id === proto.id}
                    onClick={() => selectProto(proto)}
                  />
                ))
              )}
            </div>
          )}
          {mobileActiveTab === "instances" && (
            <div className="p-2 space-y-1">
              <span className="text-xs text-muted-foreground px-2">继续已有会话</span>
              {instances.length === 0 ? (
                <p className="text-xs text-muted-foreground p-3 text-center">暂无实例</p>
              ) : (
                instances.map((inst) => (
                  <InstanceCard
                    key={inst.id}
                    instance={inst}
                    isSelected={selectedInstance?.id === inst.id}
                    onClick={() => selectInstance(inst)}
                  />
                ))
              )}
            </div>
          )}
        </div>

        {/* Confirm delete instance (mobile) */}
        <ConfirmDialog
          open={instanceToDelete !== null}
          title="确认删除实例"
          message={`确定要删除实例 "${instanceToDelete?.name}" 吗？此操作将永久删除该实例的所有数据。`}
          variant="destructive"
          confirmText="删除"
          onConfirm={confirmDeleteInstance}
          onCancel={() => setInstanceToDelete(null)}
        />
      </div>
    )
  }

  // ============================================================================
  // Desktop layout
  // ============================================================================
  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="text-center py-6 border-b border-border shrink-0">
        <h1 className="text-2xl font-bold mb-1">LowStar's Teahouse</h1>
        <p className="text-muted-foreground text-sm">基于 Harness Engineering 的小说创作引擎</p>
      </div>

      {/* Body — left list + right detail */}
      <div className="flex-1 flex overflow-hidden min-h-0">
        {/* Left sidebar — prototypes + instances */}
        <aside className="w-80 border-r border-border flex flex-col shrink-0 bg-muted/10 overflow-hidden">
          {/* Prototypes section */}
          <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
            <div className="flex items-center justify-between px-4 py-2 border-b border-border shrink-0">
              <span className="text-sm font-semibold">原型 ({prototypes.length})</span>
              <div className="flex items-center gap-1">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".teabrew,.zip"
                  className="hidden"
                  onChange={handleImport}
                />
                <button
                  className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground"
                  disabled={importState === "loading"}
                  onClick={() => fileInputRef.current?.click()}
                  title="导入原型"
                >
                  {importState === "loading" ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Upload className="h-3.5 w-3.5" />
                  )}
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-2 space-y-1">
              {prototypes.length === 0 ? (
                <p className="text-xs text-muted-foreground p-3 text-center">暂无原型</p>
              ) : (
                prototypes.map((proto) => (
                  <ProtoCard
                    key={proto.id}
                    proto={proto}
                    isSelected={selectedProto?.id === proto.id}
                    onClick={() => selectProto(proto)}
                  />
                ))
              )}
            </div>
          </div>

          {/* Instances section */}
          <div className="flex flex-col min-h-0 border-t border-border" style={{ flex: "0 1 50%" }}>
            <div className="flex items-center px-4 py-2 border-b border-border shrink-0">
              <span className="text-sm font-semibold">实例 ({instances.length})</span>
            </div>
            <div className="flex-1 overflow-y-auto p-2 space-y-1">
              {instances.length === 0 ? (
                <p className="text-xs text-muted-foreground p-3 text-center">暂无实例</p>
              ) : (
                instances.map((inst) => (
                  <InstanceCard
                    key={inst.id}
                    instance={inst}
                    isSelected={selectedInstance?.id === inst.id}
                    onClick={() => selectInstance(inst)}
                  />
                ))
              )}
            </div>
          </div>
        </aside>

        {/* Right detail panel */}
        <main className="flex-1 flex flex-col min-w-0 overflow-hidden">
          {selectedProto ? (
            <ProtoDetail
              proto={selectedProto}
              readmeData={readmeData}
              readmeLoading={readmeLoading}
              showNewSessionForm={showNewSessionForm}
              instanceName={instanceName}
              newSessionError={newSessionError}
              actionLoading={actionLoading}
              onInstanceNameChange={(v) => { setInstanceName(v); setNewSessionError("") }}
              onStartSession={handleStartSession}
              onShowForm={() => setShowNewSessionForm(true)}
              onHideForm={() => { setShowNewSessionForm(false); setInstanceName("") }}
              onDelete={() => setProtoToDelete(selectedProto)}
              onDownload={handleDownload}
              onImport={handleImport}
              importState={importState}
              fileInputRef={fileInputRef}
            />
          ) : selectedInstance ? (
            <InstanceDetail
              instance={selectedInstance}
              actionLoading={actionLoading}
              onContinue={() => handleContinue(selectedInstance)}
              onDelete={() => setInstanceToDelete(selectedInstance)}
            />
          ) : (
            <div className="flex-1 flex items-center justify-center text-muted-foreground">
              <div className="text-center">
                <Info className="h-10 w-10 mx-auto mb-3 opacity-20" />
                <p className="text-sm">选择左侧的原型或实例查看详情</p>
              </div>
            </div>
          )}
        </main>
      </div>

      {/* Confirm delete prototype */}
      <ConfirmDialog
        open={protoToDelete !== null}
        title="确认删除原型"
        message={`确定要删除原型 "${protoToDelete?.name}" 吗？此操作不可撤销。`}
        variant="destructive"
        confirmText="删除"
        onConfirm={confirmDeletePrototype}
        onCancel={() => setProtoToDelete(null)}
      />

      {/* Confirm delete instance */}
      <ConfirmDialog
        open={instanceToDelete !== null}
        title="确认删除实例"
        message={`确定要删除实例 "${instanceToDelete?.name}" 吗？此操作将永久删除该实例的所有数据。`}
        variant="destructive"
        confirmText="删除"
        onConfirm={confirmDeleteInstance}
        onCancel={() => setInstanceToDelete(null)}
      />
    </div>
  )
}

// ============================================================================
// ProtoCard
// ============================================================================
function ProtoCard({ proto, isSelected, onClick }: {
  proto: Prototype
  isSelected: boolean
  onClick: () => void
}) {
  return (
    <div
      className={`rounded-md p-3 cursor-pointer transition-colors ${
        isSelected
          ? "bg-primary/10 ring-1 ring-primary/30"
          : "hover:bg-muted/50"
      }`}
      onClick={onClick}
    >
      <div className="flex items-center gap-2">
        <span className="font-medium text-sm truncate flex-1">{proto.name}</span>
        {proto.is_builtin ? (
          <span className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded shrink-0">内置</span>
        ) : null}
      </div>
      {proto.description && (
        <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{proto.description}</p>
      )}
    </div>
  )
}

// ============================================================================
// InstanceCard
// ============================================================================
function InstanceCard({ instance, isSelected, onClick }: {
  instance: Instance
  isSelected: boolean
  onClick: () => void
}) {
  return (
    <div
      className={`rounded-md p-3 cursor-pointer transition-colors ${
        isSelected
          ? "bg-primary/10 ring-1 ring-primary/30"
          : "hover:bg-muted/50"
      }`}
      onClick={onClick}
    >
      <div className="font-medium text-sm truncate">{instance.name}</div>
      <div className="flex items-center gap-3 mt-1 text-[11px] text-muted-foreground">
        {instance.prototype_name ? (
          <span className="truncate" title={instance.prototype_name}>来源：{instance.prototype_name}</span>
        ) : null}
        <span className="flex items-center gap-1 shrink-0">
          <Hash className="h-3 w-3" />
          {instance.floor_count}
        </span>
        <span className="flex items-center gap-1 shrink-0">
          <Clock className="h-3 w-3" />
          {formatShortTime(instance.created_at)}
        </span>
      </div>
    </div>
  )
}

function formatShortTime(ts: number) {
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

// ============================================================================
// ProtoDetail — right panel when a prototype is selected
// ============================================================================
function ProtoDetail({
  proto, readmeData, readmeLoading, showNewSessionForm, instanceName,
  newSessionError, actionLoading, onInstanceNameChange, onStartSession,
  onShowForm, onHideForm, onDelete, onDownload, onImport, importState, fileInputRef,
}: {
  proto: Prototype
  readmeData: { metadata: Record<string, unknown>; readme: string } | null
  readmeLoading: boolean
  showNewSessionForm: boolean
  instanceName: string
  newSessionError: string
  actionLoading: boolean
  onInstanceNameChange: (v: string) => void
  onStartSession: () => void
  onShowForm: () => void
  onHideForm: () => void
  onDelete: () => void
  onDownload: () => void
  onImport: (e: React.ChangeEvent<HTMLInputElement>) => void
  importState: "idle" | "loading"
  fileInputRef: React.RefObject<HTMLInputElement | null>
}) {
  const meta = readmeData?.metadata
  const htmlContent = readmeData?.readme
    ? renderText(readmeData.readme, [])
    : ""

  // Inject BBCode animation CSS + tip tooltip script for the readme panel
  useEffect(() => {
    const cssId = "bbcode-animation-css-readme"
    if (!document.getElementById(cssId)) {
      const style = document.createElement("style")
      style.id = cssId
      style.textContent = getBBCodeAnimationCSS()
      document.head.appendChild(style)
    }
    const tipId = "bbcode-tip-script"
    if (!document.getElementById(tipId)) {
      const s = document.createElement("script")
      s.id = tipId
      s.textContent = getBBCodeTooltipScript()
      document.head.appendChild(s)
    }
    return () => {
      const style = document.getElementById(cssId)
      if (style) style.remove()
      const s = document.getElementById(tipId)
      if (s) s.remove()
    }
  }, [])

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
      {/* Header bar */}
      <div className="flex items-center justify-between px-6 py-3 border-b border-border shrink-0">
        <div>
          <h2 className="font-semibold text-lg">{proto.name}</h2>
          {proto.description && (
            <p className="text-sm text-muted-foreground">{proto.description}</p>
          )}
        </div>
        <div className="flex items-center gap-2">
          {!showNewSessionForm ? (
            <Button size="sm" onClick={onShowForm} className="gap-1">
              <Play className="h-3.5 w-3.5" />
              开始会话
            </Button>
          ) : (
            <div className="flex items-center gap-2">
              <Input
                className="w-44 h-8 text-sm"
                value={instanceName}
                onChange={e => onInstanceNameChange(e.target.value)}
                placeholder="实例名称"
                autoFocus
                onKeyDown={e => { if (e.key === "Enter") onStartSession() }}
              />
              <Button size="sm" onClick={onStartSession} disabled={!instanceName.trim() || actionLoading}>
                {actionLoading && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}
                创建
              </Button>
              <button className="p-1 rounded hover:bg-muted" onClick={onHideForm}>
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
          {!proto.is_builtin && (
            <>
              <button className="p-1.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground" onClick={onDownload} title="下载">
                <Download className="h-4 w-4" />
              </button>
              <button className="p-1.5 rounded hover:bg-muted text-muted-foreground hover:text-red-500" onClick={onDelete} title="删除">
                <Trash2 className="h-4 w-4" />
              </button>
            </>
          )}
        </div>
      </div>

      {newSessionError && (
        <p className="text-sm text-red-500 px-6 py-1 shrink-0">{newSessionError}</p>
      )}

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-6 min-h-0">
        {/* Metadata bar */}
        {meta && (meta.author || meta.version) && (
          <div className="flex items-center gap-4 text-xs text-muted-foreground mb-4">
            {meta.author && <span>作者：{meta.author as string}</span>}
            {meta.version && <span>版本：{meta.version as string}</span>}
          </div>
        )}

        {/* Readme */}
        {readmeLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : htmlContent ? (
          <div
            className="prose prose-sm dark:prose-invert max-w-none"
            dangerouslySetInnerHTML={{ __html: htmlContent }}
          />
        ) : (
          <div className="text-center py-12 text-muted-foreground text-sm">
            {proto.is_builtin
              ? "暂无详细介绍。"
              : "暂无 README。可在 _prototype/ 目录下创建 README.md 后重新打包。"}
          </div>
        )}
      </div>
    </div>
  )
}

// ============================================================================
// InstanceDetail — right panel when an instance is selected
// ============================================================================
function InstanceDetail({
  instance, actionLoading, onContinue, onDelete,
}: {
  instance: Instance
  actionLoading: boolean
  onContinue: () => void
  onDelete: () => void
}) {
  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
      <div className="flex items-center justify-between px-6 py-3 border-b border-border shrink-0">
        <div>
          <h2 className="font-semibold text-lg">{instance.name}</h2>
          {instance.prototype_name && (
            <p className="text-sm text-muted-foreground">来源原型：{instance.prototype_name}</p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={onContinue} disabled={actionLoading} className="gap-1">
            <Play className="h-3.5 w-3.5" />
            继续会话
          </Button>
          <button className="p-1.5 rounded hover:bg-muted text-muted-foreground hover:text-red-500" onClick={onDelete} title="删除">
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        <div className="space-y-3 text-sm">
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground">状态：</span>
            <span>{instance.status === "active" ? "进行中" : instance.status}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground">楼层：</span>
            <span>{instance.floor_count}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground">创建时间：</span>
            <span>{formatFullTime(instance.created_at)}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground">最后更新：</span>
            <span>{formatFullTime(instance.updated_at)}</span>
          </div>
        </div>
      </div>
    </div>
  )
}

function formatFullTime(ts: number) {
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

// ============================================================================
// MobileProtoDetail — fullscreen detail for mobile
// ============================================================================
function MobileProtoDetail({
  proto, readmeData, readmeLoading, showNewSessionForm, instanceName,
  newSessionError, actionLoading, onInstanceNameChange, onStartSession,
  onShowForm, onHideForm, onDelete, onDownload, onImport, importState, fileInputRef, onBack,
}: {
  proto: Prototype
  readmeData: { metadata: Record<string, unknown>; readme: string } | null
  readmeLoading: boolean
  showNewSessionForm: boolean
  instanceName: string
  newSessionError: string
  actionLoading: boolean
  onInstanceNameChange: (v: string) => void
  onStartSession: () => void
  onShowForm: () => void
  onHideForm: () => void
  onDelete: () => void
  onDownload: () => void
  onImport: (e: React.ChangeEvent<HTMLInputElement>) => void
  importState: "idle" | "loading"
  fileInputRef: React.RefObject<HTMLInputElement | null>
  onBack: () => void
}) {
  const meta = readmeData?.metadata
  const htmlContent = readmeData?.readme
    ? renderText(readmeData.readme, [])
    : ""

  useEffect(() => {
    const cssId = "bbcode-animation-css-readme"
    if (!document.getElementById(cssId)) {
      const style = document.createElement("style")
      style.id = cssId
      style.textContent = getBBCodeAnimationCSS()
      document.head.appendChild(style)
    }
    const tipId = "bbcode-tip-script"
    if (!document.getElementById(tipId)) {
      const s = document.createElement("script")
      s.id = tipId
      s.textContent = getBBCodeTooltipScript()
      document.head.appendChild(s)
    }
    return () => {
      const style = document.getElementById(cssId)
      if (style) style.remove()
      const s = document.getElementById(tipId)
      if (s) s.remove()
    }
  }, [])

  return (
    <div className="h-full flex flex-col">
      {/* Nav bar */}
      <div className="h-10 border-b border-border flex items-center gap-2 px-2 shrink-0">
        <button className="p-1 rounded hover:bg-muted" onClick={onBack}>
          <ArrowLeft className="h-4 w-4" />
        </button>
        <div className="flex-1 min-w-0">
          <h2 className="font-semibold text-sm truncate">{proto.name}</h2>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {!proto.is_builtin && (
            <>
              <button className="p-1.5 rounded hover:bg-muted text-muted-foreground" onClick={onDownload} title="下载">
                <Download className="h-4 w-4" />
              </button>
              <button className="p-1.5 rounded hover:bg-muted text-red-500" onClick={onDelete} title="删除">
                <Trash2 className="h-4 w-4" />
              </button>
            </>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {/* Metadata bar */}
        {meta && (meta.author || meta.version) && (
          <div className="flex items-center gap-4 text-xs text-muted-foreground mb-4">
            {meta.author && <span>作者：{meta.author as string}</span>}
            {meta.version && <span>版本：{meta.version as string}</span>}
          </div>
        )}

        {proto.description && (
          <p className="text-sm text-muted-foreground mb-4">{proto.description}</p>
        )}

        {/* Readme */}
        {readmeLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : htmlContent ? (
          <div
            className="prose prose-sm dark:prose-invert max-w-none"
            dangerouslySetInnerHTML={{ __html: htmlContent }}
          />
        ) : (
          <div className="text-center py-12 text-muted-foreground text-sm">
            {proto.is_builtin
              ? "暂无详细介绍。"
              : "暂无 README。可在 _prototype/ 目录下创建 README.md 后重新打包。"}
          </div>
        )}
      </div>

      {/* Bottom action bar */}
      <div className="border-t border-border p-3 shrink-0">
        {!showNewSessionForm ? (
          <Button className="w-full gap-2" size="lg" onClick={onShowForm}>
            <Play className="h-4 w-4" />
            开始会话
          </Button>
        ) : (
          <div className="space-y-2">
            <Input
              value={instanceName}
              onChange={e => onInstanceNameChange(e.target.value)}
              placeholder="实例名称"
              autoFocus
              onKeyDown={e => { if (e.key === "Enter") onStartSession() }}
            />
            {newSessionError && <p className="text-sm text-red-500">{newSessionError}</p>}
            <div className="flex gap-2">
              <Button variant="outline" className="flex-1" onClick={onHideForm}>取消</Button>
              <Button className="flex-1" onClick={onStartSession} disabled={!instanceName.trim() || actionLoading}>
                {actionLoading && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}
                创建
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ============================================================================
// MobileInstanceDetail — fullscreen detail for mobile
// ============================================================================
function MobileInstanceDetail({
  instance, actionLoading, onContinue, onDelete, onBack,
}: {
  instance: Instance
  actionLoading: boolean
  onContinue: () => void
  onDelete: () => void
  onBack: () => void
}) {
  return (
    <div className="h-full flex flex-col">
      {/* Nav bar */}
      <div className="h-10 border-b border-border flex items-center gap-2 px-2 shrink-0">
        <button className="p-1 rounded hover:bg-muted" onClick={onBack}>
          <ArrowLeft className="h-4 w-4" />
        </button>
        <div className="flex-1 min-w-0">
          <h2 className="font-semibold text-sm truncate">{instance.name}</h2>
          {instance.prototype_name && (
            <p className="text-xs text-muted-foreground truncate">来源：{instance.prototype_name}</p>
          )}
        </div>
        <button className="p-1.5 rounded hover:bg-muted text-red-500" onClick={onDelete} title="删除">
          <Trash2 className="h-4 w-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        <div className="space-y-3 text-sm">
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground">状态：</span>
            <span>{instance.status === "active" ? "进行中" : instance.status}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground">楼层：</span>
            <span>{instance.floor_count}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground">创建时间：</span>
            <span>{formatFullTime(instance.created_at)}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground">最后更新：</span>
            <span>{formatFullTime(instance.updated_at)}</span>
          </div>
        </div>
      </div>

      <div className="border-t border-border p-3 shrink-0">
        <Button className="w-full gap-2" size="lg" onClick={onContinue} disabled={actionLoading}>
          <Play className="h-4 w-4" />
          继续会话
        </Button>
      </div>
    </div>
  )
}
