import { useEffect, useState, useCallback } from "react"
import { useTranslation } from "react-i18next"
import { BookOpen, X, Loader2, Trash2, Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ConfirmDialog } from "@/components/ConfirmDialog"
import { useDialogBackClose } from "@/hooks/useDialogBackClose"
import { skillsApi, type MySkill, type InstanceSkill } from "@/lib/api"
import type { Instance } from "@/lib/types"

// ── Instance skill management ──────────────────────────────────────
// Lists the user's skill library + which skills this instance has enabled.
// Enabling copies a library skill into the instance; removing deletes it there.
export function InstanceSkillsDialog({ instance, onClose }: { instance: Instance; onClose: () => void }) {
  const { t } = useTranslation("session")
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
    if (!res.ok) setError(res.error || t("skill.enable.fail"))
    else await reload()
  }

  const handleConfirmRemove = async () => {
    if (!removeTarget) return
    setBusy(removeTarget)
    setError("")
    const res = await skillsApi.removeFromInstance(instance.id, removeTarget)
    setBusy(null)
    setRemoveTarget(null)
    if (!res.ok) setError(res.error || t("skill.remove.fail"))
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
              {t("skill.manage")}
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">{t("skill.enableFor", { name: instance.name })}</p>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground cursor-pointer">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-3">
          {error && (
            <div className="text-xs text-red-600 bg-red-500/5 border border-red-500/20 rounded-md px-3 py-2">{error}</div>
          )}

          <div className="text-xs font-medium text-muted-foreground">{t("skill.enabledTitle")}</div>
          {loading ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground py-2">
              <Loader2 className="h-3 w-3 animate-spin" /> {t("common:loading")}
            </div>
          ) : enabled.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t("skill.noEnabled")}</p>
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
                    {t("remove")}
                  </Button>
                </div>
              ))}
            </div>
          )}

          <div className="text-xs font-medium text-muted-foreground pt-3 border-t border-border">
            {t("skill.addFrom")}
          </div>
          {loading ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground py-2">
              <Loader2 className="h-3 w-3 animate-spin" /> {t("common:loading")}
            </div>
          ) : library.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t("skill.libEmpty")}</p>
          ) : (
            <div className="space-y-2">
              {library.map(s => {
                const isEnabled = enabledNames.has(s.name)
                return (
                  <div key={s.name} className="flex items-center justify-between rounded-lg border px-3 py-2">
                    <div className="min-w-0">
                      <div className="text-sm truncate">{s.name}</div>
                      {isEnabled && <div className="text-[10px] text-emerald-600 dark:text-emerald-400">{t("enabled")}</div>}
                    </div>
                    {isEnabled ? (
                      <span className="text-[11px] text-muted-foreground shrink-0">{t("inInstance")}</span>
                    ) : (
                      <Button
                        size="sm"
                        className="h-7 text-xs"
                        onClick={() => handleEnable(s.name)}
                        disabled={busy === s.name}
                      >
                        {busy === s.name ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3 mr-1" />}
                        {t("enableAdd")}
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
        title={t("skill.remove.title")}
        message={t("skill.remove.message", { name: removeTarget })}
        variant="destructive"
        confirmText={t("remove")}
        onConfirm={handleConfirmRemove}
        onCancel={() => setRemoveTarget(null)}
      />
    </div>
  )
}
