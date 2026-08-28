import { useRef, useState, useEffect } from "react"
import { useTranslation } from "react-i18next"
import { Loader2, Upload, X, BookOpen, Download, Trash2, AlertCircle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ConfirmDialog } from "@/components/ConfirmDialog"
import { LibraryEmptyState } from "@/components/SettingsDialogComps/SettingsSection"
import { skillsApi } from "@/lib/api"
import type { MySkill, SkillPreview } from "@/lib/api"

export function SkillsPanel() {
  const { t } = useTranslation("settings")
  const [mySkills, setMySkills] = useState<MySkill[]>([])
  const [skillsLoading, setSkillsLoading] = useState(false)
  const skillFileInputRef = useRef<HTMLInputElement>(null)
  const [skillPreview, setSkillPreview] = useState<SkillPreview | null>(null)
  const [skillPreviewError, setSkillPreviewError] = useState("")
  const [skillUploading, setSkillUploading] = useState(false)
  const [skillInstalling, setSkillInstalling] = useState(false)
  const [skillDeleting, setSkillDeleting] = useState<string | null>(null)
  const [skillDeleteTarget, setSkillDeleteTarget] = useState<string | null>(null)

  const loadMySkills = async () => {
    setSkillsLoading(true)
    const res = await skillsApi.listMy()
    if (res.ok) setMySkills(res.data!.skills)
    setSkillsLoading(false)
  }

  useEffect(() => { loadMySkills() }, [])

  const handleSkillImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setSkillUploading(true)
    setSkillPreviewError("")
    try {
      const form = new FormData()
      form.append("file", file)
      const res = await skillsApi.preview(form)
      if (res.ok) setSkillPreview(res.data)
      else {
        setSkillPreviewError(res.error || t("errSkillPreview"))
        setSkillPreview(null)
      }
    } finally {
      setSkillUploading(false)
      if (skillFileInputRef.current) skillFileInputRef.current.value = ""
    }
  }

  const handleSkillConfirmInstall = async () => {
    if (!skillPreview) return
    setSkillInstalling(true)
    try {
      const res = await skillsApi.confirmInstall(skillPreview.preview_id)
      setSkillPreview(null)
      if (res.ok) await loadMySkills()
      else setSkillPreviewError(res.error || t("errImport"))
    } finally {
      setSkillInstalling(false)
    }
  }

  const handleSkillDelete = async () => {
    if (!skillDeleteTarget) return
    setSkillDeleting(skillDeleteTarget)
    const res = await skillsApi.deleteMy(skillDeleteTarget)
    setSkillDeleting(null)
    setSkillDeleteTarget(null)
    if (res.ok) await loadMySkills()
  }

  return (
    <div className="p-5 space-y-6">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground flex items-center gap-1.5">
          {skillsLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
          {t("skill.count", { n: mySkills.length })}
        </p>
        <div>
          <input
            ref={skillFileInputRef}
            type="file"
            accept=".zip"
            onChange={handleSkillImport}
            className="hidden"
          />
          <Button
            size="sm"
            variant="outline"
            onClick={() => skillFileInputRef.current?.click()}
            disabled={skillUploading}
          >
            {skillUploading ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <Upload className="h-3 w-3 mr-1" />}
            {t("skill.import")}
          </Button>
        </div>
      </div>

      {skillPreviewError && (
        <div className="flex items-start gap-2 text-xs text-red-600 bg-red-500/5 border border-red-500/20 rounded-md px-3 py-2">
          <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
          <span>{skillPreviewError}</span>
        </div>
      )}

      {skillPreview && (
        <div className="border rounded-md p-4 space-y-3 bg-card">
          <div className="flex items-start justify-between">
            <div>
              <div className="font-medium">{t("skill.importHeading", { name: skillPreview.name })}</div>
              <p className="text-[11px] text-muted-foreground mt-0.5">
                {t("skill.fileCount", { n: skillPreview.preview.file_count })}
              </p>
            </div>
            <button onClick={() => setSkillPreview(null)} className="text-muted-foreground hover:text-foreground">
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <Button size="sm" variant="outline" onClick={() => setSkillPreview(null)}>{t("common:cancel")}</Button>
            <Button size="sm" onClick={handleSkillConfirmInstall} disabled={skillInstalling}>
              {skillInstalling ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null}
              {t("skill.confirmImport")}
            </Button>
          </div>
        </div>
      )}

      {mySkills.length === 0 ? (
        <LibraryEmptyState
          icon={BookOpen}
          title={t("skill.emptyTitle")}
          lines={[t("skill.emptyHint"), t("skill.hint")]}
        />
      ) : (
        <div className="space-y-4">
          {mySkills.map((s) => (
            <div key={s.name} className="rounded-lg border p-4 space-y-2">
              <div className="flex items-center justify-between">
                <div>
                  <div className="font-medium flex items-center gap-2">
                    <BookOpen className="h-4 w-4 text-muted-foreground" />
                    {s.name}
                  </div>
                  <p className="text-[11px] text-muted-foreground mt-1">
                    {s.has_skill ? t("skill.filesCount", { n: s.file_count }) : t("skill.missingSkillMd")}
                    {s.size ? ` · ${(s.size / 1024).toFixed(1)} KB` : ""}
                  </p>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <Button size="sm" variant="outline" onClick={() => window.open(skillsApi.downloadUrl(s.name), "_blank")}>
                    <Download className="h-3 w-3 mr-1" />
                    {t("skill.download")}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="text-red-500 hover:text-red-700"
                    onClick={() => setSkillDeleteTarget(s.name)}
                    disabled={skillDeleting === s.name}
                  >
                    <Trash2 className="h-3 w-3 mr-1" />
                    {t("skill.delete")}
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <ConfirmDialog
        open={skillDeleteTarget !== null}
        title={t("del.skillTitle")}
        message={t("del.skillMessage", { name: skillDeleteTarget })}
        variant="destructive"
        confirmText={skillDeleting ? t("del.deleting") : t("common:delete")}
        onConfirm={handleSkillDelete}
        onCancel={() => setSkillDeleteTarget(null)}
      />
    </div>
  )
}
