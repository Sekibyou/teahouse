import { useEffect, useRef, useState, useCallback } from "react"
import { pluginsApi } from "@/lib/api"
import type { ConfigField, PluginData } from "@/lib/pluginTypes"
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
 */
export function PluginConfigPanel({ pluginId, config, onSaved }: PluginConfigPanelProps) {
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
      setError(res.error || "保存失败")
    }
    setSaving(false)
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-6 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin mr-2" /> 加载配置...
      </div>
    )
  }

  return (
    <div className="space-y-4 p-4">
      {config.map((field) => (
        <ConfigFieldRow
          key={field.key}
          field={field}
          value={draft[field.key] ?? ""}
          onChange={(v) => setField(field.key, v)}
        />
      ))}

      {error && <p className="text-xs text-red-600">{error}</p>}

      <div className="flex items-center gap-3 pt-1">
        <Button size="sm" onClick={handleSave} disabled={saving || !dirty}>
          {saving ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null}
          保存
        </Button>
        {dirty && <span className="text-xs text-amber-600">有未保存修改</span>}
      </div>
    </div>
  )
}

function ConfigFieldRow({
  field,
  value,
  onChange,
}: {
  field: ConfigField
  value: string
  onChange: (v: string) => void
}) {
  const label = (
    <Label className="text-xs text-muted-foreground">{field.label}</Label>
  )

  return (
    <div className="space-y-1.5">
      {label}
      {field.help && <p className="text-[11px] text-muted-foreground/70">{field.help}</p>}
      <RenderField field={field} value={value} onChange={onChange} />
    </div>
  )
}

function RenderField({
  field,
  value,
  onChange,
}: {
  field: ConfigField
  value: string
  onChange: (v: string) => void
}) {
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
            <SelectValue placeholder="选择..." />
          </SelectTrigger>
          <SelectContent>
            {(field.options || []).map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
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
