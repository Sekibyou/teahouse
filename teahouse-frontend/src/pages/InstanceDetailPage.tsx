import { useEffect, useState, useCallback } from "react"
import { useTranslation } from "react-i18next"
import { useNavigate, useParams } from "react-router-dom"
import { Loader2, ArrowLeft } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { instancesApi, prototypesApi, sessionApi } from "@/lib/api"
import { useSessionStore } from "@/stores/sessionStore"
import { useIsMobile } from "@/hooks/useMediaQuery"
import { InstanceDialog } from "./SessionSelectPageComps/InstanceDialog"
import { InstanceSkillsDialog } from "./SessionSelectPageComps/InstanceSkillsDialog"
import { InstancePackagesDialog } from "./SessionSelectPageComps/InstancePackagesDialog"
import { InstanceCopyDialog } from "./SessionSelectPageComps/InstanceCopyDialog"
import { ConfirmDialog } from "@/components/ConfirmDialog"
import type { Instance } from "@/lib/types"

/**
 * Instance detail — real route page (/instances/:id).
 *
 * History architecture: 列表(/ ) → 详情(/instances/:id) → workspace(/workspace) 三层全是 react-router
 * 真实条目，详情不再用 useDialogBackClose 压裸假条目（那是旧弹层方案；假条目夹在真实路由间会把
 * react-router 的导航序号写坏、导致移动端退出确认(useBlocker)失效）。页面自取数据、自管各子流程。
 */
export function InstanceDetailPage() {
  const { t } = useTranslation("session")
  const navigate = useNavigate()
  const { id } = useParams<{ id: string }>()
  const isMobile = useIsMobile()
  const setActiveInstance = useSessionStore((s) => s.setActiveInstance)

  const [instance, setInstance] = useState<Instance | null>(null)
  const [notFound, setNotFound] = useState(false)
  const [loading, setLoading] = useState(true)

  const [readmeData, setReadmeData] = useState<{ metadata: Record<string, unknown>; readme: string } | null>(null)
  const [readmeLoading, setReadmeLoading] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState("")
  const [actionLoading, setActionLoading] = useState(false)

  const [instanceToDelete, setInstanceToDelete] = useState<Instance | null>(null)
  const [copying, setCopying] = useState<Instance | null>(null)
  const [manageSkillsFor, setManageSkillsFor] = useState<Instance | null>(null)
  const [managePackagesFor, setManagePackagesFor] = useState<Instance | null>(null)

  const loadInstance = useCallback(async () => {
    if (!id) return
    setLoading(true)
    const res = await instancesApi.list()
    if (res.ok) {
      const found = (res.data ?? []).find((i) => i.id === id)
      if (found) {
        setInstance(found)
        setRenameValue(found.name)
        setNotFound(false)
        // 载入 README
        setReadmeData(null)
        if (found.prototype_id) {
          setReadmeLoading(true)
          prototypesApi.getReadme(found.prototype_id).then((r) => {
            setReadmeData(r.ok && r.data ? r.data : null)
            setReadmeLoading(false)
          })
        } else {
          setReadmeLoading(false)
        }
      } else {
        setNotFound(true)
      }
    }
    setLoading(false)
  }, [id])

  useEffect(() => { loadInstance() }, [loadInstance])

  const handleContinue = async () => {
    if (!instance) return
    setActionLoading(true)
    await sessionApi.setActive(instance.id)
    setActiveInstance({ id: instance.id, name: instance.name })
    setActionLoading(false)
    navigate("/workspace")
  }

  const confirmRename = async () => {
    if (!instance || !renameValue.trim()) return
    setActionLoading(true)
    const res = await instancesApi.rename(instance.id, renameValue.trim())
    setActionLoading(false)
    if (res.ok && res.data) {
      setInstance(res.data)
      setRenameValue(res.data.name)
      setRenaming(false)
      toast.success(t("rename.renamed"))
    } else {
      toast.error(res.error || t("rename.fail"))
    }
  }

  const confirmDeleteInstance = async () => {
    if (!instanceToDelete) return
    await instancesApi.delete(instanceToDelete.id)
    setInstanceToDelete(null)
    toast.success(t("deleteInstance.done"))
    navigate("/", { replace: true })
  }

  // ESC 返回上一层(列表)：仅当没有子弹层(技能/包/复制/删除确认/改名)打开时生效，
  // 否则会让子弹层自行关闭的 ESC 冒泡到页面把整个详情关掉。
  const overlayBusy = !!manageSkillsFor || !!managePackagesFor || !!copying || instanceToDelete !== null || renaming
  useEffect(() => {
    if (overlayBusy) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault()
        navigate(-1)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [overlayBusy, navigate])

  // ── Loading / not-found / not-mobile-independent skeleton ──
  if (loading) {
    return (
      <div className="h-full flex items-center justify-center bg-background">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (notFound || !instance) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-4 bg-background px-6 text-center">
        <p className="text-sm text-muted-foreground">{t("detail.notFound")}</p>
        <Button variant="outline" size="sm" onClick={() => navigate("/")}>{t("common:back")}</Button>
      </div>
    )
  }

  // ── Route page container (mobile/desktop full-screen; floating back button) ──
  return (
    <div className="h-full flex flex-col overflow-hidden bg-background relative">
      {/* 悬浮返回钮：胶囊式、带文字，明显可点 */}
      <button
        className="absolute top-3 left-3 z-30 inline-flex items-center gap-2 pl-3 pr-4 py-2 rounded-full bg-background/80 backdrop-blur border border-border text-foreground shadow-lg hover:bg-background cursor-pointer transition-colors"
        onClick={() => navigate(-1)}
        title={t("common:back")}
        aria-label={t("common:back")}
      >
        <ArrowLeft className="h-4.5 w-4.5" />
        <span className="text-sm font-medium">{t("common:back")}</span>
      </button>

      {/* 内容：InstanceDialog 去掉弹层壳后作为详情正文 */}
      <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
        <InstanceDialog
          instance={instance}
          isMobile={isMobile}
          readmeData={readmeData}
          readmeLoading={readmeLoading}
          renaming={renaming}
          renameValue={renameValue}
          onRenameValue={setRenameValue}
          onToggleRename={() => setRenaming(!renaming)}
          onConfirmRename={confirmRename}
          actionLoading={actionLoading}
          onContinue={handleContinue}
          onDelete={() => setInstanceToDelete(instance)}
          onCopy={() => setCopying(instance)}
          onManageSkills={() => setManageSkillsFor(instance)}
          onManagePackages={() => setManagePackagesFor(instance)}
        />
      </div>

      {/* 子弹层：技能 / 包 / 复制 / 删除确认 */}
      {manageSkillsFor && <InstanceSkillsDialog instance={manageSkillsFor} onClose={() => setManageSkillsFor(null)} />}
      {managePackagesFor && <InstancePackagesDialog instance={managePackagesFor} onClose={() => setManagePackagesFor(null)} />}
      {copying && <InstanceCopyDialog instance={copying} onClose={() => setCopying(null)} />}
      <ConfirmDialog
        open={instanceToDelete !== null}
        title={t("deleteInstance.title")}
        message={t("deleteInstance.message", { name: instanceToDelete?.name })}
        variant="destructive"
        confirmText={t("common:delete")}
        onConfirm={confirmDeleteInstance}
        onCancel={() => setInstanceToDelete(null)}
      />
    </div>
  )
}
