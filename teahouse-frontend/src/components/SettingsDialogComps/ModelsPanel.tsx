import { useState, useCallback, useEffect } from "react"
import { useTranslation } from "react-i18next"
import {
  Plus, Loader2, Star, Pencil, Trash2, Download, Sparkles,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { ConfirmDialog } from "@/components/ConfirmDialog"
import { useIsMobile } from "@/hooks/useMediaQuery"
import { Field } from "@/components/SettingsDialogComps/SettingsSection"
import { llmProvidersApi, llmModelsApi } from "@/lib/api"
import type { LLMProvider, LLMModel, AvailableModel } from "@/lib/types"
import { PROVIDER_GROUPS, matchProviderPreset } from "@/lib/providerPresets"
import type { ProviderPreset } from "@/lib/providerPresets"

const API_FORMAT_OPTIONS = [
  { value: "openai", label: "openai" },
  { value: "openai_strict", label: "openai_strict" },
  { value: "anthropic", label: "anthropic" },
]

// Compute model fetch URL from API URL
function computeModelFetchUrl(apiUrl: string): string {
  let base = apiUrl.replace(/\/chat\/completions\/?$/, "")
  base = base.replace(/\/+$/, "")
  return `${base}/models`
}

export function ModelsPanel() {
  const { t } = useTranslation("settings")
  const isMobile = useIsMobile()

  const [providers, setProviders] = useState<LLMProvider[]>([])
  const [models, setModels] = useState<LLMModel[]>([])
  const [providersLoading, setProvidersLoading] = useState(false)
  const [showProviderCreate, setShowProviderCreate] = useState(false)
  const [providerCreateForm, setProviderCreateForm] = useState({ name: "", api_url: "", api_key: "", api_format: "openai" })
  const [editingProviderName, setEditingProviderName] = useState<string | null>(null)
  const [expandedProviderId, setExpandedProviderId] = useState<string | null>(null)
  const [editingNameValue, setEditingNameValue] = useState("")
  const [providerError, setProviderError] = useState("")
  const [providerSaving, setProviderSaving] = useState(false)
  const [deleteProviderTarget, setDeleteProviderTarget] = useState<string | null>(null)
  const [providerApiKeyFocus, setProviderApiKeyFocus] = useState(0)
  const [importingFromProvider, setImportingFromProvider] = useState<string | null>(null)
  const [availableModels, setAvailableModels] = useState<AvailableModel[]>([])
  const [importModelLoading, setImportModelLoading] = useState(false)
  const [selectedModels, setSelectedModels] = useState<Set<string>>(new Set())
  const [providerFormOverrides, setProviderFormOverrides] = useState<Record<string, { api_url?: string; api_key?: string; api_format?: string; model_fetch_url?: string }>>({})
  const [error, setError] = useState("")

  const loadAll = useCallback(async () => {
    setProvidersLoading(true)
    const [pRes, mRes] = await Promise.all([llmProvidersApi.list(), llmModelsApi.list()])
    if (pRes.ok) setProviders(pRes.data!.providers)
    else setError(pRes.error || t("errLoadProviders"))
    if (mRes.ok) setModels(mRes.data!.models)
    else setError(mRes.error || t("errLoadModels"))
    setProvidersLoading(false)
  }, [t])

  useEffect(() => { loadAll() }, [loadAll])

  const getProviderModels = (providerId: string): (LLMModel & { stale?: boolean })[] =>
    models.filter(m => m.provider_id === providerId)

  const getProviderFormFor = (p: LLMProvider) => {
    const override = providerFormOverrides[p.id] || {}
    const apiUrl = override.api_url !== undefined ? override.api_url : p.api_url
    const modelFetchUrl = override.model_fetch_url !== undefined
      ? override.model_fetch_url
      : p.model_fetch_url || computeModelFetchUrl(apiUrl)
    return {
      api_url: apiUrl,
      api_key: override.api_key !== undefined ? override.api_key : p.api_key,
      api_format: override.api_format !== undefined ? override.api_format : p.api_format,
      model_fetch_url: modelFetchUrl,
    }
  }

  const setProviderFormField = (providerId: string, field: string, value: string) => {
    setProviderFormOverrides(prev => {
      const existing = prev[providerId] || {}
      const next: Record<string, string | undefined> = { ...existing, [field]: value }
      if (field === "api_url" && existing.model_fetch_url === undefined) {
        const p = providers.find(pp => pp.id === providerId)
        if (p && !p.model_fetch_url) next.model_fetch_url = computeModelFetchUrl(value)
      }
      return { ...prev, [providerId]: next as typeof existing }
    })
  }

  const isProviderSaveNeeded = (p: LLMProvider) => {
    const override = providerFormOverrides[p.id]
    if (!override) return false
    return (override.api_url !== undefined && override.api_url !== p.api_url) ||
      (override.api_key !== undefined && override.api_key !== p.api_key) ||
      (override.api_format !== undefined && override.api_format !== p.api_format) ||
      (override.model_fetch_url !== undefined && override.model_fetch_url !== (p.model_fetch_url || ""))
  }

  const saveProviderOverrides = async (providerId: string) => {
    const p = providers.find(pp => pp.id === providerId)
    if (!p) return
    const override = providerFormOverrides[providerId] || {}
    const payload: Record<string, unknown> = {
      name: p.name,
      api_url: override.api_url !== undefined ? override.api_url : p.api_url,
      api_format: override.api_format !== undefined ? override.api_format : p.api_format,
      model_fetch_url: override.model_fetch_url !== undefined ? override.model_fetch_url : (p.model_fetch_url || ""),
    }
    if (override.api_key !== undefined) payload.api_key = override.api_key
    const res = await llmProvidersApi.update(providerId, payload)
    if (res.ok) {
      setProviderFormOverrides(prev => { const n = { ...prev }; delete n[providerId]; return n })
      await loadAll()
    } else {
      setError(res.error || t("errSave"))
    }
  }

  const openProviderCreate = () => {
    setProviderError("")
    setProviderCreateForm({ name: "", api_url: "", api_key: "", api_format: "openai" })
    setShowProviderCreate(true)
  }

  const applyProviderPreset = (p: ProviderPreset) => {
    setProviderCreateForm({ name: p.label, api_url: p.api_url, api_key: "", api_format: p.api_format })
    setProviderError("")
    setProviderApiKeyFocus(n => n + 1)
  }

  const saveProviderCreate = async () => {
    const f = providerCreateForm
    if (!f.name || !f.api_url || !f.api_key) { setProviderError(t("provider.needAllFields")); return }
    setProviderSaving(true)
    setProviderError("")
    const res = await llmProvidersApi.create({ name: f.name.trim(), api_url: f.api_url.trim(), api_key: f.api_key.trim(), api_format: f.api_format })
    if (res.ok) {
      setShowProviderCreate(false)
      setProviderCreateForm({ name: "", api_url: "", api_key: "", api_format: "openai" })
      await loadAll()
    } else setProviderError(res.error || t("errCreate"))
    setProviderSaving(false)
  }

  const saveProviderName = async (providerId: string) => {
    if (!editingNameValue.trim()) { setEditingProviderName(null); return }
    const p = providers.find(pp => pp.id === providerId)
    if (!p) return
    await llmProvidersApi.update(providerId, { name: editingNameValue.trim() })
    setEditingProviderName(null)
    await loadAll()
  }

  const deleteProvider = async () => {
    if (!deleteProviderTarget) return
    await llmProvidersApi.delete(deleteProviderTarget)
    setDeleteProviderTarget(null)
    await loadAll()
  }

  const toggleModelEnabled = async (model: LLMModel) => {
    await llmModelsApi.delete(model.id)
    await loadAll()
  }

  const toggleModelStale = async (model: LLMModel) => {
    await llmModelsApi.delete(model.id)
    await loadAll()
  }

  const openImportForProvider = async (providerId: string) => {
    setImportingFromProvider(providerId)
    setImportModelLoading(true)
    setSelectedModels(new Set())
    const form = getProviderFormFor(providers.find(p => p.id === providerId)!)
    const res = await llmProvidersApi.availableModels(providerId, form.model_fetch_url)
    if (res.ok) setAvailableModels(res.data!.models)
    else setError(res.error || t("errFetchModels"))
    setImportModelLoading(false)
  }

  const toggleModelSelection = (modelName: string) => {
    const next = new Set(selectedModels)
    if (next.has(modelName)) next.delete(modelName)
    else next.add(modelName)
    setSelectedModels(next)
  }

  const importSelectedModels = async () => {
    if (!importingFromProvider || selectedModels.size === 0) return
    setImportModelLoading(true)
    const modelProfiles: Record<string, string> = {}
    for (const modelName of selectedModels) modelProfiles[modelName] = ""
    const res = await llmProvidersApi.importModels(importingFromProvider, modelProfiles)
    if (res.ok) {
      setImportingFromProvider(null)
      setAvailableModels([])
      setSelectedModels(new Set())
      await loadAll()
    } else setError(res.error || t("errImport"))
    setImportModelLoading(false)
  }

  return (
    <div className="p-5 space-y-4">
      <div className="flex items-center justify-end">
        {!showProviderCreate && (
          <Button size="sm" variant="outline" onClick={openProviderCreate}>
            <Plus className="h-3.5 w-3.5 mr-1.5" />{t("provider.add")}
          </Button>
        )}
      </div>

      {error && (
        <div className="px-3 py-2 bg-red-500/10 border border-red-500/20 text-xs text-red-500 rounded-md flex items-center gap-2">
          <span className="flex-1">{error}</span>
          <button className="underline shrink-0" onClick={() => setError("")}>{t("errorDismiss")}</button>
        </div>
      )}

      {showProviderCreate && (
        <div className="rounded-lg border border-primary/30 bg-primary/5 p-4">
          <h4 className="text-sm font-medium mb-3">{t("provider.add")}</h4>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <Field label={t("provider.nameLabel")}>
                <Input value={providerCreateForm.name} onChange={e => setProviderCreateForm(f => ({ ...f, name: e.target.value }))} placeholder={t("provider.namePH")} className="text-sm" autoFocus />
              </Field>
              <Field label={t("provider.apiFormat")}>
                <Select
                  value={providerCreateForm.api_format}
                  onValueChange={(v) => setProviderCreateForm(f => ({ ...f, api_format: v ?? "" }))}
                >
                  <SelectTrigger className="w-full h-9 text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {API_FORMAT_OPTIONS.map(opt => (
                      <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label={t("provider.baseUrl")} className="col-span-2">
                <Input value={providerCreateForm.api_url} onChange={e => setProviderCreateForm(f => ({ ...f, api_url: e.target.value }))} placeholder={t("provider.apiUrlPH")} className="text-sm font-mono" />
              </Field>
              <Field label={t("provider.apiKey")} className="col-span-2">
                <Input key={providerApiKeyFocus} autoFocus={providerApiKeyFocus > 0} type="password" value={providerCreateForm.api_key} onChange={e => setProviderCreateForm(f => ({ ...f, api_key: e.target.value }))} placeholder={t("provider.apiKeyPH")} className="text-sm" />
              </Field>
            </div>

            <div className="border-t border-border pt-3 mt-1">
              <div className="text-xs text-muted-foreground mb-2 flex items-center gap-1.5">
                <Sparkles className="h-3 w-3" />
                {t("provider.quickAdd")}
              </div>
              <div className="space-y-2.5">
                {PROVIDER_GROUPS.map(group => (
                  <div key={group.key}>
                    <div className="text-[10px] uppercase tracking-wide text-muted-foreground/70 mb-1">{t(group.name)}</div>
                    <div className="flex flex-wrap gap-1.5">
                      {group.items.map(p => (
                        <button
                          key={p.id}
                          type="button"
                          onClick={() => applyProviderPreset(p)}
                          className="group/badge flex items-center gap-1.5 rounded-md border border-transparent px-1.5 py-1 hover:border-primary/40 hover:bg-primary/5 transition-colors"
                          title={p.label}
                        >
                          <span
                            className="h-6 w-6 rounded-md flex items-center justify-center text-[11px] font-semibold shrink-0"
                            style={{ background: p.color, color: p.fg || "#FFFFFF" }}
                          >
                            {p.short}
                          </span>
                          <span className="text-xs text-muted-foreground group-hover/badge:text-foreground whitespace-nowrap">{p.label}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
            {providerError && <p className="text-xs text-red-500">{providerError}</p>}
            <div className="flex gap-2">
              <Button size="sm" onClick={saveProviderCreate} disabled={providerSaving}>
                {providerSaving ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : null}{t("provider.create")}
              </Button>
              <Button size="sm" variant="outline" onClick={() => { setShowProviderCreate(false); setProviderCreateForm({ name: "", api_url: "", api_key: "", api_format: "openai" }); setProviderError("") }}>
                {t("common:cancel")}
              </Button>
            </div>
          </div>
        </div>
      )}

      {providersLoading ? (
        <div className="flex items-center justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
      ) : providers.length === 0 ? (
        <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">{t("provider.none")}</div>
      ) : (
        <div className={isMobile ? "space-y-3" : "columns-2 gap-5"}>
          {providers.map(p => {
            const form = getProviderFormFor(p)
            const saveNeeded = isProviderSaveNeeded(p)
            const providerModels = getProviderModels(p.id)
            const preset = matchProviderPreset(p.api_url)
            const expanded = expandedProviderId === p.id
            const enabledModelNames = new Set(providerModels.filter(mm => mm.is_enabled).map(mm => mm.model_name))

            return (
              <div key={p.id} className={`rounded-lg border p-4 space-y-3 mb-5 break-inside-avoid ${p.is_enabled ? "border-border" : "border-muted opacity-60"}`}>
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    {preset ? (
                      <span
                        className="h-6 w-6 rounded-md flex items-center justify-center text-[11px] font-semibold shrink-0"
                        style={{ background: preset.color, color: preset.fg || "#FFFFFF" }}
                        title={preset.label}
                      >
                        {preset.short}
                      </span>
                    ) : (
                      <span className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded shrink-0">{t("provider.custom")}</span>
                    )}
                    {editingProviderName === p.id ? (
                      <Input
                        className="text-sm font-medium w-48"
                        value={editingNameValue}
                        onChange={e => setEditingNameValue(e.target.value)}
                        onBlur={() => saveProviderName(p.id)}
                        onKeyDown={e => { if (e.key === "Enter") saveProviderName(p.id); if (e.key === "Escape") setEditingProviderName(null) }}
                        autoFocus
                      />
                    ) : (
                      <span
                        className="text-sm font-medium cursor-pointer hover:text-primary truncate"
                        onDoubleClick={() => { setEditingProviderName(p.id); setEditingNameValue(p.name) }}
                        title={t("provider.editNameTitle")}
                      >
                        {p.name}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      onClick={() => setExpandedProviderId(expanded ? null : p.id)}
                      title={t("provider.edit")}
                      className={expanded ? "text-primary" : ""}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button variant="ghost" size="icon-xs" onClick={() => setDeleteProviderTarget(p.id)} title={t("provider.deleteTitle")}>
                      <Trash2 className="h-3.5 w-3.5 text-red-500" />
                    </Button>
                  </div>
                </div>

                {expanded && (<>
                  <div className="grid grid-cols-3 gap-3">
                    <Field label={t("provider.apiFormat")}>
                      <Select
                        value={form.api_format}
                        onValueChange={(v) => setProviderFormField(p.id, "api_format", v ?? "")}
                      >
                        <SelectTrigger className="w-full h-9 text-sm">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {API_FORMAT_OPTIONS.map(opt => (
                            <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </Field>
                    <Field label={t("provider.apiKey")} className="col-span-2">
                      <Input
                        type="text"
                        value={form.api_key}
                        onChange={e => setProviderFormField(p.id, "api_key", e.target.value)}
                        placeholder={t("provider.apiKeyPH")}
                        className="text-sm"
                      />
                    </Field>
                    <Field label={t("provider.apiUrl")} className="col-span-3">
                      <Input
                        value={form.api_url}
                        onChange={e => setProviderFormField(p.id, "api_url", e.target.value)}
                        placeholder={t("provider.apiUrlPH")}
                        className="text-sm font-mono"
                      />
                    </Field>
                    <Field label={t("provider.modelFetchUrl")} className="col-span-3">
                      <Input
                        value={p.api_url ? form.model_fetch_url : ""}
                        onChange={e => setProviderFormField(p.id, "model_fetch_url", e.target.value)}
                        placeholder={t("provider.modelFetchUrlPH")}
                        className="text-sm font-mono"
                      />
                    </Field>
                  </div>

                  {saveNeeded && (
                    <div>
                      <Button size="sm" onClick={() => saveProviderOverrides(p.id)}>{t("provider.saveConfig")}</Button>
                    </div>
                  )}
                </>)}

                <div className="border-t border-border pt-3 space-y-1">
                  {providerModels.length === 0 ? (
                    <p className="text-xs text-muted-foreground py-2">{t("provider.noModelsYet")}</p>
                  ) : (
                    providerModels.map(m => (
                      <div
                        key={m.id}
                        className={`flex items-center gap-3 px-2 py-2 rounded text-sm ${
                          m.stale ? "border border-red-500/50 text-red-500" : "hover:bg-muted/20"
                        }`}
                      >
                        <button
                          onClick={() => m.stale ? toggleModelStale(m) : toggleModelEnabled(m)}
                          className={`shrink-0 transition-colors ${m.stale ? "text-red-500" : "text-yellow-500"}`}
                          title={m.stale ? t("provider.staleTitle") : t("provider.activeTitle")}
                        >
                          <Star className={`h-4 w-4 ${m.stale ? "" : "fill-current"}`} />
                        </button>
                        <span className="flex-1 font-medium truncate">{m.name}</span>
                        {m.stale && <span className="text-[10px] text-red-500 shrink-0">{t("provider.stale")}</span>}
                      </div>
                    ))
                  )}
                </div>

                <div className="border-t border-border pt-3 flex items-center justify-between">
                  <p className="text-xs text-muted-foreground">
                    {providerModels.length === 0
                      ? t("provider.noModelsYetImport")
                      : t("provider.importedCount", { n: providerModels.length })}
                  </p>
                  <Button
                    size="sm"
                    className="gap-1.5"
                    onClick={() => openImportForProvider(p.id)}
                    title={t("provider.fetchModelsTitle")}
                  >
                    <Download className="h-3.5 w-3.5" />
                    {t("provider.import")}
                  </Button>
                </div>

                {importingFromProvider === p.id && (
                  <div className="border-t border-border pt-3 space-y-2">
                    <h5 className="text-xs font-medium">{t("provider.importHeading")}</h5>
                    {importModelLoading ? (
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <Loader2 className="h-3 w-3 animate-spin" />{t("provider.loading")}
                      </div>
                    ) : availableModels.length === 0 ? (
                      <p className="text-xs text-muted-foreground">{t("provider.noModelsFromApi")}</p>
                    ) : (
                      <>
                        <div className="flex items-center gap-2">
                          <button
                            className="text-xs text-primary hover:underline"
                            onClick={() => {
                              const selectable = availableModels.filter(m => !enabledModelNames.has(m.id))
                              if (selectable.every(m => selectedModels.has(m.id))) setSelectedModels(new Set())
                              else setSelectedModels(new Set(selectable.map(m => m.id)))
                            }}
                          >
                            {(() => {
                              const selectable = availableModels.filter(m => !enabledModelNames.has(m.id))
                              return selectable.length > 0 && selectable.every(m => selectedModels.has(m.id)) ? t("provider.unselectAll") : t("provider.selectAll")
                            })()}
                          </button>
                          <span className="text-xs text-muted-foreground">
                            {t("provider.selectedXofY", { selected: selectedModels.size, total: availableModels.filter(m => !enabledModelNames.has(m.id)).length })}
                          </span>
                        </div>
                        <div className="max-h-48 overflow-auto space-y-0.5">
                          {availableModels.map(m => {
                            const alreadyEnabled = enabledModelNames.has(m.id)
                            if (alreadyEnabled) {
                              return (
                                <div key={m.id} className="flex items-center gap-2 px-2 py-1 rounded text-xs text-muted-foreground opacity-50">
                                  <Star className="h-3.5 w-3.5 fill-current text-yellow-500 shrink-0" />
                                  <span className="font-mono">{m.id}</span>
                                  {m.name && <span className="text-muted-foreground">— {m.name}</span>}
                                  <span className="ml-auto text-[10px]">{t("provider.alreadyActive")}</span>
                                </div>
                              )
                            }
                            return (
                              <label key={m.id} className="flex items-center gap-2 px-2 py-1 rounded text-xs hover:bg-muted/30 cursor-pointer">
                                <input
                                  type="checkbox"
                                  checked={selectedModels.has(m.id)}
                                  onChange={() => toggleModelSelection(m.id)}
                                  className="rounded"
                                />
                                <span className="font-mono">{m.id}</span>
                                {m.name && <span className="text-muted-foreground">— {m.name}</span>}
                              </label>
                            )
                          })}
                        </div>
                        <div className="flex gap-2">
                          <Button size="sm" onClick={importSelectedModels} disabled={selectedModels.size === 0 || importModelLoading}>
                            {importModelLoading ? <Loader2 className="h-3 w-3 animate-spin mr-1.5" /> : <Download className="h-3 w-3 mr-1.5" />}
                            {t("provider.importSelected", { n: selectedModels.size })}
                          </Button>
                          <Button size="sm" variant="outline" onClick={() => { setImportingFromProvider(null); setAvailableModels([]); setSelectedModels(new Set()) }}>
                            {t("common:cancel")}
                          </Button>
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      <ConfirmDialog
        open={deleteProviderTarget !== null}
        title={t("del.providerTitle")}
        message={t("del.providerMessage")}
        variant="destructive"
        confirmText={t("common:delete")}
        onConfirm={deleteProvider}
        onCancel={() => setDeleteProviderTarget(null)}
      />
    </div>
  )
}
