import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

export function RenameDialog({
  target,
  name,
  onNameChange,
  onSubmit,
  onCancel,
}: {
  target: string | null
  name: string
  onNameChange: (v: string) => void
  onSubmit: () => void
  onCancel: () => void
}) {
  const { t } = useTranslation("workspace")
  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={onCancel}>
      <div className="bg-background rounded-lg shadow-lg w-full max-w-sm mx-4 p-6 space-y-4" onClick={e => e.stopPropagation()}>
        <h3 className="font-semibold">{t("rename.title")}</h3>
        <div>
          <p className="text-xs text-muted-foreground mb-2">{t("location", { path: target?.includes("/") ? target.slice(0, target.lastIndexOf("/")) || "/" : "/" })}</p>
          <Input
            value={name}
            onChange={e => onNameChange(e.target.value)}
            placeholder={t("rename.ph")}
            autoFocus
            onKeyDown={e => { if (e.key === "Enter") onSubmit() }}
          />
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onCancel}>{t("common:cancel")}</Button>
          <Button size="sm" onClick={onSubmit} disabled={!name.trim()}>{t("common:ok")}</Button>
        </div>
      </div>
    </div>
  )
}
