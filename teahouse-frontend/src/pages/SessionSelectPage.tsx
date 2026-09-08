import { useEffect, useState, useRef } from "react"
import { useTranslation } from "react-i18next"
import { useNavigate, useOutletContext } from "react-router-dom"
import { Loader2 } from "lucide-react"
import { toast } from "sonner"
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
import { Bookshelf } from "./SessionSelectPageComps/Bookshelf"
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

  // Detail moved to its own route page (/instances/:id → InstanceDetailPage); list page keeps no detail state.

  // Bookshelf overlay (new instance)
  const [bookshelfOpen, setBookshelfOpen] = useState(false)

  // Delete confirmations
  // 书架内删除原型用
  const [protoToDelete, setProtoToDelete] = useState<Prototype | null>(null)

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

  // 点卡片打开详情路由页；书架创建后也跳详情页
  const openDetailRoute = (inst: Instance) => {
    navigate(`/instances/${inst.id}`)
  }

  // 卡片播放钮：快速进入会话（不经详情），列表 → /workspace 两级真实路由
  const quickStart = async (inst: Instance) => {
    await sessionApi.setActive(inst.id)
    setActiveInstance({ id: inst.id, name: inst.name })
    navigate("/workspace")
  }

  // Create an instance from a prototype, then close the bookshelf and open the
  // new instance's detail route. Returns true on success (drives the spinner).
  const handleCreateFromBookshelf = async (protoId: string, name: string): Promise<boolean> => {
    if (!name.trim()) return false
    const res = await instancesApi.create(protoId, name.trim())
    if (!res.ok || !res.data) {
      toast.error(res.error || t("create.fail"))
      return false
    }
    const created = res.data
    toast.success(t("create.created", { name: created.name }))
    setBookshelfOpen(false)
    // Reload instances, then open the new instance's detail route.
    const fresh = await instancesApi.list()
    if (fresh.ok) {
      setInstances(fresh.data || [])
      const target = (fresh.data || []).find((i) => i.id === created.id)
      if (target) openDetailRoute(target)
    }
    return true
  }

  const confirmDeletePrototype = async () => {
    if (!protoToDelete) return
    await prototypesApi.delete(protoToDelete.id)
    setProtoToDelete(null)
    await loadData()
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
          onOpenInstance={openDetailRoute}
          onQuickStart={quickStart}
          onNew={() => setBookshelfOpen(true)}
          isDark={isDark}
          onToggleTheme={handleToggleTheme}
          onOpenSettings={() => openSettings()}
          onLogout={() => clearAuth()}
        />
      ) : (
        <DesktopMain
          instances={sortedByRecent}
          onOpenInstance={openDetailRoute}
          onQuickStart={quickStart}
          onNew={() => setBookshelfOpen(true)}
        />
      )}

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
    </div>
  )
}

