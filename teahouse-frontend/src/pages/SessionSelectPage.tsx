import { useEffect, useState, useRef, useCallback } from "react"
import { useNavigate, useOutletContext } from "react-router-dom"
import {
  Play, Loader2, X, Upload, Download, Trash2, Clock, Hash, Sun, Moon, LogOut,
  Settings, ArrowLeft, Copy, BookOpen, Plus, Pencil, Package,
} from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ConfirmDialog } from "@/components/ConfirmDialog"
import { prototypesApi, instancesApi, sessionApi, skillsApi, packagesApi, type MySkill, type InstanceSkill, type MyPackage, type InstancePackage } from "@/lib/api"
import { renderText } from "@/lib/htmlSanitizer"
import { getBBCodeAnimationCSS, getBBCodeTooltipScript } from "@/lib/bbcodeParser"
import { useAuthActions } from "@/stores/authStore"
import { useSessionStore } from "@/stores/sessionStore"
import { useSettingsDialogStore } from "@/stores/settingsDialogStore"
import { useIsMobile } from "@/hooks/useMediaQuery"
import { useDialogBackClose } from "@/hooks/useDialogBackClose"
import { useSetupStatus } from "@/hooks/useSetupStatus"
import { WelcomeWizard } from "@/components/WelcomeWizard/WelcomeWizard"
import { CoverWithFetch } from "@/components/Cover"
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

  // Detail dialog — the single "instance" dialog (continue / rename / README)
  const [dialogInstance, setDialogInstance] = useState<Instance | null>(null)
  const [readmeData, setReadmeData] = useState<{ metadata: Record<string, unknown>; readme: string } | null>(null)
  const [readmeLoading, setReadmeLoading] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState("")

  // Bookshelf overlay (new instance)
  const [bookshelfOpen, setBookshelfOpen] = useState(false)

  const [actionLoading, setActionLoading] = useState(false)

  // Delete confirmations
  const [protoToDelete, setProtoToDelete] = useState<Prototype | null>(null)
  const [instanceToDelete, setInstanceToDelete] = useState<Instance | null>(null)

  // Copy
  const [instanceToCopy, setInstanceToCopy] = useState<Instance | null>(null)
  const [copyName, setCopyName] = useState("")
  const [copyError, setCopyError] = useState("")
  const [copying, setCopying] = useState(false)

  // Instance skill management (enable library skills into this instance)
  const [manageSkillsFor, setManageSkillsFor] = useState<Instance | null>(null)
  const [managePackagesFor, setManagePackagesFor] = useState<Instance | null>(null)

  // Import
  const [importState, setImportState] = useState<"idle" | "loading">("idle")
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Theme (mobile header)
  const [isDark, setIsDark] = useState(() => {
    const saved = localStorage.getItem("theme")
    return saved ? saved === "dark" : true
  })

  const { clearAuth } = useAuthActions()

  const handleToggleTheme = () => {
    setIsDark(!isDark)
    document.documentElement.classList.toggle("dark", !isDark)
    localStorage.setItem("theme", isDark ? "light" : "dark")
    if (toggleTheme) toggleTheme()
  }

  const loadData = async () => {
    setIsLoading(true)
    const [pRes, iRes] = await Promise.all([prototypesApi.list(), instancesApi.list()])
    if (pRes.ok) setPrototypes(pRes.data || [])
    if (iRes.ok) setInstances(iRes.data || [])
    setIsLoading(false)
  }

  useEffect(() => { loadData() }, [])

  const reloadInstances = async () => {
    const res = await instancesApi.list()
    if (res.ok) setInstances(res.data || [])
  }

  // When the detail dialog opens, load the underlying prototype's README
  const openInstanceDialog = (inst: Instance) => {
    setDialogInstance(inst)
    setRenameValue(inst.name)
    setRenaming(false)
    setReadmeData(null)
    if (inst.prototype_id) {
      setReadmeLoading(true)
      prototypesApi.getReadme(inst.prototype_id).then((res) => {
        setReadmeData(res.ok && res.data ? res.data : null)
        setReadmeLoading(false)
      })
    } else {
      setReadmeLoading(false)
    }
  }

  // Auto-open a freshly created instance's dialog once instances reload
  // (used by the bookshelf "create" flow).
  // ---- Actions ----

  const handleContinue = async (inst: Instance) => {
    setActionLoading(true)
    await sessionApi.setActive(inst.id)
    setActiveInstance({ id: inst.id, name: inst.name })
    navigate("/workspace")
  }

  // Create an instance from a prototype, then close the bookshelf and auto-open
  // the new instance's dialog. Returns true on success (drives the bookshelf
  // spinner); the overlay is closed here.
  const handleCreateFromBookshelf = async (protoId: string, name: string): Promise<boolean> => {
    if (!name.trim()) return false
    setActionLoading(true)
    const res = await instancesApi.create(protoId, name.trim())
    setActionLoading(false)
    if (!res.ok || !res.data) {
      toast.error(res.error || "创建失败")
      return false
    }
    const created = res.data
    toast.success(`已创建「${created.name}」`)
    setBookshelfOpen(false)
    // Reload instances, then open the new instance's dialog.
    const fresh = await instancesApi.list()
    if (fresh.ok) {
      setInstances(fresh.data || [])
      const target = (fresh.data || []).find((i) => i.id === created.id)
      if (target) openInstanceDialog(target)
    }
    return true
  }

  const confirmDeletePrototype = async () => {
    if (!protoToDelete) return
    await prototypesApi.delete(protoToDelete.id)
    setProtoToDelete(null)
    await loadData()
  }

  const confirmDeleteInstance = async () => {
    if (!instanceToDelete) return
    await instancesApi.delete(instanceToDelete.id)
    if (dialogInstance?.id === instanceToDelete.id) setDialogInstance(null)
    setInstanceToDelete(null)
    await loadData()
  }

  const openCopyDialog = (inst: Instance) => {
    setInstanceToCopy(inst)
    setCopyName(`${inst.name} 副本`)
    setCopyError("")
  }

  const confirmCopyInstance = async () => {
    if (!instanceToCopy || !copyName.trim()) return
    setCopying(true)
    setCopyError("")
    const res = await instancesApi.copy(instanceToCopy.id, copyName.trim())
    if (res.ok && res.data) {
      toast.success(`已复制为新实例「${res.data.name}」`)
      setInstanceToCopy(null)
      await loadData()
    } else {
      setCopyError(res.error || "复制失败")
    }
    setCopying(false)
  }

  const confirmRename = async () => {
    if (!dialogInstance || !renameValue.trim()) return
    setActionLoading(true)
    const res = await instancesApi.rename(dialogInstance.id, renameValue.trim())
    setActionLoading(false)
    if (res.ok && res.data) {
      setDialogInstance(res.data)
      setRenaming(false)
      await reloadInstances()
      toast.success("已重命名")
    } else {
      toast.error(res.error || "重命名失败")
    }
  }

  const handleDownload = async (proto: Prototype) => {
    if (proto.is_builtin) return
    const url = prototypesApi.downloadUrl(proto.id)
    const a = document.createElement("a")
    a.href = url
    a.download = `${proto.name}.teabrew`
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
      if (res.data.duplicate) toast.info("此原型已存在，无需重复导入")
      else toast.success("原型导入成功")
      await loadData()
    } else {
      toast.error(res.error || "导入失败")
    }
    setImportState("idle")
    if (fileInputRef.current) fileInputRef.current.value = ""
  }

  const sortedByRecent = [...instances].sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0))

  if (isLoading) {
    return (
      <div className="h-full flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  // ============================================================================
  // Shared: bookshelf overlay (rendered on top of either desktop or mobile page)
  // ============================================================================
  return (
    <div className="h-full flex flex-col overflow-hidden relative">
      {isMobile ? (
        <MobileMain
          instances={sortedByRecent}
          onOpenInstance={openInstanceDialog}
          onQuickStart={handleContinue}
          onNew={() => setBookshelfOpen(true)}
          isDark={isDark}
          onToggleTheme={handleToggleTheme}
          onOpenSettings={() => openSettings()}
          onLogout={() => clearAuth()}
        />
      ) : (
        <DesktopMain
          instances={sortedByRecent}
          onOpenInstance={openInstanceDialog}
          onQuickStart={handleContinue}
          onNew={() => setBookshelfOpen(true)}
        />
      )}

      {/* Detail dialog */}
      {dialogInstance && (
        <InstanceDialog
          instance={dialogInstance}
          isMobile={isMobile}
          readmeData={readmeData}
          readmeLoading={readmeLoading}
          renaming={renaming}
          renameValue={renameValue}
          onRenameValue={(v) => setRenameValue(v)}
          onToggleRename={() => { setRenaming(!renaming) }}
          onConfirmRename={confirmRename}
          actionLoading={actionLoading}
          onContinue={() => handleContinue(dialogInstance)}
          onDelete={() => setInstanceToDelete(dialogInstance)}
          onCopy={() => openCopyDialog(dialogInstance)}
          onManageSkills={() => setManageSkillsFor(dialogInstance)}
          onManagePackages={() => setManagePackagesFor(dialogInstance)}
          onClose={() => setDialogInstance(null)}
        />
      )}

      {/* Bookshelf overlay */}
      {bookshelfOpen && (
        <Bookshelf
          prototypes={prototypes}
          importState={importState}
          fileInputRef={fileInputRef}
          onImport={handleImport}
          onClose={() => setBookshelfOpen(false)}
          onCreate={handleCreateFromBookshelf}
          onDownload={handleDownload}
          onDeleteProto={(p) => setProtoToDelete(p)}
        />
      )}

      {/* Instance skill management overlay */}
      {manageSkillsFor && (
        <InstanceSkillsDialog instance={manageSkillsFor} onClose={() => setManageSkillsFor(null)} />
      )}

      {/* Instance prompt-package management overlay */}
      {managePackagesFor && (
        <InstancePackagesDialog instance={managePackagesFor} onClose={() => setManagePackagesFor(null)} />
      )}

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

      {/* Copy instance dialog */}
      {instanceToCopy && (
        <div className="absolute inset-0 bg-black/40 flex items-center justify-center z-50" onClick={() => { if (!copying) setInstanceToCopy(null) }}>
          <div className="bg-background rounded-lg shadow-lg w-full max-w-sm mx-4 p-6 space-y-4" onClick={e => e.stopPropagation()}>
            <h3 className="font-semibold">复制实例</h3>
            <p className="text-xs text-muted-foreground">
              将「{instanceToCopy.name}」复制为一个完整快照副本（新实例、独立 git）。常用于打包原型前保留试玩数据。
            </p>
            <div className="space-y-1">
              <label className="text-sm font-medium">新实例名称</label>
              <Input
                value={copyName}
                onChange={(e) => { setCopyName(e.target.value); setCopyError("") }}
                placeholder="为副本命名"
                autoFocus
              />
            </div>
            {copyError && <p className="text-xs text-red-500">{copyError}</p>}
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setInstanceToCopy(null)} disabled={copying}>取消</Button>
              <Button size="sm" onClick={confirmCopyInstance} disabled={!copyName.trim() || copying}>
                {copying ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                复制
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ============================================================================
// Desktop main — instance-centric waterfall (global top bar lives in MainLayout)
// ============================================================================
function DesktopMain({
  instances, onOpenInstance, onQuickStart, onNew,
}: {
  instances: Instance[]
  onOpenInstance: (i: Instance) => void
  onQuickStart: (i: Instance) => void
  onNew: () => void
}) {
  return (
    <div className="h-full flex flex-col overflow-hidden">
      <div className="flex-1 overflow-y-auto min-h-0">
        {instances.length === 0 ? (
          <SetupGateEmpty onNew={onNew}>
            <DesktopEmptyState onNew={onNew} />
          </SetupGateEmpty>
        ) : (
          <div className="p-8 pt-6">
            <InstanceWaterfall instances={instances} onOpenInstance={onOpenInstance} onQuickStart={onQuickStart} onNew={onNew} />
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * 空实例的空态入口：当模型体系（供应商/模型/槽位）没配好时，显示 Welcome Wizard
 * 引导（不渲染「新建实例」，实现新用户拦截）；配好后再显示正常空态。
 */
function SetupGateEmpty({ children }: { onNew: () => void; children: React.ReactNode }) {
  const { complete } = useSetupStatus()
  if (!complete) return <WelcomeWizard />
  return <>{children}</>
}

function DesktopEmptyState({ onNew }: { onNew: () => void }) {
  return (
    <div className="h-full flex flex-col items-center justify-center text-center gap-4 py-24">
      <div className="text-muted-foreground">
        <BookOpen className="h-12 w-12 mx-auto mb-4 opacity-40" />
        <p className="text-sm mb-1">还没有实例</p>
        <p className="text-xs text-muted-foreground/80">从书架挑一个故事，开始你的第一段冒险</p>
      </div>
      <button
        onClick={onNew}
        className="inline-flex items-center justify-center gap-2 h-10 px-4 rounded-xl border-2 border-dashed border-border text-muted-foreground hover:border-primary hover:text-primary transition-colors"
      >
        <Plus className="h-4 w-4" />
        新建实例
      </button>
    </div>
  )
}

// ============================================================================
// Instance waterfall (masonry) — image-led cards + a leading "new instance" card
// ============================================================================
function InstanceWaterfall({
  instances, onOpenInstance, onQuickStart, onNew,
}: {
  instances: Instance[]
  onOpenInstance: (i: Instance) => void
  onQuickStart: (i: Instance) => void
  onNew: () => void
}) {
  return (
    <div className="columns-2 lg:columns-3 xl:columns-4 2xl:columns-5 gap-6">
      <NewInstanceCard onNew={onNew} />
      {instances.map((inst) => (
        <InstanceMasonCard key={inst.id} instance={inst} onOpen={onOpenInstance} onQuickStart={onQuickStart} />
      ))}
    </div>
  )
}

/** Leading card in the waterfall: same content-driven shape as instance cards, with a dashed box + plus. */
function NewInstanceCard({ onNew }: { onNew: () => void }) {
  return (
    <button
      onClick={onNew}
      className="mb-4 break-inside-avoid flex flex-col rounded-xl overflow-hidden border border-border bg-card hover:border-primary/50 hover:shadow-md transition-all cursor-pointer w-full"
      aria-label="新建实例"
      title="新建实例"
    >
      <div className="shrink-0 p-3">
        <div className="aspect-square w-full flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-muted-foreground/30 hover:border-primary/60 transition-colors text-center">
          <span className="flex items-center justify-center h-12 w-12 rounded-full bg-muted text-muted-foreground">
            <Plus className="h-6 w-6" />
          </span>
          <span className="font-medium text-muted-foreground">新建实例</span>
          <span className="px-6 text-xs text-muted-foreground/70 leading-relaxed">从书架挑一个故事，开始你的第一段冒险</span>
        </div>
      </div>
    </button>
  )
}

function InstanceMasonCard({ instance, onOpen, onQuickStart }: { instance: Instance; onOpen: (i: Instance) => void; onQuickStart: (i: Instance) => void }) {
  return (
    <div
      className="mb-4 break-inside-avoid flex flex-col rounded-xl overflow-hidden border border-border bg-card shadow-sm hover:shadow-md hover:-translate-y-0.5 transition-all cursor-pointer"
      onClick={() => onOpen(instance)}
    >
      <div className="shrink-0 p-3 pb-0">
        <div className="aspect-square w-full overflow-hidden rounded-lg bg-muted">
          <CoverWithFetch kind="instance" id={instance.id} name={instance.name} />
        </div>
      </div>
      <div className="flex items-center gap-3 p-3">
        {/* Left: text stack (title over meta) */}
        <div className="flex-1 min-w-0 flex flex-col">
          <div className="font-semibold text-base leading-snug line-clamp-2">
            {instance.prototype_name ? `${instance.prototype_name} - ${instance.name}` : instance.name}
          </div>
          <div className="flex items-center gap-3 mt-1.5 text-xs text-muted-foreground">
            <span className="flex items-center gap-1">
              <Hash className="h-3.5 w-3.5" />
              {instance.floor_count} 楼
            </span>
            <span className="flex items-center gap-1">
              <Clock className="h-3.5 w-3.5" />
              {formatDateShort(instance.updated_at)}
            </span>
          </div>
        </div>
        {/* Right: square play icon — 快速进入会话 */}
        <button
          className="shrink-0 w-10 h-10 flex items-center justify-center rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-colors cursor-pointer"
          onClick={(e) => { e.stopPropagation(); onQuickStart(instance) }}
          title="快速开始"
          aria-label="快速开始"
        >
          <Play className="h-4 w-4" />
        </button>
      </div>
    </div>
  )
}

function formatDateShort(ts: number) {
  if (!ts) return ""
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

// ============================================================================
// Instance detail dialog — cover + README + continue + rename
// ============================================================================
function InstanceDialog({
  instance, readmeData, readmeLoading, renaming, renameValue, isMobile,
  onRenameValue, onToggleRename, onConfirmRename, actionLoading,
  onContinue, onDelete, onCopy, onClose, onManageSkills, onManagePackages,
}: {
  instance: Instance
  readmeData: { metadata: Record<string, unknown>; readme: string } | null
  readmeLoading: boolean
  renaming: boolean
  renameValue: string
  isMobile: boolean
  onRenameValue: (v: string) => void
  onToggleRename: () => void
  onConfirmRename: () => void
  actionLoading: boolean
  onContinue: () => void
  onDelete: () => void
  onCopy: () => void
  onClose: () => void
  onManageSkills: () => void
  onManagePackages: () => void
}) {
  const htmlContent = readmeData?.readme ? renderText(readmeData.readme, []) : ""
  useDialogBackClose(true, onClose)

  // Mobile: fullscreen sheet; desktop: centered modal above a dimmed backdrop.
  const outer = isMobile
    ? "absolute inset-0 z-50 bg-background flex flex-col overflow-hidden"
    : "absolute inset-0 z-50 flex items-center justify-center p-4 bg-background/70 backdrop-blur-lg"

  const shell = isMobile
    ? "flex-1 min-h-0 flex flex-col overflow-hidden"
    : "bg-background rounded-2xl shadow-2xl border border-border w-[80vw] max-h-[90vh] flex flex-col overflow-hidden relative"

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
    <div className={outer} onClick={isMobile ? undefined : onClose}>
      <div className={shell} onClick={(e) => e.stopPropagation()}>
        {isMobile ? (
          /* ===================== 窄屏：纵向三段式 ===================== */
          <>
            <button
              className="absolute top-3 left-3 z-10 p-2 rounded-full bg-black/30 text-white hover:bg-black/50 cursor-pointer"
              onClick={onClose}
              title="返回"
              aria-label="返回"
            >
              <ArrowLeft className="h-5 w-5" />
            </button>

            {/* Cover band */}
            <div className="relative shrink-0 h-52 w-full overflow-hidden bg-muted">
              <CoverWithFetch
                kind="instance"
                id={instance.id}
                name={instance.name}
                className="h-full"
              />
            </div>

            {/* Body */}
            <div className="flex-1 overflow-y-auto p-6 flex flex-col gap-4">
              <div>
                {renaming ? (
                  <div className="flex items-center gap-2">
                    <Input
                      value={renameValue}
                      onChange={(e) => onRenameValue(e.target.value)}
                      className="h-9 text-base font-medium"
                      autoFocus
                      onKeyDown={(e) => { if (e.key === "Enter") onConfirmRename() }}
                    />
                    <Button size="sm" onClick={onConfirmRename} disabled={!renameValue.trim()} className="shrink-0">
                      {actionLoading && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}
                      确定
                    </Button>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <h2 className="text-xl font-serif font-bold">{instance.name}</h2>
                    <button className="p-1.5 rounded hover:bg-muted text-muted-foreground" onClick={onToggleRename} title="改名">
                      <Pencil className="h-4 w-4" />
                    </button>
                  </div>
                )}
                <div className="flex items-center gap-4 text-xs text-muted-foreground mt-1.5">
                  {instance.prototype_name && <span>来源：{instance.prototype_name}</span>}
                  <span className="flex items-center gap-1"><Hash className="h-3 w-3" />{instance.floor_count} 楼</span>
                  <span className="flex items-center gap-1"><Clock className="h-3 w-3" />{formatDateShort(instance.updated_at)}</span>
                </div>
              </div>

              {/* README */}
              <div className="flex-1">
                {readmeLoading ? (
                  <div className="flex items-center justify-center py-10">
                    <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                  </div>
                ) : htmlContent ? (
                  <div
                    className="prose prose-sm dark:prose-invert max-w-none"
                    dangerouslySetInnerHTML={{ __html: htmlContent }}
                  />
                ) : (
                  <div className="text-sm text-muted-foreground">
                    {instance.prototype_id
                      ? "该原型没有附带 README 介绍。"
                      : "此实例没有关联的原型介绍。"}
                  </div>
                )}
              </div>
            </div>

            {/* Actions */}
            <div className="border-t border-border p-4 flex items-center gap-2 shrink-0">
              <Button className="flex-1 gap-2" onClick={onContinue} disabled={actionLoading}>
                <Play className="h-4 w-4" />
                开始
              </Button>
              <Button variant="outline" onClick={onManageSkills} disabled={actionLoading} title="管理 Skill（从你的 skill 库启用）">
                <BookOpen className="h-4 w-4" />
              </Button>
              <Button variant="outline" onClick={onManagePackages} disabled={actionLoading} title="管理提示词包（从你的包库启用）">
                <Package className="h-4 w-4" />
              </Button>
              <Button variant="outline" onClick={onCopy} disabled={actionLoading} title="复制实例">
                <Copy className="h-4 w-4" />
              </Button>
              <Button variant="outline" className="text-red-500 hover:text-red-500" onClick={onDelete} disabled={actionLoading} title="删除">
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          </>
        ) : (
          /* ===================== 横屏：左右分栏 =====================
             左侧列 = 图片(高度自适应撑满) + 下方功能区(开始/复制/删除)；
             右侧列 = 标题 + markdown(内部滚动)；两列等高。 */
          <>
            {/* Close button — top-right */}
            <button
              className="absolute top-3 right-10 z-10 p-2 rounded-full bg-black/30 text-white hover:bg-black/50 cursor-pointer"
              onClick={onClose}
              title="关闭"
              aria-label="关闭"
            >
              <X className="h-4 w-4" />
            </button>

            <div className="flex-1 min-h-0 p-5 grid grid-cols-[1fr_2fr] gap-8 min-w-0">
              {/* 左侧列(1/3)：写死 1fr 宽，图片铺满该列 */}
              <div className="min-w-0 self-stretch flex flex-col justify-between min-h-0">
                {/* 图片：宽=左列宽(1/3)，高=宽×4/3 健康比例；Cover 填满容器，img object-cover 居中裁剪不拉伸 */}
                <div className="shrink-0 w-full aspect-[3/4] overflow-hidden rounded-xl border border-border bg-card">
                  <CoverWithFetch
                    kind="instance"
                    id={instance.id}
                    name={instance.name}
                    driven="width"
                    className="h-full w-full"
                  />
                </div>

                {/* 功能区：名字+meta + 开始 + 复制/删除，位于图片下方、贴底 */}
                <div className="mt-4 shrink-0 flex flex-col">
                  {/* 名字 + 改名 */}
                  {renaming ? (
                    <div className="flex items-center gap-2">
                      <Input
                        value={renameValue}
                        onChange={(e) => onRenameValue(e.target.value)}
                        className="h-8 text-sm font-medium"
                        autoFocus
                        onKeyDown={(e) => { if (e.key === "Enter") onConfirmRename() }}
                      />
                      <Button size="sm" onClick={onConfirmRename} disabled={!renameValue.trim()} className="shrink-0">
                        {actionLoading && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}
                        确定
                      </Button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-1.5">
                      <h2 className="text-base font-serif font-bold truncate">{instance.name}</h2>
                      <button className="p-1 rounded hover:bg-muted text-muted-foreground shrink-0" onClick={onToggleRename} title="改名">
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  )}

                  {/* meta */}
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground mt-1">
                    {instance.prototype_name && <span>来源：{instance.prototype_name}</span>}
                    <span className="flex items-center gap-1"><Hash className="h-3 w-3" />{instance.floor_count} 楼</span>
                    <span className="flex items-center gap-1"><Clock className="h-3 w-3" />{formatDateShort(instance.updated_at)}</span>
                  </div>

                  {/* 开始 */}
                  <Button className="w-full gap-2 mt-3" onClick={onContinue} disabled={actionLoading}>
                    <Play className="h-4 w-4" />
                    开始
                  </Button>

                  {/* 复制/删除 — 更小 */}
                  <div className="flex items-center gap-2 mt-2">
                    <Button variant="outline" size="sm" className="flex-1 gap-1 h-8 text-xs" onClick={onManageSkills} disabled={actionLoading} title="管理 Skill">
                      <BookOpen className="h-3.5 w-3.5" />Skill
                    </Button>
                    <Button variant="outline" size="sm" className="flex-1 gap-1 h-8 text-xs" onClick={onManagePackages} disabled={actionLoading} title="管理提示词包">
                      <Package className="h-3.5 w-3.5" />提示词包
                    </Button>
                    <Button variant="outline" size="sm" className="flex-1 gap-1 h-8 text-xs" onClick={onCopy} disabled={actionLoading} title="复制实例">
                      <Copy className="h-3.5 w-3.5" />复制
                    </Button>
                    <Button variant="outline" size="sm" className="flex-1 gap-1 h-8 text-xs text-red-500 hover:text-red-500" onClick={onDelete} disabled={actionLoading} title="删除">
                      <Trash2 className="h-3.5 w-3.5" />删除
                    </Button>
                  </div>
                </div>
              </div>

              {/* 右侧列(2fr)：markdown */}
              <div className="min-w-0 min-h-0 flex flex-col">
                <div className="flex-1 min-h-0 overflow-y-auto pr-1">
                  {readmeLoading ? (
                    <div className="py-10 flex items-center justify-center">
                      <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                    </div>
                  ) : htmlContent ? (
                    <div
                      className="prose prose-sm dark:prose-invert max-w-none"
                      dangerouslySetInnerHTML={{ __html: htmlContent }}
                    />
                  ) : (
                    <div className="text-sm text-muted-foreground">
                      {instance.prototype_id
                        ? "该原型没有附带 README 介绍。"
                        : "此实例没有关联的原型介绍。"}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// ============================================================================
// Mobile main — instance list with FAB to open bookshelf
// ============================================================================
function MobileMain({
  instances, onOpenInstance, onQuickStart, onNew, isDark, onToggleTheme, onOpenSettings, onLogout,
}: {
  instances: Instance[]
  onOpenInstance: (i: Instance) => void
  onQuickStart: (i: Instance) => void
  onNew: () => void
  isDark: boolean
  onToggleTheme: () => void
  onOpenSettings: () => void
  onLogout: () => void
}) {
  const [showMenu, setShowMenu] = useState(false)
  return (
    <div className="h-full flex flex-col overflow-hidden">
      <header className="h-14 relative border-b border-border flex items-center justify-between px-3 shrink-0">
        <div className="flex-1 min-w-0 flex flex-col justify-center">
          <span className="font-serif font-semibold text-sm leading-tight">LowStar's Teahouse</span>
          <span className="text-[11px] text-muted-foreground leading-tight truncate">基于 Harness 的交互式小说创作引擎</span>
        </div>
        <button
          className="p-2 rounded hover:bg-muted shrink-0"
          onClick={() => setShowMenu(!showMenu)}
          aria-label="菜单"
        >
          <Settings className="h-5 w-5" />
        </button>
        {showMenu && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setShowMenu(false)} />
            <div className="absolute right-0 top-full mt-1 z-50 bg-background border border-border rounded-md shadow-lg py-1 min-w-[140px]">
              <button className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-muted" onClick={() => { onToggleTheme(); setShowMenu(false) }}>
                {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
                主题切换
              </button>
              <button className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-muted" onClick={() => { onOpenSettings(); setShowMenu(false) }}>
                <Settings className="h-4 w-4" />设置
              </button>
              <button className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-muted text-red-500" onClick={() => { onLogout(); setShowMenu(false) }}>
                <LogOut className="h-4 w-4" />退出登录
              </button>
            </div>
          </>
        )}
      </header>

      <div className="flex-1 overflow-y-auto min-h-0 p-3">
        {instances.length === 0 ? (
          <SetupGateEmpty onNew={onNew}>
            <div className="flex flex-col items-center justify-center text-center gap-4 py-24">
              <BookOpen className="h-10 w-10 text-muted-foreground opacity-40" />
              <p className="text-sm text-muted-foreground">还没有实例</p>
              <button
                onClick={onNew}
                className="inline-flex items-center justify-center gap-2 h-10 px-4 rounded-xl border-2 border-dashed border-border text-muted-foreground hover:border-primary hover:text-primary transition-colors"
              >
                <Plus className="h-4 w-4" />新建实例
              </button>
            </div>
          </SetupGateEmpty>
        ) : (
          <div className="columns-2 gap-3">
            <NewInstanceCard onNew={onNew} />
            {instances.map((inst) => (
              <MobileInstanceCard key={inst.id} instance={inst} onOpen={() => onOpenInstance(inst)} onQuickStart={() => onQuickStart(inst)} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function MobileInstanceCard({ instance, onOpen, onQuickStart }: { instance: Instance; onOpen: () => void; onQuickStart: () => void }) {
  return (
    <div
      className="mb-3 break-inside-avoid flex flex-col rounded-xl overflow-hidden border border-border bg-card shadow-sm cursor-pointer active:scale-[0.98] transition"
      onClick={onOpen}
    >
      <div className="shrink-0 p-2 pb-0">
        <div className="aspect-square w-full overflow-hidden rounded-md bg-muted">
          <CoverWithFetch kind="instance" id={instance.id} name={instance.name} />
        </div>
      </div>
      <div className="flex items-center gap-2 p-2">
        {/* Left: text stack (title over meta) */}
        <div className="flex-1 min-w-0 flex flex-col">
          <div className="font-semibold text-[13px] leading-snug line-clamp-2">
            {instance.prototype_name ? `${instance.prototype_name} - ${instance.name}` : instance.name}
          </div>
          <div className="flex items-center gap-2 mt-1 text-[11px] text-muted-foreground">
            <span className="flex items-center gap-0.5"><Hash className="h-3 w-3" />{instance.floor_count}</span>
            <span className="flex items-center gap-0.5"><Clock className="h-3 w-3" />{formatDateShort(instance.updated_at)}</span>
          </div>
        </div>
        {/* Right: square play icon — 快速进入会话 */}
        <button
          className="shrink-0 w-9 h-9 flex items-center justify-center rounded-md bg-primary text-primary-foreground cursor-pointer"
          onClick={(e) => { e.stopPropagation(); onQuickStart() }}
          title="快速开始"
          aria-label="快速开始"
        >
          <Play className="h-4 w-4" />
        </button>
      </div>
    </div>
  )
}

// ============================================================================
// Bookshelf overlay — floating prototype waterfall, blurs the underlying page
// ============================================================================
function Bookshelf({
  prototypes, importState, fileInputRef, onImport, onClose, onCreate, onDownload, onDeleteProto,
}: {
  prototypes: Prototype[]
  importState: "idle" | "loading"
  fileInputRef: React.RefObject<HTMLInputElement | null>
  onImport: (e: React.ChangeEvent<HTMLInputElement>) => void
  onClose: () => void
  onCreate: (protoId: string, name: string) => Promise<boolean>
  onDownload: (p: Prototype) => void
  onDeleteProto: (p: Prototype) => void
}) {
  const [selected, setSelected] = useState<Prototype | null>(null)
  const mobile = useIsMobile()
  useDialogBackClose(true, onClose)

  // Render the dialog only while the selected prototype still exists, so a
  // delete while it's open simply dismisses it (no effect / cascading render).
  const showDialog = !!selected && prototypes.some((p) => p.id === selected.id)

  return (
    <div className="absolute inset-0 z-40">
      {/* Blur backdrop */}
      <div className="absolute inset-0 bg-background/70 backdrop-blur-lg" onClick={onClose} />

      <div className="absolute inset-0 flex flex-col overflow-hidden px-6 sm:px-10 lg:px-16 py-6 sm:py-8 relative">
        {/* Back arrow — mobile: floating black circle top-left; desktop: inline in the header */}
        {mobile ? (
          <button
            className="absolute top-3 left-3 z-10 p-2 rounded-full bg-black/30 text-white hover:bg-black/50 cursor-pointer"
            onClick={onClose}
            title="关闭书架"
          >
            <ArrowLeft className="h-5 w-5" />
          </button>
        ) : null}
        {/* Bookshelf header */}
        <div className={`flex items-center gap-3 mb-2 shrink-0 ${mobile ? "pl-10" : ""}`}>
          <h2 className="text-lg sm:text-xl font-serif font-bold">书架 · 选择故事</h2>
          <div className="flex-1" />
          <input
            ref={fileInputRef}
            type="file"
            accept=".teabrew,.zip"
            className="hidden"
            onChange={onImport}
          />
          {!mobile ? (
            /* 横屏：更明显的导入按钮 + 右上角关闭 */
            <>
              <Button
                variant={prototypes.length === 0 ? "outline" : "secondary"}
                size="sm"
                className="gap-1.5"
                disabled={importState === "loading"}
                onClick={() => fileInputRef.current?.click()}
              >
                {importState === "loading" ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Upload className="h-3.5 w-3.5" />
                )}
                导入原型
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5"
                onClick={onClose}
              >
                <X className="h-3.5 w-3.5" />
                关闭
              </Button>
            </>
          ) : (
            <button
              className="p-2 rounded hover:bg-muted text-muted-foreground"
              disabled={importState === "loading"}
              onClick={() => fileInputRef.current?.click()}
              title="导入原型"
            >
              {importState === "loading" ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Upload className="h-4 w-4" />
              )}
            </button>
          )}
        </div>

        <p className="text-xs text-muted-foreground mb-4 shrink-0">
          挑一本，开始一段新的故事。点击封面查看介绍，点「创建」开始。
        </p>

        {/* Prototype waterfall — clicking non-card area closes the shelf (landscape) */}
        <div
          className="h-full overflow-y-auto min-h-0"
          onClick={() => { if (!mobile) onClose() }}
        >
          {prototypes.length === 0 ? (
            <div className="flex flex-col items-center justify-center text-center gap-3 py-24">
              <BookOpen className="h-12 w-12 text-muted-foreground opacity-40" />
              <p className="text-sm text-muted-foreground">书架空空如也</p>
              <Button variant="outline" className="gap-2" onClick={() => fileInputRef.current?.click()}>
                <Upload className="h-4 w-4" />导入原型
              </Button>
            </div>
          ) : (
            <div className="columns-2 md:columns-3 lg:columns-4 xl:columns-5 gap-6 pb-8">
              {prototypes.map((p) => (
                <BookshelfCard key={p.id} proto={p} onSelect={() => setSelected(p)} />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Prototype detail dialog — floats above the shelf */}
      {showDialog && selected && (
        <PrototypeDetailDialog
          prototype={selected}
          isMobile={mobile}
          onClose={() => setSelected(null)}
          onCreate={onCreate}
          onDownload={onDownload}
          onDeleteProto={onDeleteProto}
        />
      )}
    </div>
  )
}

// ============================================================================
// Prototype detail dialog — floats above the bookshelf. Three-section layout
// matching the instance dialog: cover band / README / bottom create bar.
// Top-left back arrow closes it; mobile renders fullscreen.
// ============================================================================
function PrototypeDetailDialog({
  prototype, isMobile, onClose, onCreate, onDownload, onDeleteProto,
}: {
  prototype: Prototype
  isMobile: boolean
  onClose: () => void
  onCreate: (protoId: string, name: string) => Promise<boolean>
  onDownload: (p: Prototype) => void
  onDeleteProto: (p: Prototype) => void
}) {
  const [readmeData, setReadmeData] = useState<{ metadata: Record<string, unknown>; readme: string } | null>(null)
  // Starts loading on mount; reset before fetching a (new) prototype's README.
  const [readmeLoading, setReadmeLoading] = useState(true)
  const [instanceName, setInstanceName] = useState("")
  const [error, setError] = useState("")
  const [creating, setCreating] = useState(false)
  // 详情是书架子层级：系统返回先关详情（回书架），再关书架（回大厅）
  useDialogBackClose(true, onClose)

  // Load README for the selected prototype (dialog remounts per prototype with
  // fresh initial state, so no synchronous reset here).
  useEffect(() => {
    let cancelled = false
    prototypesApi.getReadme(prototype.id).then((res) => {
      if (cancelled) return
      setReadmeData(res.ok && res.data ? res.data : null)
      setReadmeLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [prototype.id])

  // Inject BBCode animation CSS + tooltip script (same as the instance dialog).
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

  const htmlContent = readmeData?.readme ? renderText(readmeData.readme, []) : ""

  const doCreate = async () => {
    if (!instanceName.trim()) return
    setCreating(true)
    setError("")
    const ok = await onCreate(prototype.id, instanceName)
    setCreating(false)
    if (!ok) setError("创建失败，请重试")
  }

  // Mobile: fullscreen sheet; desktop: centered modal above the blurred shelf.
  const outer = isMobile
    ? "absolute inset-0 z-50 bg-background flex flex-col overflow-hidden"
    : "absolute inset-0 z-50 flex items-center justify-center bg-background/70 backdrop-blur-lg p-4"

  const shell = isMobile
    ? "flex-1 min-h-0 flex flex-col overflow-hidden"
    : "bg-background rounded-2xl shadow-2xl border border-border w-[80vw] max-h-[90vh] flex flex-col overflow-hidden relative"

  return (
    <div className={outer} onClick={isMobile ? undefined : onClose}>
      <div className={shell} onClick={(e) => e.stopPropagation()}>
        {isMobile ? (
          /* ===================== 窄屏：纵向三段式 ===================== */
          <>
            {/* Close button — floating top-left */}
            <button
              className="absolute top-3 left-3 z-10 p-2 rounded-full bg-black/30 text-white hover:bg-black/50 cursor-pointer"
              onClick={onClose}
              title="返回书架"
              aria-label="返回书架"
            >
              <ArrowLeft className="h-5 w-5" />
            </button>

            {/* Cover band */}
            <div className="relative shrink-0 h-44 sm:h-60 w-full overflow-hidden bg-muted">
              <CoverWithFetch kind="prototype" id={prototype.id} name={prototype.name} className="h-full" />
              <div className="absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-black/60 to-transparent" />
              <div className="absolute bottom-0 left-0 right-0 p-3.5 flex items-center gap-2 text-white">
                <h3 className="font-semibold text-lg truncate">{prototype.name}</h3>
                {prototype.is_builtin ? (
                  <span className="text-[10px] text-white/90 bg-white/25 px-1.5 py-0.5 rounded shrink-0">内置</span>
                ) : null}
                {!prototype.is_builtin && (
                  <div className="flex-1 flex items-center justify-end gap-1.5">
                    <button
                      className="p-2 rounded-full bg-black/30 text-white hover:bg-black/50 cursor-pointer"
                      onClick={() => onDownload(prototype)}
                      title="下载"
                    >
                      <Download className="h-4 w-4" />
                    </button>
                    <button
                      className="p-2 rounded-full bg-black/30 text-white hover:bg-red-600/80 cursor-pointer"
                      onClick={() => onDeleteProto(prototype)}
                      title="删除"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                )}
              </div>
            </div>

            {/* README */}
            <div className="flex-1 min-h-0 overflow-y-auto p-5 pb-2">
              {readmeLoading ? (
                <div className="py-10 flex items-center justify-center">
                  <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                </div>
              ) : htmlContent ? (
                <div
                  className="prose prose-sm dark:prose-invert max-w-none"
                  dangerouslySetInnerHTML={{ __html: htmlContent }}
                />
              ) : (
                <div className="text-sm text-muted-foreground">该原型没有 README 介绍。</div>
              )}
            </div>

            {/* Bottom create bar */}
            <div className="border-t border-border p-4 flex items-end gap-2 shrink-0">
              <div className="flex-1 min-w-0 flex flex-col gap-1">
                <label className="text-xs text-muted-foreground">给这个新实例起个名字</label>
                <Input
                  value={instanceName}
                  onChange={(e) => { setInstanceName(e.target.value); setError("") }}
                  placeholder="实例名称"
                  onKeyDown={(e) => { if (e.key === "Enter") doCreate() }}
                />
                {error && <p className="text-xs text-red-500">{error}</p>}
              </div>
              <Button onClick={doCreate} disabled={!instanceName.trim() || creating} className="shrink-0 gap-1.5 h-10 px-4">
                {creating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
                创建
              </Button>
            </div>
          </>
        ) : (
          /* ===================== 横屏：左右分栏 =====================
             左侧列 = 图片(高度自适应撑满) + 下方功能区；
             右侧列 = 标题 + markdown(内部滚动)；
             两列等高，图片高度 + 功能区高度 = markdown 高度。 */
          <>
            {/* Close button — top-right */}
            <button
              className="absolute top-3 right-10 z-10 p-2 rounded-full bg-black/30 text-white hover:bg-black/50 cursor-pointer"
              onClick={onClose}
              title="关闭"
              aria-label="关闭"
            >
              <X className="h-4 w-4" />
            </button>

            <div className="flex-1 min-h-0 p-5 grid grid-cols-[1fr_2fr] gap-8 min-w-0">
              {/* 左侧列(1fr)：写死 1fr 宽；图片高度自适应收缩填入左栏除去功能区的剩余高度，
                  避免自建原型多出「下载/删除」一行时把弹窗撑高。 */}
              <div className="min-w-0 self-stretch flex flex-col justify-between min-h-0">
                {/* 图片：flex-1 填满剩余空间，Cover object-cover 裁剪不拉伸 */}
                <div className="flex-1 min-h-0 w-full overflow-hidden rounded-xl border border-border bg-card">
                  <CoverWithFetch
                    kind="prototype"
                    id={prototype.id}
                    name={prototype.name}
                    driven="width"
                    className="h-full w-full"
                  />
                </div>

                {/* 功能区：名字+badge + 创建 + 下载/删除，位于图片下方、贴底 */}
                <div className="mt-4 shrink-0 flex flex-col">
                  {/* 名字 + 内置 badge */}
                  <div className="flex items-center gap-1.5">
                    <h3 className="text-base font-serif font-bold truncate">{prototype.name}</h3>
                    {prototype.is_builtin ? (
                      <span className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded shrink-0">内置</span>
                    ) : null}
                  </div>

                  <label className="text-xs text-muted-foreground mt-3">给这个新实例起个名字</label>
                  <Input
                    className="mt-1"
                    value={instanceName}
                    onChange={(e) => { setInstanceName(e.target.value); setError("") }}
                    placeholder="实例名称"
                    onKeyDown={(e) => { if (e.key === "Enter") doCreate() }}
                  />
                  {error && <p className="text-xs text-red-500 mt-1">{error}</p>}
                  <Button onClick={doCreate} disabled={!instanceName.trim() || creating} className="w-full mt-2 gap-1.5">
                    {creating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
                    创建实例
                  </Button>

                  {!prototype.is_builtin && (
                    <div className="flex items-center gap-2 mt-3">
                      <Button variant="outline" size="sm" className="flex-1 gap-1 h-8 text-xs" onClick={() => onDownload(prototype)}>
                        <Download className="h-3.5 w-3.5" />下载
                      </Button>
                      <Button variant="outline" size="sm" className="flex-1 gap-1 h-8 text-xs text-red-500 hover:text-red-500" onClick={() => onDeleteProto(prototype)}>
                        <Trash2 className="h-3.5 w-3.5" />删除
                      </Button>
                    </div>
                  )}
                </div>
              </div>

              {/* 右侧列(2fr)：纯 markdown */}
              <div className="min-w-0 min-h-0 flex flex-col">
                <div className="flex-1 min-h-0 overflow-y-auto pr-1">
                  {readmeLoading ? (
                    <div className="py-10 flex items-center justify-center">
                      <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                    </div>
                  ) : htmlContent ? (
                    <div
                      className="prose prose-sm dark:prose-invert max-w-none"
                      dangerouslySetInnerHTML={{ __html: htmlContent }}
                    />
                  ) : (
                    <div className="text-sm text-muted-foreground">该原型没有 README 介绍。</div>
                  )}
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function BookshelfCard({ proto, onSelect }: { proto: Prototype; onSelect: (p: Prototype) => void }) {
  return (
    <div
      className="mb-6 break-inside-avoid rounded-xl overflow-hidden border border-border bg-card shadow-sm hover:shadow-md hover:-translate-y-0.5 transition-all cursor-pointer"
      onClick={(e) => { e.stopPropagation(); onSelect(proto) }}
    >
      <CoverWithFetch kind="prototype" id={proto.id} name={proto.name} />
      <div className="p-3">
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
    </div>
  )
}

// ── Instance skill management ──────────────────────────────────────
// Lists the user's skill library + which skills this instance has enabled.
// Enabling copies a library skill into the instance; removing deletes it there.
function InstanceSkillsDialog({ instance, onClose }: { instance: Instance; onClose: () => void }) {
  useDialogBackClose(true, onClose)

  const [library, setLibrary] = useState<MySkill[]>([])
  const [enabled, setEnabled] = useState<InstanceSkill[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState("")
  const [removeTarget, setRemoveTarget] = useState<string | null>(null)

  const reload = useCallback(async () => {
    setError("")
    const [libRes, instRes] = await Promise.all([
      skillsApi.listMy(),
      skillsApi.listForInstance(instance.id),
    ])
    if (libRes.ok) setLibrary(libRes.data!.skills)
    if (instRes.ok) setEnabled(instRes.data!.filter(s => s.source === "instance" && s.has_skill))
    setLoading(false)
  }, [instance.id])

  useEffect(() => { reload() }, [reload])

  const enabledNames = new Set(enabled.map(s => s.name))

  const handleEnable = async (name: string) => {
    setBusy(name)
    setError("")
    const res = await skillsApi.enableFromLibrary(instance.id, name)
    setBusy(null)
    if (!res.ok) setError(res.error || "启用失败")
    else await reload()
  }

  const handleConfirmRemove = async () => {
    if (!removeTarget) return
    setBusy(removeTarget)
    setError("")
    const res = await skillsApi.removeFromInstance(instance.id, removeTarget)
    setBusy(null)
    setRemoveTarget(null)
    if (!res.ok) setError(res.error || "移除失败")
    else await reload()
  }

  return (
    <div className="absolute inset-0 z-[60] bg-background/70 backdrop-blur-lg flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-background rounded-2xl shadow-2xl border border-border w-[80vw] max-w-md max-h-[85vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <div>
            <div className="font-semibold flex items-center gap-2">
              <BookOpen className="h-4 w-4 text-muted-foreground" />
              Skill 管理
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">为「{instance.name}」启用或移除 skill</p>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground cursor-pointer">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-3">
          {error && (
            <div className="text-xs text-red-600 bg-red-500/5 border border-red-500/20 rounded-md px-3 py-2">{error}</div>
          )}

          <div className="text-xs font-medium text-muted-foreground">该实例已启用的 skill</div>
          {loading ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground py-2">
              <Loader2 className="h-3 w-3 animate-spin" /> 加载中…
            </div>
          ) : enabled.length === 0 ? (
            <p className="text-xs text-muted-foreground">尚未启用任何 skill</p>
          ) : (
            <div className="space-y-2">
              {enabled.map(s => (
                <div key={s.name} className="flex items-center justify-between rounded-lg border px-3 py-2">
                  <span className="text-sm">{s.name}</span>
                  <Button
                    size="sm"
                    variant="outline"
                    className="text-red-500 hover:text-red-500 h-7 text-xs"
                    onClick={() => setRemoveTarget(s.name)}
                    disabled={busy === s.name}
                  >
                    {busy === s.name ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3 mr-1" />}
                    移除
                  </Button>
                </div>
              ))}
            </div>
          )}

          <div className="text-xs font-medium text-muted-foreground pt-3 border-t border-border">
            从你的 skill 库添加
          </div>
          {loading ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground py-2">
              <Loader2 className="h-3 w-3 animate-spin" /> 加载中…
            </div>
          ) : library.length === 0 ? (
            <p className="text-xs text-muted-foreground">你的 skill 库还是空的，可先在设置页「Skill 管理」导入，或在实例里导出。</p>
          ) : (
            <div className="space-y-2">
              {library.map(s => {
                const isEnabled = enabledNames.has(s.name)
                return (
                  <div key={s.name} className="flex items-center justify-between rounded-lg border px-3 py-2">
                    <div className="min-w-0">
                      <div className="text-sm truncate">{s.name}</div>
                      {isEnabled && <div className="text-[10px] text-emerald-600 dark:text-emerald-400">已启用</div>}
                    </div>
                    {isEnabled ? (
                      <span className="text-[11px] text-muted-foreground shrink-0">已在实例中</span>
                    ) : (
                      <Button
                        size="sm"
                        className="h-7 text-xs"
                        onClick={() => handleEnable(s.name)}
                        disabled={busy === s.name}
                      >
                        {busy === s.name ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3 mr-1" />}
                        启用
                      </Button>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={removeTarget !== null}
        title="移除 skill"
        message={`确定移除「${removeTarget}」吗？这只会从该实例删除，你的 skill 库里仍保留。`}
        variant="destructive"
        confirmText="移除"
        onConfirm={handleConfirmRemove}
        onCancel={() => setRemoveTarget(null)}
      />
    </div>
  )
}

function InstancePackagesDialog({ instance, onClose }: { instance: Instance; onClose: () => void }) {
  useDialogBackClose(true, onClose)

  const [library, setLibrary] = useState<MyPackage[]>([])
  const [enabled, setEnabled] = useState<InstancePackage[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState("")
  const [removeTarget, setRemoveTarget] = useState<string | null>(null)

  const reload = useCallback(async () => {
    setError("")
    const [libRes, instRes] = await Promise.all([
      packagesApi.listMy(),
      packagesApi.listInInstance(instance.id),
    ])
    if (libRes.ok) setLibrary(libRes.data!.packages)
    if (instRes.ok) setEnabled(instRes.data!.packages)
    setLoading(false)
  }, [instance.id])

  useEffect(() => { reload() }, [reload])

  const enabledNames = new Set(enabled.map(p => p.name))

  const handleEnable = async (name: string) => {
    setBusy(name)
    setError("")
    const res = await packagesApi.enableInInstance(instance.id, name)
    setBusy(null)
    if (!res.ok) setError(res.error || "启用失败")
    else await reload()
  }

  const handleConfirmRemove = async () => {
    if (!removeTarget) return
    setBusy(removeTarget)
    setError("")
    const res = await packagesApi.removeFromInstance(instance.id, removeTarget)
    setBusy(null)
    setRemoveTarget(null)
    if (!res.ok) setError(res.error || "移除失败")
    else await reload()
  }

  return (
    <div className="absolute inset-0 z-[60] bg-background/70 backdrop-blur-lg flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-background rounded-2xl shadow-2xl border border-border w-[80vw] max-w-md max-h-[85vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <div>
            <div className="font-semibold flex items-center gap-2">
              <Package className="h-4 w-4 text-muted-foreground" />
              提示词包管理
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">为「{instance.name}」启用或移除提示词包</p>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground cursor-pointer">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-3">
          {error && (
            <div className="text-xs text-red-600 bg-red-500/5 border border-red-500/20 rounded-md px-3 py-2">{error}</div>
          )}

          <div className="text-xs font-medium text-muted-foreground">该实例已启用的提示词包</div>
          {loading ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground py-2">
              <Loader2 className="h-3 w-3 animate-spin" /> 加载中…
            </div>
          ) : enabled.length === 0 ? (
            <p className="text-xs text-muted-foreground">尚未启用任何提示词包</p>
          ) : (
            <div className="space-y-2">
              {enabled.map(p => (
                <div key={p.name} className="flex items-center justify-between rounded-lg border px-3 py-2">
                  <span className="text-sm">{p.name}</span>
                  <Button
                    size="sm"
                    variant="outline"
                    className="text-red-500 hover:text-red-500 h-7 text-xs"
                    onClick={() => setRemoveTarget(p.name)}
                    disabled={busy === p.name}
                  >
                    {busy === p.name ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3 mr-1" />}
                    卸载
                  </Button>
                </div>
              ))}
            </div>
          )}

          <div className="text-xs font-medium text-muted-foreground pt-3 border-t border-border">
            从你的提示词包库添加
          </div>
          {loading ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground py-2">
              <Loader2 className="h-3 w-3 animate-spin" /> 加载中…
            </div>
          ) : library.length === 0 ? (
            <p className="text-xs text-muted-foreground">你的提示词包库还是空的，可先在设置页「提示词包」导入，或在实例里导出。</p>
          ) : (
            <div className="space-y-2">
              {library.map(p => {
                const isEnabled = enabledNames.has(p.name)
                return (
                  <div key={p.name} className="flex items-center justify-between rounded-lg border px-3 py-2">
                    <div className="min-w-0">
                      <div className="text-sm truncate">{p.name}</div>
                      {isEnabled && <div className="text-[10px] text-emerald-600 dark:text-emerald-400">已启用</div>}
                    </div>
                    {isEnabled ? (
                      <span className="text-[11px] text-muted-foreground shrink-0">已在实例中</span>
                    ) : (
                      <Button
                        size="sm"
                        className="h-7 text-xs"
                        onClick={() => handleEnable(p.name)}
                        disabled={busy === p.name}
                      >
                        {busy === p.name ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3 mr-1" />}
                        启用
                      </Button>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={removeTarget !== null}
        title="卸载提示词包"
        message={`确定卸载「${removeTarget}」吗？这只会从该实例包库删除，你的提示词包库里仍保留。`}
        variant="destructive"
        confirmText="卸载"
        onConfirm={handleConfirmRemove}
        onCancel={() => setRemoveTarget(null)}
      />
    </div>
  )
}

