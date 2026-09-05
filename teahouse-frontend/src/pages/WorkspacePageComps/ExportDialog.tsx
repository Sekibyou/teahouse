import { forwardRef, useImperativeHandle, useState } from "react"
import { useTranslation } from "react-i18next"
import { ChevronLeft, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select"
import { ConfirmDialog } from "@/components/ConfirmDialog"
import { prototypesApi, skillsApi, packagesApi, type InstanceSkill, type InstancePackage } from "@/lib/api"

export type ExportType = "prototype" | "skill" | "package"

export interface ExportDialogHandle {
  open: (type: ExportType) => void
}

export const ExportDialog = forwardRef<ExportDialogHandle, {
  open: boolean
  onOpenChange: (open: boolean) => void
  instId: string | undefined
  isMobile: boolean
  onSaved: () => void
}>(function ExportDialog({ open, onOpenChange, instId, isMobile, onSaved }, ref) {
  const { t } = useTranslation("workspace")

  const [exportType, setExportType] = useState<ExportType>("prototype")
  const [exportName, setExportName] = useState("")
  const [exportDescription, setExportDescription] = useState("")
  const [exportAuthor, setExportAuthor] = useState("")
  const [exportVersion, setExportVersion] = useState("1.0.0")
  const [exportLoading, setExportLoading] = useState(false)
  const [exportError, setExportError] = useState("")

  const [instSkills, setInstSkills] = useState<InstanceSkill[]>([])
  const [instSkillsLoading, setInstSkillsLoading] = useState(false)
  const [exportSelectedSkill, setExportSelectedSkill] = useState("")
  const [exportSkillError, setExportSkillError] = useState("")
  const [exportSkillLoading, setExportSkillLoading] = useState(false)

  const [instPackages, setInstPackages] = useState<InstancePackage[]>([])
  const [instPackagesLoading, setInstPackagesLoading] = useState(false)
  const [exportSelectedPackage, setExportSelectedPackage] = useState("")
  const [exportPackageError, setExportPackageError] = useState("")
  const [exportPackageLoading, setExportPackageLoading] = useState(false)

  const [pendingOverwrite, setPendingOverwrite] = useState<{ kind: "skill" | "package"; name: string } | null>(null)

  const openDialog = async (type: ExportType) => {
    setExportType(type)
    setExportError("")
    setExportSkillError("")
    setExportPackageError("")
    if (type === "skill") {
      setExportSelectedSkill("")
      if (!instId) return
      setInstSkillsLoading(true)
      const res = await skillsApi.listForInstance(instId)
      if (res.ok) {
        const instanceOnly = res.data!.filter(s => s.source === "instance" && s.has_skill)
        setInstSkills(instanceOnly)
      } else {
        setExportSkillError(res.error || t("skillLoadFail"))
      }
      setInstSkillsLoading(false)
    } else if (type === "package") {
      setExportSelectedPackage("")
      if (!instId) return
      setInstPackagesLoading(true)
      const res = await packagesApi.listInInstance(instId)
      if (res.ok) {
        setInstPackages(res.data!.packages)
      } else {
        setExportPackageError(res.error || t("packageLoadFail"))
      }
      setInstPackagesLoading(false)
    }
    onOpenChange(true)
  }

  useImperativeHandle(ref, () => ({ open: openDialog }), [instId, onOpenChange, t])

  // Shared "export a library item into the user's library" with overwrite confirm.
  const doExportToLibrary = async (kind: "skill" | "package", name: string, overwrite: boolean, setLoading: (v: boolean) => void, setErr: (v: string) => void) => {
    if (!instId) return
    setLoading(true)
    setErr("")
    let res: { ok: boolean; error?: string; status?: number }
    if (kind === "skill") {
      res = await skillsApi.exportToLibrary(instId, name, overwrite)
    } else {
      res = await packagesApi.exportToLibrary(instId, name, overwrite)
    }
    setLoading(false)
    if (res.ok) {
      onOpenChange(false)
      if (kind === "skill") setExportSelectedSkill("")
      else setExportSelectedPackage("")
      onSaved()
    } else if (!overwrite && res.status === 409) {
      // Same-named target already exists in the library → ask before overwriting.
      setPendingOverwrite({ kind, name })
    } else {
      setErr(res.error || t("exportFail"))
    }
  }

  const handleExport = async () => {
    if (!instId) return
    if (exportType === "prototype") {
      if (!exportName.trim()) return
      setExportLoading(true)
      setExportError("")
      const res = await prototypesApi.create(
        instId, exportName.trim(), exportDescription.trim(),
        exportAuthor.trim(), exportVersion.trim() || "1.0.0",
      )
      if (res.ok) {
        onOpenChange(false)
        setExportName("")
        setExportDescription("")
        setExportAuthor("")
        setExportVersion("1.0.0")
        onSaved()
      } else {
        setExportError(res.error || t("exportFail"))
      }
      setExportLoading(false)
    } else if (exportType === "package") {
      if (!exportSelectedPackage) return
      await doExportToLibrary("package", exportSelectedPackage, false, setExportPackageLoading, setExportPackageError)
    } else {
      if (!exportSelectedSkill) return
      await doExportToLibrary("skill", exportSelectedSkill, false, setExportSkillLoading, setExportSkillError)
    }
  }

  const handleConfirmOverwrite = async () => {
    if (!pendingOverwrite) return
    const { kind, name } = pendingOverwrite
    setPendingOverwrite(null)
    if (!instId) return
    if (kind === "skill") {
      const setL = setExportSkillLoading
      const setE = setExportSkillError
      setL(true); setE("")
      const res = await skillsApi.exportToLibrary(instId, name, true)
      setL(false)
      if (res.ok) {
        onOpenChange(false)
        setExportSelectedSkill("")
        onSaved()
      } else setE(res.error || t("exportFail"))
    } else {
      setExportPackageLoading(true); setExportPackageError("")
      const res = await packagesApi.exportToLibrary(instId, name, true)
      setExportPackageLoading(false)
      if (res.ok) {
        onOpenChange(false)
        setExportSelectedPackage("")
        onSaved()
      } else setExportPackageError(res.error || t("exportFail"))
    }
  }

  if (!open) return null

  // 内容主体（类型切换 + 三个面板）在移动全屏版与桌面弹窗版共用同一份 JSX。
  const body = (
    <>
      {/* Type toggle */}
      <div className="grid grid-cols-3 gap-1 p-1 rounded-lg bg-muted">
        <button
          className={`py-1.5 rounded-md text-sm font-medium transition-colors cursor-pointer ${exportType === "prototype" ? "bg-background shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
          onClick={() => openDialog("prototype")}
        >
          {t("export.type.prototype")}
        </button>
        <button
          className={`py-1.5 rounded-md text-sm font-medium transition-colors cursor-pointer ${exportType === "skill" ? "bg-background shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
          onClick={() => openDialog("skill")}
        >
          {t("export.type.skill")}
        </button>
        <button
          className={`py-1.5 rounded-md text-sm font-medium transition-colors cursor-pointer ${exportType === "package" ? "bg-background shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
          onClick={() => openDialog("package")}
        >
          {t("export.type.package")}
        </button>
      </div>

      {exportType === "prototype" ? (
        <>
          <h3 className="font-semibold">{t("export.prototype.title")}</h3>
          <p className="text-xs text-muted-foreground">{t("export.prototype.desc")}</p>
          <div className="space-y-1">
            <label className="text-sm font-medium">{t("export.prototype.name")}</label>
            <Input
              value={exportName}
              onChange={e => { setExportName(e.target.value); setExportError("") }}
              placeholder={t("export.prototype.namePh")}
              autoFocus
            />
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium">{t("export.prototype.descLabel")} <span className="text-muted-foreground font-normal">{t("export.prototype.maxChars")}</span></label>
            <Input
              value={exportDescription}
              onChange={e => setExportDescription(e.target.value)}
              placeholder={t("export.prototype.descPh")}
              maxLength={50}
            />
          </div>
          <div className="flex gap-3">
            <div className="space-y-1 flex-1">
              <label className="text-sm font-medium">{t("export.prototype.author")} <span className="text-muted-foreground font-normal">{t("export.prototype.optional")}</span></label>
              <Input
                value={exportAuthor}
                onChange={e => setExportAuthor(e.target.value)}
                placeholder={t("export.prototype.authorPh")}
              />
            </div>
            <div className="space-y-1 w-24">
              <label className="text-sm font-medium">{t("common:version")}</label>
              <Input
                value={exportVersion}
                onChange={e => setExportVersion(e.target.value)}
                placeholder="1.0.0"
              />
            </div>
          </div>
          {exportError && <p className="text-sm text-red-500">{exportError}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>{t("common:cancel")}</Button>
            <Button size="sm" onClick={handleExport} disabled={!exportName.trim() || exportLoading}>
              {exportLoading && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}
              {t("export.submit")}
            </Button>
          </div>
        </>
      ) : exportType === "package" ? (
        <>
          <h3 className="font-semibold">{t("export.package.title")}</h3>
          <p className="text-xs text-muted-foreground">{t("export.package.desc")}</p>
          <div className="space-y-1">
            <label className="text-sm font-medium">{t("export.package.select")}</label>
            {instPackagesLoading ? (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" /> {t("common:loading")}
              </div>
            ) : instPackages.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t("export.package.empty")}</p>
            ) : (
              <Select value={exportSelectedPackage || undefined} onValueChange={(v) => { if (v) setExportSelectedPackage(v) }}>
                <SelectTrigger>
                  <SelectValue placeholder={t("export.package.ph")} />
                </SelectTrigger>
                <SelectContent>
                  {instPackages.map(p => (
                    <SelectItem key={p.name} value={p.name}>{p.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
          {exportPackageError && <p className="text-sm text-red-500">{exportPackageError}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>{t("common:cancel")}</Button>
            <Button size="sm" onClick={handleExport} disabled={!exportSelectedPackage || exportPackageLoading}>
              {exportPackageLoading && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}
              {t("export.package.submit")}
            </Button>
          </div>
        </>
      ) : (
        <>
          <h3 className="font-semibold">{t("export.skill.title")}</h3>
          <p className="text-xs text-muted-foreground">{t("export.skill.desc")}</p>
          <div className="space-y-1">
            <label className="text-sm font-medium">{t("export.skill.select")}</label>
            {instSkillsLoading ? (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" /> {t("common:loading")}
              </div>
            ) : instSkills.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t("export.skill.empty")}</p>
            ) : (
              <Select value={exportSelectedSkill || undefined} onValueChange={(v) => { if (v) setExportSelectedSkill(v) }}>
                <SelectTrigger>
                  <SelectValue placeholder={t("export.skill.ph")} />
                </SelectTrigger>
                <SelectContent>
                  {instSkills.map(s => (
                    <SelectItem key={s.name} value={s.name}>{s.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
          {exportSkillError && <p className="text-sm text-red-500">{exportSkillError}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>{t("common:cancel")}</Button>
            <Button size="sm" onClick={handleExport} disabled={!exportSelectedSkill || exportSkillLoading}>
              {exportSkillLoading && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}
              {t("export.skill.submit")}
            </Button>
          </div>
        </>
      )}
    </>
  )

  return (
    <>
      {isMobile ? (
        /* 全屏面板（移动端） */
        <div className="fixed inset-0 z-50 bg-background flex flex-col">
          <div className="h-10 border-b border-border flex items-center gap-1 px-1 shrink-0">
            <button
              className="p-2 rounded-md hover:bg-muted shrink-0"
              onClick={() => onOpenChange(false)}
              title={t("common:cancel")}
            >
              <ChevronLeft className="h-5 w-5" />
            </button>
            <span className="flex-1 text-sm font-medium text-center truncate">{t("export.titleBar")}</span>
            <span className="w-9 shrink-0" />
          </div>
          <div className="flex-1 overflow-y-auto p-4 space-y-4" onClick={e => e.stopPropagation()}>
            {body}
          </div>
        </div>
      ) : (
        /* 居中弹窗（桌面端） */
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={() => onOpenChange(false)}>
          <div className="bg-background rounded-lg shadow-lg w-full max-w-sm mx-4 p-6 space-y-4" onClick={e => e.stopPropagation()}>
            {body}
          </div>
        </div>
      )}

      {/* Overwrite confirm — same-named package/skill already exists in library */}
      <ConfirmDialog
        open={pendingOverwrite !== null}
        title={pendingOverwrite?.kind === "package" ? t("overwrite.title.package") : t("overwrite.title.skill")}
        message={t("overwrite.message", {
          lib: pendingOverwrite?.kind === "package" ? t("overwrite.lib.package") : t("overwrite.lib.skill"),
          name: pendingOverwrite?.name,
        })}
        variant="destructive"
        confirmText={t("overwrite.confirm")}
        onConfirm={handleConfirmOverwrite}
        onCancel={() => setPendingOverwrite(null)}
      />
    </>
  )
})
