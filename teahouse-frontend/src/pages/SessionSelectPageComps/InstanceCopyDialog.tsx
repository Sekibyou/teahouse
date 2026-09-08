import { useState } from "react"
import { useTranslation } from "react-i18next"
import { Loader2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { instancesApi } from "@/lib/api"
import type { Instance } from "@/lib/types"

// ── Copy instance dialog (full snapshot duplicate) ──────────────────
export function InstanceCopyDialog({ instance, onClose }: { instance: Instance; onClose: () => void }) {
  const { t } = useTranslation("session")
  const [name, setName] = useState(t("copy.suffix", { name: instance.name }))
  const [error, setError] = useState("")
  const [copying, setCopying] = useState(false)

  const confirmCopy = async () => {
    if (!name.trim()) return
    setCopying(true)
    setError("")
    const res = await instancesApi.copy(instance.id, name.trim())
    if (res.ok && res.data) {
      toast.success(t("copy.copied", { name: res.data.name }))
      onClose()
    } else {
      setError(res.error || t("copy.fail"))
    }
    setCopying(false)
  }

  return (
    <div className="absolute inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50" onClick={() => { if (!copying) onClose() }}>
      <div className="bg-background rounded-lg shadow-lg w-full max-w-sm mx-4 p-6 space-y-4" onClick={e => e.stopPropagation()}>
        <h3 className="font-semibold">{t("copy.title")}</h3>
        <p className="text-xs text-muted-foreground">{t("copy.desc", { name: instance.name })}</p>
        <div className="space-y-1">
          <label className="text-sm font-medium">{t("copy.nameLabel")}</label>
          <Input
            value={name}
            onChange={(e) => { setName(e.target.value); setError("") }}
            placeholder={t("copy.namePh")}
            autoFocus
          />
        </div>
        {error && <p className="text-xs text-red-500">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onClose} disabled={copying}>{t("common:cancel")}</Button>
          <Button size="sm" onClick={confirmCopy} disabled={!name.trim() || copying}>
            {copying ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            {t("copy.submit")}
          </Button>
        </div>
      </div>
    </div>
  )
}
