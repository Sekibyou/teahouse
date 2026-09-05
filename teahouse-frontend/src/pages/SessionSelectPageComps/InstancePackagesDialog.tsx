import { useEffect, useState, useCallback } from "react"
import { useTranslation } from "react-i18next"
import { Package, X, Loader2, Trash2, Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ConfirmDialog } from "@/components/ConfirmDialog"
import { useDialogBackClose } from "@/hooks/useDialogBackClose"
import { packagesApi, type MyPackage, type InstancePackage } from "@/lib/api"
import type { Instance } from "@/lib/types"

export function InstancePackagesDialog({ instance, onClose }: { instance: Instance; onClose: () => void }) {
  const { t } = useTranslation("session")
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
    if (!res.ok) setError(res.error || t("pkg.enable.fail"))
    else await reload()
  }

  const handleConfirmRemove = async () => {
    if (!removeTarget) return
    setBusy(removeTarget)
    setError("")
    const res = await packagesApi.removeFromInstance(instance.id, removeTarget)
    setBusy(null)
    setRemoveTarget(null)
    if (!res.ok) setError(res.error || t("pkg.remove.fail"))
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
              {t("pkg.manage")}
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">{t("pkg.enableFor", { name: instance.name })}</p>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground cursor-pointer">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-3">
          {error && (
            <div className="text-xs text-red-600 bg-red-500/5 border border-red-500/20 rounded-md px-3 py-2">{error}</div>
          )}

          <div className="text-xs font-medium text-muted-foreground">{t("pkg.enabledTitle")}</div>
          {loading ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground py-2">
              <Loader2 className="h-3 w-3 animate-spin" /> {t("common:loading")}
            </div>
          ) : enabled.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t("pkg.noEnabled")}</p>
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
                    {t("pkg.uninstall")}
                  </Button>
                </div>
              ))}
            </div>
          )}

          <div className="text-xs font-medium text-muted-foreground pt-3 border-t border-border">
            {t("pkg.addFrom")}
          </div>
          {loading ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground py-2">
              <Loader2 className="h-3 w-3 animate-spin" /> {t("common:loading")}
            </div>
          ) : library.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t("pkg.libEmpty")}</p>
          ) : (
            <div className="space-y-2">
              {library.map(p => {
                const isEnabled = enabledNames.has(p.name)
                return (
                  <div key={p.name} className="flex items-center justify-between rounded-lg border px-3 py-2">
                    <div className="min-w-0">
                      <div className="text-sm truncate">{p.name}</div>
                      {isEnabled && <div className="text-[10px] text-emerald-600 dark:text-emerald-400">{t("enabled")}</div>}
                    </div>
                    {isEnabled ? (
                      <span className="text-[11px] text-muted-foreground shrink-0">{t("inInstance")}</span>
                    ) : (
                      <Button
                        size="sm"
                        className="h-7 text-xs"
                        onClick={() => handleEnable(p.name)}
                        disabled={busy === p.name}
                      >
                        {busy === p.name ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3 mr-1" />}
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
        title={t("pkg.remove.title")}
        message={t("pkg.remove.message", { name: removeTarget })}
        variant="destructive"
        confirmText={t("pkg.uninstall")}
        onConfirm={handleConfirmRemove}
        onCancel={() => setRemoveTarget(null)}
      />
    </div>
  )
}
