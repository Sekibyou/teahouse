import { useState, useCallback, useEffect } from "react"
import { useTranslation } from "react-i18next"
import { Plus, Loader2, Pencil, Trash2, ChevronDown, ChevronRight, HelpCircle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ConfirmDialog } from "@/components/ConfirmDialog"
import { useIsMobile } from "@/hooks/useMediaQuery"
import { Field } from "@/components/SettingsDialogComps/SettingsSection"
import { directorPromptPresetsApi } from "@/lib/api"
import type { DirectorPromptPreset } from "@/lib/types"
import { presetDisplayName } from "@/lib/builtinNames"

export function PresetsPanel() {
  const { t } = useTranslation("settings")
  const isMobile = useIsMobile()
  const [presets, setPresets] = useState<DirectorPromptPreset[]>([])
  const [presetsLoading, setPresetsLoading] = useState(false)
  const [createPresetOpen, setCreatePresetOpen] = useState(false)
  const [editingPreset, setEditingPreset] = useState<DirectorPromptPreset | null>(null)
  const [presetForm, setPresetForm] = useState({ name: "", template_yaml: "", match_pattern: "" })
  const [presetFormError, setPresetFormError] = useState("")
  const [presetFormSaving, setPresetFormSaving] = useState(false)
  const [deletePresetTarget, setDeletePresetTarget] = useState<string | null>(null)
  const [presetDocOpen, setPresetDocOpen] = useState(false)

  const loadPresets = useCallback(async () => {
    setPresetsLoading(true)
    const res = await directorPromptPresetsApi.list()
    if (res.ok) setPresets(res.data!.presets)
    setPresetsLoading(false)
  }, [])

  useEffect(() => { loadPresets() }, [loadPresets])

  const openPresetCreate = () => {
    setPresetFormError("")
    const builtin = presets.find(p => p.is_builtin)
    setPresetForm({ name: "", template_yaml: builtin?.template_yaml || "", match_pattern: "" })
    setEditingPreset(null)
    setCreatePresetOpen(true)
  }

  const openPresetEdit = (p: DirectorPromptPreset) => {
    setPresetFormError("")
    setPresetForm({ name: presetDisplayName(p, t), template_yaml: p.template_yaml || "", match_pattern: p.match_pattern || "" })
    setEditingPreset(p)
    setCreatePresetOpen(true)
  }

  const savePreset = async () => {
    const f = presetForm
    if (!f.name || !f.template_yaml) { setPresetFormError(t("preset.needNameTemplate")); return }
    setPresetFormSaving(true)
    setPresetFormError("")

    let success = false
    if (editingPreset) {
      const res = await directorPromptPresetsApi.update(editingPreset.id, { name: f.name.trim(), template_yaml: f.template_yaml, match_pattern: f.match_pattern.trim() || null })
      if (res.ok) success = true
      else setPresetFormError(res.error || t("errUpdate"))
    } else {
      const res = await directorPromptPresetsApi.create({ name: f.name.trim(), template_yaml: f.template_yaml, match_pattern: f.match_pattern.trim() || null })
      if (res.ok) success = true
      else setPresetFormError(res.error || t("errCreate"))
    }
    setPresetFormSaving(false)
    if (success) {
      setCreatePresetOpen(false)
      setEditingPreset(null)
      await loadPresets()
    }
  }

  const deletePreset = async () => {
    if (!deletePresetTarget) return
    await directorPromptPresetsApi.delete(deletePresetTarget)
    setDeletePresetTarget(null)
    await loadPresets()
  }

  return (
    <div className="p-5 space-y-4 h-full flex flex-col">
      <div className="flex items-center justify-end">
        {!createPresetOpen && (
          <Button size="sm" variant="outline" onClick={openPresetCreate}>
            <Plus className="h-3.5 w-3.5 mr-1.5" />{t("preset.create")}
          </Button>
        )}
      </div>

      {createPresetOpen && (
        <div className="rounded-lg border border-primary/30 bg-primary/5 p-4 shrink-0">
          <h4 className="text-sm font-medium mb-3">
            {editingPreset?.is_builtin ? t("preset.viewBuiltin") : editingPreset ? t("preset.edit") : t("preset.create")}
          </h4>
          <div className="space-y-3">
            <Field label={t("preset.nameLabel")}>
              <Input value={presetForm.name} onChange={e => setPresetForm(f => ({ ...f, name: e.target.value }))} placeholder={t("preset.namePH")} className="text-sm" disabled={!!editingPreset?.is_builtin} autoFocus />
            </Field>
            <Field label={t("preset.matchPattern")}>
              <Input value={presetForm.match_pattern} onChange={e => setPresetForm(f => ({ ...f, match_pattern: e.target.value }))} placeholder={t("preset.matchPatternPH")} className="text-sm" disabled={!!editingPreset?.is_builtin} />
            </Field>
            <div className="rounded-md border border-border bg-muted/30">
              <button
                type="button"
                onClick={() => setPresetDocOpen(o => !o)}
                className="w-full flex items-center gap-1.5 px-3 py-2 text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                {presetDocOpen ? <ChevronDown className="h-3.5 w-3.5 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0" />}
                <HelpCircle className="h-3.5 w-3.5 shrink-0" />
                <span>{t("preset.docTitle")}</span>
              </button>
              {presetDocOpen && (
                <div className="px-3 pb-3 space-y-2">
                  <p className="text-xs text-muted-foreground whitespace-pre-wrap leading-relaxed">
                    {t("preset.docBody")}
                  </p>
                  <div className="space-y-2">
                    <p className="text-xs text-muted-foreground">{t("preset.docExampleLabel")}</p>
                    <p className="text-[11px] text-muted-foreground">{t("preset.docFormMessages")}</p>
                    <pre className="text-[11px] font-mono bg-background border border-border rounded p-2 overflow-x-auto text-muted-foreground">{`system: |
  <teahouse.md>
  {{teahouse.md}}
  </teahouse.md>

  <behavior>
  \${teahouse.behavior}
  </behavior>

messages:
  - role: user
    content: x+y=99
  - role: assistant
    content: OK.`}</pre>
                    <p className="text-[11px] text-muted-foreground">{t("preset.docFormShorthand")}</p>
                    <pre className="text-[11px] font-mono bg-background border border-border rounded p-2 overflow-x-auto text-muted-foreground">{`system: |
  <behavior>
  \${teahouse.behavior}
  </behavior>

user: |
  x+y=99
assistant: |
  OK.`}</pre>
                  </div>
                </div>
              )}
            </div>
            <Field label={t("preset.templateYaml")}>
              <textarea
                className="w-full border border-input rounded-md bg-background px-3 py-2 text-sm font-mono resize-y"
                style={{ height: 300 }}
                value={presetForm.template_yaml}
                onChange={e => setPresetForm(f => ({ ...f, template_yaml: e.target.value }))}
                readOnly={!!editingPreset?.is_builtin}
                placeholder="system: |
  {{teahouse.md}}
  ..."
                spellCheck={false}
              />
            </Field>
            {presetFormError && <p className="text-xs text-red-500">{presetFormError}</p>}
            <div className="flex gap-2">
              {!editingPreset?.is_builtin && (
                <Button size="sm" onClick={savePreset} disabled={presetFormSaving}>
                  {presetFormSaving ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : null}
                  {editingPreset ? t("preset.save") : t("preset.create")}
                </Button>
              )}
              <Button size="sm" variant="outline" onClick={() => { setCreatePresetOpen(false); setEditingPreset(null); setPresetFormError("") }}>
                {editingPreset?.is_builtin ? t("common:close") : t("common:cancel")}
              </Button>
            </div>
          </div>
        </div>
      )}

      {presetsLoading ? (
        <div className="flex items-center justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
      ) : presets.length === 0 ? (
        <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">{t("preset.none")}</div>
      ) : (
        <div className="space-y-2 overflow-auto flex-1">
          {presets.filter(p => p.is_builtin).map(p => (
            <div key={p.id} className="rounded-lg border border-border bg-muted/20 p-4 flex items-start justify-between opacity-70">
              <div className="space-y-1 flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{presetDisplayName(p, t)}</span>
                  <span className="text-[10px] bg-muted px-1.5 py-0.5 rounded">{t("preset.builtIn")}</span>
                </div>
                <div className="text-xs text-muted-foreground">{t("preset.builtInView")}</div>
              </div>
              <Button variant="ghost" size="icon-xs" onClick={() => openPresetEdit(p)} title={t("preset.viewTitle")}>
                <Pencil className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
          {presets.filter(p => !p.is_builtin && p.id !== editingPreset?.id).map(p => (
            <div key={p.id} className="rounded-lg border border-border p-4 flex items-start justify-between group">
              <div className="space-y-1 flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{p.name}</span>
                </div>
                <div className="text-xs text-muted-foreground font-mono whitespace-pre-wrap line-clamp-2">
                  {p.template_yaml ? p.template_yaml.slice(0, 100) + (p.template_yaml.length > 100 ? "..." : "") : t("preset.emptyTemplate")}
                </div>
              </div>
              <div className={`flex items-center gap-0.5 shrink-0 transition-opacity ml-2${isMobile ? "" : " opacity-0 group-hover:opacity-100"}`}>
                <Button variant="ghost" size="icon-xs" onClick={() => openPresetEdit(p)} title={t("preset.editTitle")}>
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
                <Button variant="ghost" size="icon-xs" onClick={() => setDeletePresetTarget(p.id)} title={t("preset.deleteTitle")}>
                  <Trash2 className="h-3.5 w-3.5 text-red-500" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      <ConfirmDialog
        open={deletePresetTarget !== null}
        title={t("del.presetTitle")}
        message={t("del.presetMessage")}
        variant="destructive"
        confirmText={t("common:delete")}
        onConfirm={deletePreset}
        onCancel={() => setDeletePresetTarget(null)}
      />
    </div>
  )
}
