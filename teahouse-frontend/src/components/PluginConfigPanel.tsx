import { useEffect, useRef, useState, useCallback } from "react"
import { useTranslation } from "react-i18next"
import { pluginsApi } from "@/lib/api"
import type { ConfigField, PluginData } from "@/lib/pluginTypes"
import { useCurrentLang } from "@/i18n/config"
import { resolvePluginText } from "@/lib/pluginI18n"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Loader2 } from "lucide-react"

interface PluginConfigPanelProps {
  pluginId: string
  config: ConfigField[]
  i18n?: Record<string, Record<string, string>>
  onSaved: () => void
}

/**
 * PluginConfigPanel — declarative config form.
 *
 * Renders a plugin's `config` schema (text/password/number/select/switch/
 * textarea) as a host-owned form. No iframe, no arbitrary HTML. On open it
 * snapshots the plugin's stored data (`initial`); edits accumulate in `draft`
 * (not persisted until Save); Save PUTs all fields at once; closing discards.
 *
 * Zero network/action at config time — this panel only collects parameters.
 *
 * i18n: plugin authors may ship a per-locale dictionary (`i18n` prop, from the
 * manifest) and use `key:`-prefixed values in label/help/options — the panel
 * resolves them against the active locale, falling back to the literal value.
 */
export function PluginConfigPanel({ pluginId, config, i18n, onSaved }: PluginConfigPanelProps) {
  const { t } = useTranslation("plugin")
  const lang = useCurrentLang()
  const resolve = useCallback(
    (value?: string) => resolvePluginText(value, i18n, lang),
    [i18n, lang],
  )
  const [initial, setInitial] = useState<PluginData>({})
  const [draft, setDraft] = useState<PluginData>({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")
  const loadedRef = useRef(false)

  // Snapshot stored data once on open; seed draft with stored value falling
  // back to the field's declared `default`.
  useEffect(() => {
    if (loadedRef.current) return
    loadedRef.current = true
    setLoading(true)
    ;(async () => {
      const res = await pluginsApi.getData(pluginId)
      const stored = res.ok && res.data ? res.data.data : {}
      const next: PluginData = {}
      const nextInitial: PluginData = {}
      for (const field of config) {
        const key = field.key
        const has = Object.prototype.hasOwnProperty.call(stored, key)
        if (has) {
          const v = stored[key]
          next[key] = v
          nextInitial[key] = v
        } else if (field.default !== undefined) {
          const dv = String(field.default)
          next[key] = dv
          nextInitial[key] = dv
        }
      }
      setInitial(nextInitial)
      setDraft(next)
      setLoading(false)
    })()
  }, [pluginId, config])

  // Dirty when any field differs from the initial snapshot (real-time).
  const dirty = config.some((f) => {
    const k = f.key
    // switch is stored as "true"/"false" strings; compare carefully
    const rawA = (draft[k] ?? "") === "" ? "" : draft[k]
    const rawB = (initial[k] ?? "") === "" ? "" : initial[k]
    if (f.type === "switch") {
      return (rawA === "true") !== (rawB === "true")
    }
    if (f.type === "number") {
      const a = rawA === "" ? null : Number(rawA)
      const b = rawB === "" ? null : Number(rawB)
      return a !== b
    }
    return rawA !== rawB
  })

  const setField = useCallback((key: string, value: string) => {
    setDraft((prev) => ({ ...prev, [key]: value }))
  }, [])

  const handleSave = async () => {
    setSaving(true)
    setError("")
    const res = await pluginsApi.setData(pluginId, { ...draft })
    if (res.ok) {
      const saved: PluginData = {}
      for (const f of config) saved[f.key] = draft[f.key] ?? String(f.default ?? "")
      setInitial(saved)
      onSaved()
    } else {
      setError(res.error || t("saveFailed"))
    }
    setSaving(false)
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-6 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin mr-2" /> {t("loading")}
      </div>
    )
  }

  return (
    <div className="space-y-4 p-4">
      {config.map((field) => (
        <ConfigFieldRow
          key={field.key}
          field={field}
          resolve={resolve}
          value={draft[field.key] ?? ""}
          onChange={(v) => setField(field.key, v)}
        />
      ))}

      {error && <p className="text-xs text-red-600">{error}</p>}

      <div className="flex items-center gap-3 pt-1">
        <Button size="sm" onClick={handleSave} disabled={saving || !dirty}>
          {saving ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null}
          {t("common:save")}
        </Button>
        {dirty && <span className="text-xs text-amber-600">{t("unsavedChanges")}</span>}
      </div>
    </div>
  )
}

function ConfigFieldRow({
  field,
  resolve,
  value,
  onChange,
}: {
  field: ConfigField
  resolve: (value?: string) => string
  value: string
  onChange: (v: string) => void
}) {
  const labelText = resolve(field.label)
  const helpText = resolve(field.help)
  const label = (
    <Label className="text-xs text-muted-foreground">{labelText}</Label>
  )

  return (
    <div className="space-y-1.5">
      {label}
      {helpText && <p className="text-[11px] text-muted-foreground/70">{helpText}</p>}
      <RenderField field={field} resolve={resolve} value={value} onChange={onChange} />
    </div>
  )
}

function RenderField({
  field,
  resolve,
  value,
  onChange,
}: {
  field: ConfigField
  resolve: (value?: string) => string
  value: string
  onChange: (v: string) => void
}) {
  const { t } = useTranslation("plugin")
  switch (field.type) {
    case "password":
      return (
        <Input
          type="password"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="h-8 text-sm"
          placeholder={field.default !== undefined ? String(field.default) : ""}
        />
      )
    case "number":
      return (
        <Input
          type="number"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          min={field.min}
          max={field.max}
          className="h-8 text-sm"
        />
      )
    case "textarea":
      return (
        <Textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="min-h-[80px] text-sm"
          placeholder={field.default !== undefined ? String(field.default) : ""}
        />
      )
    case "switch":
      return (
        <Switch
          checked={value === "true"}
          onCheckedChange={(checked) => onChange(String(checked))}
        />
      )
    case "select":
      return (
        <Select value={value} onValueChange={(v) => onChange(v ?? "")}>
          <SelectTrigger className="h-8 text-sm">
            <SelectValue placeholder={t("selectPlaceholder")} />
          </SelectTrigger>
          <SelectContent>
            {(field.options || []).map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {resolve(opt.label)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )
    case "text":
    default:
      return (
        <Input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="h-8 text-sm"
          placeholder={field.default !== undefined ? String(field.default) : ""}
        />
      )
  }
}
