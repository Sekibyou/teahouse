import { useEffect, useState, useRef } from "react"
import { useTranslation } from "react-i18next"
import { useNavigate, useOutletContext } from "react-router-dom"
import { Loader2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { AnimatePresence } from "motion/react"
import { ConfirmDialog } from "@/components/ConfirmDialog"
import { prototypesApi, instancesApi, sessionApi } from "@/lib/api"
import { useAuthActions } from "@/stores/authStore"
import { useSessionStore } from "@/stores/sessionStore"
import { useSettingsDialogStore } from "@/stores/settingsDialogStore"
import { useIsMobile } from "@/hooks/useMediaQuery"
import { AuroraBackground } from "@/components/AuroraBackground"
import { DesktopMain } from "./SessionSelectPageComps/DesktopMain"
import { MobileMain } from "./SessionSelectPageComps/MobileMain"
import { InstanceDialog } from "./SessionSelectPageComps/InstanceDialog"
import { Bookshelf } from "./SessionSelectPageComps/Bookshelf"
import { InstanceSkillsDialog } from "./SessionSelectPageComps/InstanceSkillsDialog"
import { InstancePackagesDialog } from "./SessionSelectPageComps/InstancePackagesDialog"
import type { Prototype, Instance } from "@/lib/types"

export function SessionSelectPage() {
  const { t } = useTranslation("session")
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
      toast.error(res.error || t("create.fail"))
      return false
    }
    const created = res.data
    toast.success(t("create.created", { name: created.name }))
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
    setCopyName(t("copy.suffix", { name: inst.name }))
    setCopyError("")
  }

  const confirmCopyInstance = async () => {
    if (!instanceToCopy || !copyName.trim()) return
    setCopying(true)
    setCopyError("")
    const res = await instancesApi.copy(instanceToCopy.id, copyName.trim())
    if (res.ok && res.data) {
      toast.success(t("copy.copied", { name: res.data.name }))
      setInstanceToCopy(null)
      await loadData()
    } else {
      setCopyError(res.error || t("copy.fail"))
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
      toast.success(t("rename.renamed"))
    } else {
      toast.error(res.error || t("rename.fail"))
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
      if (res.data.duplicate) toast.info(t("import.duplicate"))
      else toast.success(t("import.success"))
      await loadData()
    } else {
      toast.error(res.error || t("import.fail"))
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
    // isolate：给背景一个自己的层叠上下文，-z-10 只沉到本页内容之下、
    // 不会穿到 MainLayout 的 bg-background 后面去（那样就完全看不见了）
    <div className="h-full flex flex-col overflow-hidden relative isolate">
      <AuroraBackground />
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
      <AnimatePresence>
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
      </AnimatePresence>

      {/* Bookshelf overlay */}
      <AnimatePresence>
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
      </AnimatePresence>

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
        title={t("deleteProto.title")}
        message={t("deleteProto.message", { name: protoToDelete?.name })}
        variant="destructive"
        confirmText={t("common:delete")}
        onConfirm={confirmDeletePrototype}
        onCancel={() => setProtoToDelete(null)}
      />

      {/* Confirm delete instance */}
      <ConfirmDialog
        open={instanceToDelete !== null}
        title={t("deleteInstance.title")}
        message={t("deleteInstance.message", { name: instanceToDelete?.name })}
        variant="destructive"
        confirmText={t("common:delete")}
        onConfirm={confirmDeleteInstance}
        onCancel={() => setInstanceToDelete(null)}
      />

      {/* Copy instance dialog */}
      {instanceToCopy && (
        <div className="absolute inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50" onClick={() => { if (!copying) setInstanceToCopy(null) }}>
          <div className="bg-background rounded-lg shadow-lg w-full max-w-sm mx-4 p-6 space-y-4" onClick={e => e.stopPropagation()}>
            <h3 className="font-semibold">{t("copy.title")}</h3>
            <p className="text-xs text-muted-foreground">
              {t("copy.desc", { name: instanceToCopy.name })}
            </p>
            <div className="space-y-1">
              <label className="text-sm font-medium">{t("copy.nameLabel")}</label>
              <Input
                value={copyName}
                onChange={(e) => { setCopyName(e.target.value); setCopyError("") }}
                placeholder={t("copy.namePh")}
                autoFocus
              />
            </div>
            {copyError && <p className="text-xs text-red-500">{copyError}</p>}
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setInstanceToCopy(null)} disabled={copying}>{t("common:cancel")}</Button>
              <Button size="sm" onClick={confirmCopyInstance} disabled={!copyName.trim() || copying}>
                {copying ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                {t("copy.submit")}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

