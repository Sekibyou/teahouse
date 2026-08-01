import { useEffect, useState, useCallback } from "react"
import {
  Server, Cpu, Sliders, X, Loader2, Plus, Pencil, Trash2,
  CheckCircle2, AlertCircle, Download, Star, FileText, Link2,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ConfirmDialog } from "@/components/ConfirmDialog"
import { llmProvidersApi, llmModelsApi, modelProfilesApi, llmSlotsApi, directorPromptPresetsApi } from "@/lib/api"
import type { LLMProvider, LLMModel, ModelProfile, SlotBindings, AvailableModel, SlotBinding, DirectorPromptPreset } from "@/lib/types"
import { SlotCard } from "@/components/SlotCard"

interface LLMManagementDialogProps {
  open: boolean
  onClose: () => void
  defaultTab?: TabKey
}

type TabKey = "models" | "profiles" | "presets" | "slots"

const API_FORMAT_LABELS: Record<string, string> = {
  openai: "OpenAI 兼容",
  openai_strict: "OpenAI 严格",
  anthropic: "Anthropic",
}

const API_FORMAT_OPTIONS = [
  { value: "openai", label: "openai" },
  { value: "openai_strict", label: "openai_strict" },
  { value: "anthropic", label: "anthropic" },
]

const TAB_ITEMS: { key: TabKey; Icon: typeof Server; label: string }[] = [
  { key: "models", Icon: Server, label: "模型池" },
  { key: "profiles", Icon: Sliders, label: "参数预设" },
  { key: "presets", Icon: FileText, label: "导演提示词预设" },
  { key: "slots", Icon: Link2, label: "槽位指定" },
]

// ─── Inline field helper ───
function Field({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={`space-y-1 ${className || ""}`}>
      <label className="text-xs text-muted-foreground">{label}</label>
      {children}
    </div>
  )
}

// ─── Inline modal overlay (reusable) ───
function EditModal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="absolute inset-0 bg-black/40 flex items-center justify-center z-20 rounded-lg" onClick={onClose}>
      <div
        className="bg-background rounded-lg shadow-xl border border-border w-[500px] max-h-[80%] p-6 space-y-4 overflow-y-auto"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-sm">{title}</h3>
          <button className="p-1 rounded hover:bg-muted" onClick={onClose}>
            <X className="h-4 w-4" />
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

export function LLMManagementDialog({ open, onClose, defaultTab }: LLMManagementDialogProps) {
  const [tab, setTab] = useState<TabKey>("models")

  // ─── Provider state ───
  const [providers, setProviders] = useState<LLMProvider[]>([])
  const [providersLoading, setProvidersLoading] = useState(false)
  const [showProviderCreate, setShowProviderCreate] = useState(false)
  const [providerCreateForm, setProviderCreateForm] = useState({ name: "", api_url: "", api_key: "", api_format: "openai" })
  const [editingProviderName, setEditingProviderName] = useState<string | null>(null)
  const [editingNameValue, setEditingNameValue] = useState("")
  const [providerError, setProviderError] = useState("")
  const [providerSaving, setProviderSaving] = useState(false)
  const [deleteProviderTarget, setDeleteProviderTarget] = useState<string | null>(null)

  // ─── Provider model fetch / import state ───
  const [fetchedModels, setFetchedModels] = useState<Record<string, AvailableModel[]>>({})
  const [fetchingModels, setFetchingModels] = useState<Record<string, boolean>>({})
  const [importingFromProvider, setImportingFromProvider] = useState<string | null>(null)
  const [availableModels, setAvailableModels] = useState<AvailableModel[]>([])
  const [importModelLoading, setImportModelLoading] = useState(false)
  const [selectedModels, setSelectedModels] = useState<Set<string>>(new Set())

  // ─── Model state ───
  const [models, setModels] = useState<LLMModel[]>([])
  const [modelsLoading, setModelsLoading] = useState(false)

  // ─── Profile state ───
  const [profiles, setProfiles] = useState<ModelProfile[]>([])
  const [profilesLoading, setProfilesLoading] = useState(false)
  const [createProfileOpen, setCreateProfileOpen] = useState(false)
  const [editingProfile, setEditingProfile] = useState<ModelProfile | null>(null)
  const [profileForm, setProfileForm] = useState({ name: "", match_pattern: "", temperature: 1.0, max_tokens: 4096, top_p: "", frequency_penalty: "", presence_penalty: "" })
  const [profileFormError, setProfileFormError] = useState("")
  const [profileFormSaving, setProfileFormSaving] = useState(false)
  const [deleteProfileTarget, setDeleteProfileTarget] = useState<string | null>(null)

  // ─── Preset state ───
  const [presets, setPresets] = useState<DirectorPromptPreset[]>([])
  const [presetsLoading, setPresetsLoading] = useState(false)
  const [createPresetOpen, setCreatePresetOpen] = useState(false)
  const [editingPreset, setEditingPreset] = useState<DirectorPromptPreset | null>(null)
  const [presetForm, setPresetForm] = useState({ name: "", template_yaml: "", match_pattern: "" })
  const [presetFormError, setPresetFormError] = useState("")
  const [presetFormSaving, setPresetFormSaving] = useState(false)
  const [deletePresetTarget, setDeletePresetTarget] = useState<string | null>(null)

  // ─── Slot state ───
  const [slotBindings, setSlotBindings] = useState<SlotBindings>({ director: { model_id: null, profile_id: null, prompt_preset_id: null }, writer: { model_id: null, profile_id: null, prompt_preset_id: null } })
  const [slotsLoading, setSlotsLoading] = useState(false)

  const [error, setError] = useState("")

  // ─── Provider form overrides per card ───
  const [providerFormOverrides, setProviderFormOverrides] = useState<Record<string, { api_url?: string; api_key?: string; api_format?: string; model_fetch_url?: string }>>({})

  // Compute model fetch URL from API URL (must be defined before loadAll)
  const computeModelFetchUrl = (apiUrl: string): string => {
    let base = apiUrl.replace(/\/chat\/completions\/?$/, "")
    base = base.replace(/\/+$/, "")
    return `${base}/models`
  }

  // ─── Load all data ───
  const loadAll = useCallback(async () => {
    setProvidersLoading(true)
    setModelsLoading(true)
    setProfilesLoading(true)
    setPresetsLoading(true)
    setSlotsLoading(true)
    setError("")

    const [pRes, mRes, profRes, presRes, sRes] = await Promise.all([
      llmProvidersApi.list(),
      llmModelsApi.list(),
      modelProfilesApi.list(),
      directorPromptPresetsApi.list(),
      llmSlotsApi.getAll(),
    ])

    if (pRes.ok) {
      setProviders(pRes.data!.providers)
    }
    else setError(pRes.error || "加载供应商失败")

    if (mRes.ok) setModels(mRes.data!.models)
    else setError(mRes.error || "加载模型失败")

    if (profRes.ok) setProfiles(profRes.data!.profiles)

    if (presRes.ok) setPresets(presRes.data!.presets)

    if (sRes.ok) setSlotBindings(sRes.data!.slots)
    else setError(sRes.error || "加载槽位失败")

    setProvidersLoading(false)
    setModelsLoading(false)
    setProfilesLoading(false)
    setPresetsLoading(false)
    setSlotsLoading(false)
  }, [])

  // Set defaultTab when dialog opens
  useEffect(() => {
    if (open) {
      setTab(defaultTab || "models")
      loadAll()
    }
  }, [open, defaultTab, loadAll])

  if (!open) return null

  // ─── Provider helpers ───

  const getProviderModels = (providerId: string): (LLMModel & { stale?: boolean })[] => {
    const providerModels = models.filter(m => m.provider_id === providerId)
    const fetched = fetchedModels[providerId]
    if (!fetched || fetched.length === 0) return providerModels
    const fetchedIds = new Set(fetched.map(m => m.id))
    return providerModels.map(m => ({
      ...m,
      stale: m.is_enabled === 1 && !fetchedIds.has(m.model_name),
    }))
  }

  const fetchProviderModels = async (providerId: string) => {
    setFetchingModels(f => ({ ...f, [providerId]: true }))
    const form = getProviderFormFor(providers.find(p => p.id === providerId)!)
    const res = await llmProvidersApi.availableModels(providerId, form.model_fetch_url)
    if (res.ok) {
      setFetchedModels(f => ({ ...f, [providerId]: res.data!.models }))
    } else {
      setError(res.error || "获取模型列表失败")
    }
    setFetchingModels(f => ({ ...f, [providerId]: false }))
  }

  // ─── Provider handlers ───

  const openProviderCreate = () => {
    setProviderError("")
    setProviderCreateForm({ name: "", api_url: "", api_key: "", api_format: "openai" })
    setShowProviderCreate(true)
  }

  const saveProviderCreate = async () => {
    const f = providerCreateForm
    if (!f.name || !f.api_url || !f.api_key) { setProviderError("请填写所有必填字段"); return }
    setProviderSaving(true)
    setProviderError("")
    const res = await llmProvidersApi.create({ name: f.name.trim(), api_url: f.api_url.trim(), api_key: f.api_key.trim(), api_format: f.api_format })
    if (res.ok) {
      setShowProviderCreate(false)
      setProviderCreateForm({ name: "", api_url: "", api_key: "", api_format: "openai" })
      await loadAll()
    } else setProviderError(res.error || "创建失败")
    setProviderSaving(false)
  }

  const saveProviderName = async (providerId: string) => {
    if (!editingNameValue.trim()) { setEditingProviderName(null); return }
    const p = providers.find(pp => pp.id === providerId)
    if (!p) return
    await llmProvidersApi.update(providerId, { name: editingNameValue.trim(), api_url: p.api_url, api_key: p.api_key, api_format: p.api_format })
    setEditingProviderName(null)
    await loadAll()
  }

  const saveProviderField = async (providerId: string, field: string, value: string) => {
    const p = providers.find(pp => pp.id === providerId)
    if (!p) return
    // Build the update payload carefully
    const updatePayload: Record<string, unknown> = {
      name: p.name,
      api_url: p.api_url,
      api_key: p.api_key,
      api_format: p.api_format,
    }
    updatePayload[field] = value
    await llmProvidersApi.update(providerId, updatePayload)
    await loadAll()
  }

  const deleteProvider = async () => {
    if (!deleteProviderTarget) return
    await llmProvidersApi.delete(deleteProviderTarget)
    setDeleteProviderTarget(null)
    await loadAll()
  }

  // ─── Model handlers ───

  const toggleModelEnabled = async (model: LLMModel) => {
    await llmModelsApi.update(model.id, { is_enabled: !model.is_enabled })
    await loadAll()
  }

  const toggleModelStale = async (model: LLMModel) => {
    // Un-starring a stale model = delete it
    await llmModelsApi.delete(model.id)
    await loadAll()
  }

  // ─── Import handlers ───

  const openImportForProvider = async (providerId: string) => {
    setImportingFromProvider(providerId)
    setImportModelLoading(true)
    setSelectedModels(new Set())
    const form = getProviderFormFor(providers.find(p => p.id === providerId)!)
    const res = await llmProvidersApi.availableModels(providerId, form.model_fetch_url)
    if (res.ok) setAvailableModels(res.data!.models)
    else setError(res.error || "获取模型列表失败")
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
    for (const modelName of selectedModels) {
      modelProfiles[modelName] = ""
    }
    const res = await llmProvidersApi.importModels(importingFromProvider, modelProfiles)
    if (res.ok) {
      setImportingFromProvider(null)
      setAvailableModels([])
      setSelectedModels(new Set())
      await loadAll()
    } else setError(res.error || "导入失败")
    setImportModelLoading(false)
  }

  // ─── Profile handlers ───

  const openProfileCreate = () => {
    setProfileFormError("")
    setProfileForm({ name: "", match_pattern: "", temperature: 1.0, max_tokens: 4096, top_p: "", frequency_penalty: "", presence_penalty: "" })
    setEditingProfile(null)
    setCreateProfileOpen(true)
  }

  const openProfileEdit = (p: ModelProfile) => {
    setProfileFormError("")
    setProfileForm({
      name: p.name,
      match_pattern: p.match_pattern || "",
      temperature: p.temperature,
      max_tokens: p.max_tokens,
      top_p: p.top_p != null ? String(p.top_p) : "",
      frequency_penalty: p.frequency_penalty != null ? String(p.frequency_penalty) : "",
      presence_penalty: p.presence_penalty != null ? String(p.presence_penalty) : "",
    })
    setEditingProfile(p)
    setCreateProfileOpen(true)
  }

  const saveProfile = async () => {
    const f = profileForm
    if (!f.name) { setProfileFormError("请填写名称"); return }
    setProfileFormSaving(true)
    setProfileFormError("")

    const payload = {
      name: f.name.trim(),
      match_pattern: f.match_pattern?.trim() || null,
      temperature: f.temperature,
      max_tokens: f.max_tokens,
      top_p: f.top_p ? parseFloat(f.top_p) : null,
      frequency_penalty: f.frequency_penalty ? parseFloat(f.frequency_penalty) : null,
      presence_penalty: f.presence_penalty ? parseFloat(f.presence_penalty) : null,
    }

    if (editingProfile) {
      const res = await modelProfilesApi.update(editingProfile.id, payload as Record<string, unknown>)
      if (res.ok) { setCreateProfileOpen(false); setEditingProfile(null); await loadAll() }
      else setProfileFormError(res.error || "更新失败")
    } else {
      const res = await modelProfilesApi.create(payload as ModelProfile & { name: string })
      if (res.ok) { setCreateProfileOpen(false); await loadAll() }
      else setProfileFormError(res.error || "创建失败")
    }
    setProfileFormSaving(false)
  }

  const deleteProfile = async () => {
    if (!deleteProfileTarget) return
    await modelProfilesApi.delete(deleteProfileTarget)
    setDeleteProfileTarget(null)
    await loadAll()
  }

  // ─── Preset handlers ───

  const openPresetCreate = () => {
    setPresetFormError("")
    // Copy from built-in preset as template
    const builtin = presets.find(p => p.is_builtin)
    setPresetForm({ name: "", template_yaml: builtin?.template_yaml || "", match_pattern: "" })
    setEditingPreset(null)
    setCreatePresetOpen(true)
  }

  const openPresetEdit = (p: DirectorPromptPreset) => {
    setPresetFormError("")
    setPresetForm({ name: p.name, template_yaml: p.template_yaml || "", match_pattern: p.match_pattern || "" })
    setEditingPreset(p)
    setCreatePresetOpen(true)
  }

  const savePreset = async () => {
    const f = presetForm
    if (!f.name || !f.template_yaml) { setPresetFormError("请填写名称和模板 YAML"); return }
    setPresetFormSaving(true)
    setPresetFormError("")

    let success = false
    if (editingPreset) {
      const res = await directorPromptPresetsApi.update(editingPreset.id, { name: f.name.trim(), template_yaml: f.template_yaml, match_pattern: f.match_pattern.trim() || null })
      if (res.ok) success = true
      else setPresetFormError(res.error || "更新失败")
    } else {
      const res = await directorPromptPresetsApi.create({ name: f.name.trim(), template_yaml: f.template_yaml, match_pattern: f.match_pattern.trim() || null })
      if (res.ok) success = true
      else setPresetFormError(res.error || "创建失败")
    }
    setPresetFormSaving(false)
    if (success) {
      // Close form before reloading to let Monaco dispose cleanly
      setCreatePresetOpen(false)
      setEditingPreset(null)
      await loadAll()
    }
  }

  const deletePreset = async () => {
    if (!deletePresetTarget) return
    await directorPromptPresetsApi.delete(deletePresetTarget)
    setDeletePresetTarget(null)
    await loadAll()
  }

  // ─── Slot handlers ───

  const handleSlotChange = (slotId: "director" | "writer") => (binding: SlotBinding) => {
    setSlotBindings(prev => ({ ...prev, [slotId]: binding }))
  }

  // ─── Helpers for provider form state per card ───

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
      // When api_url changes and user hasn't manually set model_fetch_url, auto-compute it
      if (field === "api_url" && existing.model_fetch_url === undefined) {
        const p = providers.find(pp => pp.id === providerId)
        // Only auto-compute if there's no saved model_fetch_url on the provider
        if (p && !p.model_fetch_url) {
          next.model_fetch_url = computeModelFetchUrl(value)
        }
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
      api_key: override.api_key !== undefined ? override.api_key : p.api_key,
      api_format: override.api_format !== undefined ? override.api_format : p.api_format,
      model_fetch_url: override.model_fetch_url !== undefined ? override.model_fetch_url : (p.model_fetch_url || ""),
    }
    const res = await llmProvidersApi.update(providerId, payload)
    if (res.ok) {
      setProviderFormOverrides(prev => { const n = { ...prev }; delete n[providerId]; return n })
      await loadAll()
    } else {
      setError(res.error || "保存失败")
    }
  }

  return (
    <>
      <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={onClose}>
        <div
          className="bg-background rounded-lg shadow-xl flex flex-col overflow-hidden"
          style={{ width: "90vw", height: "90vh", maxWidth: 1400, maxHeight: 900 }}
          onClick={e => e.stopPropagation()}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-3 border-b border-border shrink-0">
            <div className="flex items-center gap-2">
              <Cpu className="h-4 w-4 text-primary" />
              <span className="font-semibold">模型管理</span>
            </div>
            <button className="p-1 rounded hover:bg-muted" onClick={onClose}>
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* Error bar */}
          {error && (
            <div className="px-6 py-2 bg-red-500/10 border-b border-red-500/20 text-xs text-red-500 shrink-0 flex items-center gap-2">
              <AlertCircle className="h-3 w-3 shrink-0" />
              <span className="flex-1">{error}</span>
              <button className="underline shrink-0" onClick={() => setError("")}>关闭</button>
            </div>
          )}

          {/* Body: sidebar + content */}
          <div className="flex flex-1 overflow-hidden">
            {/* Left sidebar */}
            <div className="w-44 shrink-0 border-r border-border flex flex-col bg-muted/10">
              <div className="flex flex-col gap-0.5 p-2">
                {TAB_ITEMS.map(({ key, Icon, label }) => (
                  <button
                    key={key}
                    className={`flex items-center gap-2 px-3 py-2.5 text-xs rounded-md transition-colors text-left whitespace-nowrap ${
                      tab === key ? "bg-accent text-accent-foreground font-medium" : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
                    }`}
                    onClick={() => setTab(key)}
                  >
                    <Icon className="h-4 w-4 shrink-0" />
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {/* Right content */}
            <div className="flex-1 overflow-auto relative">
              {/* ── Tab 1: Model Pool ── */}
              {tab === "models" && (
                <div className="p-5 space-y-4">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-medium text-muted-foreground">模型池</h3>
                    {!showProviderCreate && (
                      <Button size="sm" variant="outline" onClick={openProviderCreate}>
                        <Plus className="h-3.5 w-3.5 mr-1.5" />添加供应商
                      </Button>
                    )}
                  </div>

                  {/* Inline create form */}
                  {showProviderCreate && (
                    <div className="rounded-lg border border-primary/30 bg-primary/5 p-4">
                      <h4 className="text-sm font-medium mb-3">添加供应商</h4>
                      <div className="space-y-3">
                        <div className="grid grid-cols-2 gap-3">
                          <Field label="名称">
                            <Input value={providerCreateForm.name} onChange={e => setProviderCreateForm(f => ({ ...f, name: e.target.value }))} placeholder="如 OpenAI" className="text-sm" autoFocus />
                          </Field>
                          <Field label="API 格式">
                            <select
                              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
                              value={providerCreateForm.api_format}
                              onChange={e => setProviderCreateForm(f => ({ ...f, api_format: e.target.value }))}
                            >
                              {API_FORMAT_OPTIONS.map(opt => (
                                <option key={opt.value} value={opt.value}>{opt.label}</option>
                              ))}
                            </select>
                          </Field>
                          <Field label="API URL" className="col-span-2">
                            <Input value={providerCreateForm.api_url} onChange={e => setProviderCreateForm(f => ({ ...f, api_url: e.target.value }))} placeholder="https://api.openai.com" className="text-sm font-mono" />
                          </Field>
                          <Field label="API Key" className="col-span-2">
                            <Input type="password" value={providerCreateForm.api_key} onChange={e => setProviderCreateForm(f => ({ ...f, api_key: e.target.value }))} placeholder="sk-..." className="text-sm" />
                          </Field>
                        </div>
                        {providerError && <p className="text-xs text-red-500">{providerError}</p>}
                        <div className="flex gap-2">
                          <Button size="sm" onClick={saveProviderCreate} disabled={providerSaving}>
                            {providerSaving ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : null}创建
                          </Button>
                          <Button size="sm" variant="outline" onClick={() => { setShowProviderCreate(false); setProviderCreateForm({ name: "", api_url: "", api_key: "", api_format: "openai" }); setProviderError("") }}>
                            取消
                          </Button>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Provider list */}
                  {providersLoading ? (
                    <div className="flex items-center justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
                  ) : providers.length === 0 ? (
                    <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">暂无供应商</div>
                  ) : (
                    <div className="space-y-3">
                      {providers.map(p => {
                        const form = getProviderFormFor(p)
                        const saveNeeded = isProviderSaveNeeded(p)
                        const providerModels = getProviderModels(p.id)
                        const isFetching = fetchingModels[p.id]

                        return (
                          <div key={p.id} className={`rounded-lg border p-4 space-y-3 ${p.is_enabled ? "border-border" : "border-muted opacity-60"}`}>
                            {/* Title row */}
                            <div className="flex items-center justify-between">
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
                                  className="text-sm font-medium cursor-pointer hover:text-primary"
                                  onDoubleClick={() => { setEditingProviderName(p.id); setEditingNameValue(p.name) }}
                                  title="双击编辑名称"
                                >
                                  {p.name}
                                </span>
                              )}
                              <div className="flex items-center gap-1">
                                <Button
                                  variant="ghost"
                                  size="icon-xs"
                                  onClick={() => openImportForProvider(p.id)}
                                  title="批量导入模型"
                                >
                                  <Plus className="h-3.5 w-3.5" />
                                </Button>
                                <Button variant="ghost" size="icon-xs" onClick={() => setDeleteProviderTarget(p.id)} title="删除供应商">
                                  <Trash2 className="h-3.5 w-3.5 text-red-500" />
                                </Button>
                              </div>
                            </div>

                            {/* Provider form fields */}
                            <div className="grid grid-cols-2 gap-3">
                              <Field label="API Format">
                                <select
                                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
                                  value={form.api_format}
                                  onChange={e => setProviderFormField(p.id, "api_format", e.target.value)}
                                >
                                  {API_FORMAT_OPTIONS.map(opt => (
                                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                                  ))}
                                </select>
                              </Field>
                              <Field label="API URL">
                                <Input
                                  value={form.api_url}
                                  onChange={e => setProviderFormField(p.id, "api_url", e.target.value)}
                                  placeholder="https://api.openai.com"
                                  className="text-sm font-mono"
                                />
                              </Field>
                              <Field label="API Key">
                                <Input
                                  type="password"
                                  value={form.api_key}
                                  onChange={e => setProviderFormField(p.id, "api_key", e.target.value)}
                                  placeholder="sk-..."
                                  className="text-sm"
                                />
                              </Field>
                              <Field label="Model Fetch URL">
                                <Input
                                  value={p.api_url ? form.model_fetch_url : ""}
                                  onChange={e => setProviderFormField(p.id, "model_fetch_url", e.target.value)}
                                  placeholder="https://api.example.com/v1/models"
                                  className="text-sm font-mono"
                                />
                              </Field>
                            </div>

                            {/* Save button */}
                            {saveNeeded && (
                              <div>
                                <Button size="sm" onClick={() => saveProviderOverrides(p.id)}>保存供应商配置</Button>
                              </div>
                            )}

                            {/* Model list under provider — always visible */}
                            <div className="border-t border-border pt-3 space-y-1">
                              {isFetching ? (
                                <div className="flex items-center gap-2 text-xs text-muted-foreground py-2">
                                  <Loader2 className="h-3 w-3 animate-spin" />正在获取模型列表...
                                </div>
                              ) : providerModels.length === 0 ? (
                                <p className="text-xs text-muted-foreground py-2">暂无已导入模型，请点击 + 按钮批量导入</p>
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
                                      className={`shrink-0 transition-colors ${m.stale ? "text-red-500" : m.is_enabled ? "text-yellow-500" : "text-muted-foreground"}`}
                                      title={m.stale ? "已过期（不在远端列表中），点击移除" : m.is_enabled ? "已启用，点击禁用" : "已禁用，点击启用"}
                                    >
                                      <Star className={`h-4 w-4 ${(m.is_enabled && !m.stale) ? "fill-current" : ""}`} />
                                    </button>
                                    <span className="flex-1 font-medium truncate">{m.name}</span>
                                    <span className="text-xs font-mono text-muted-foreground truncate">{m.model_name}</span>
                                    {m.stale && <span className="text-[10px] text-red-500 shrink-0">已过期</span>}
                                  </div>
                                ))
                              )}
                            </div>

                            {/* Import models sub-panel */}
                            {importingFromProvider === p.id && (
                              <div className="border-t border-border pt-3 space-y-2">
                                <h5 className="text-xs font-medium">导入模型 — 勾选要导入的模型</h5>
                                {importModelLoading ? (
                                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                                    <Loader2 className="h-3 w-3 animate-spin" />加载中...
                                  </div>
                                ) : availableModels.length === 0 ? (
                                  <p className="text-xs text-muted-foreground">未获取到模型或该供应商不支持模型列表 API</p>
                                ) : (
                                  <>
                                    <div className="flex items-center gap-2">
                                      <button
                                        className="text-xs text-primary hover:underline"
                                        onClick={() => {
                                          if (selectedModels.size === availableModels.length) setSelectedModels(new Set())
                                          else setSelectedModels(new Set(availableModels.map(m => m.id)))
                                        }}
                                      >
                                        {selectedModels.size === availableModels.length ? "取消全选" : "全选"}
                                      </button>
                                      <span className="text-xs text-muted-foreground">已选 {selectedModels.size}/{availableModels.length}</span>
                                    </div>
                                    <div className="max-h-48 overflow-auto space-y-0.5">
                                      {availableModels.map(m => (
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
                                      ))}
                                    </div>
                                    <div className="flex gap-2">
                                      <Button size="sm" onClick={importSelectedModels} disabled={selectedModels.size === 0 || importModelLoading}>
                                        {importModelLoading ? <Loader2 className="h-3 w-3 animate-spin mr-1.5" /> : <Download className="h-3 w-3 mr-1.5" />}
                                        导入选中 ({selectedModels.size})
                                      </Button>
                                      <Button size="sm" variant="outline" onClick={() => { setImportingFromProvider(null); setAvailableModels([]); setSelectedModels(new Set()) }}>
                                        取消
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
                </div>
              )}

              {/* ── Tab 2: Model Profiles ── */}
              {tab === "profiles" && (
                <div className="p-5 space-y-4 h-full flex flex-col">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-medium text-muted-foreground">参数预设</h3>
                    {!createProfileOpen && (
                      <Button size="sm" variant="outline" onClick={openProfileCreate}>
                        <Plus className="h-3.5 w-3.5 mr-1.5" />创建预设
                      </Button>
                    )}
                  </div>

                  {/* Create / Edit form */}
                  {createProfileOpen && (
                    <div className="rounded-lg border border-primary/30 bg-primary/5 p-4 shrink-0">
                      <h4 className="text-sm font-medium mb-3">
                        {editingProfile?.is_builtin ? "查看内置预设（只读）" : editingProfile ? "编辑预设" : "创建预设"}
                      </h4>
                      <div className="space-y-3">
                        <div className="grid grid-cols-2 gap-3">
                          <Field label="名称">
                            <Input value={profileForm.name} onChange={e => setProfileForm(f => ({ ...f, name: e.target.value }))} placeholder="如 默认参数" className="text-sm" disabled={!!editingProfile?.is_builtin} autoFocus />
                          </Field>
                          <Field label="匹配模式（正则）">
                            <Input value={profileForm.match_pattern} onChange={e => setProfileForm(f => ({ ...f, match_pattern: e.target.value }))} placeholder="如 gpt-4.*" className="text-sm font-mono" disabled={!!editingProfile?.is_builtin} />
                          </Field>
                          <Field label="Temperature">
                            <Input type="number" step="0.1" min="0" max="2" value={profileForm.temperature} onChange={e => setProfileForm(f => ({ ...f, temperature: parseFloat(e.target.value) || 0 }))} className="text-sm" disabled={!!editingProfile?.is_builtin} />
                          </Field>
                          <Field label="Max Tokens">
                            <Input type="number" step="1" min="1" value={profileForm.max_tokens} onChange={e => setProfileForm(f => ({ ...f, max_tokens: parseInt(e.target.value) || 0 }))} className="text-sm" disabled={!!editingProfile?.is_builtin} />
                          </Field>
                          <Field label="Top P">
                            <Input value={profileForm.top_p} onChange={e => setProfileForm(f => ({ ...f, top_p: e.target.value }))} placeholder="0.0-1.0" className="text-sm" disabled={!!editingProfile?.is_builtin} />
                          </Field>
                          <Field label="Frequency Penalty">
                            <Input value={profileForm.frequency_penalty} onChange={e => setProfileForm(f => ({ ...f, frequency_penalty: e.target.value }))} placeholder="0.0-2.0" className="text-sm" disabled={!!editingProfile?.is_builtin} />
                          </Field>
                          <Field label="Presence Penalty" className="col-span-2">
                            <Input value={profileForm.presence_penalty} onChange={e => setProfileForm(f => ({ ...f, presence_penalty: e.target.value }))} placeholder="0.0-2.0" className="text-sm" disabled={!!editingProfile?.is_builtin} />
                          </Field>
                        </div>
                        {profileFormError && <p className="text-xs text-red-500">{profileFormError}</p>}
                        <div className="flex gap-2">
                          {!editingProfile?.is_builtin && (
                            <Button size="sm" onClick={saveProfile} disabled={profileFormSaving}>
                              {profileFormSaving ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : null}
                              {editingProfile ? "保存" : "创建"}
                            </Button>
                          )}
                          <Button size="sm" variant="outline" onClick={() => { setCreateProfileOpen(false); setEditingProfile(null); setProfileFormError("") }}>
                            {editingProfile?.is_builtin ? "关闭" : "取消"}
                          </Button>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Profile list */}
                  {profilesLoading ? (
                    <div className="flex items-center justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
                  ) : profiles.length === 0 ? (
                    <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">暂无预设</div>
                  ) : (
                    <div className="space-y-2 overflow-auto flex-1">
                      {/* Built-in profiles */}
                      {profiles.filter(p => p.is_builtin).map(p => (
                        <div key={p.id} className="rounded-lg border border-border bg-muted/20 p-4 flex items-start justify-between opacity-70">
                          <div className="space-y-1 flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-medium">{p.name}</span>
                              <span className="text-[10px] bg-muted px-1.5 py-0.5 rounded">内置</span>
                            </div>
                            <div className="text-xs text-muted-foreground">内置预设，不可编辑或删除</div>
                          </div>
                          <Button variant="ghost" size="icon-xs" onClick={() => openProfileEdit(p)} title="查看">
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      ))}
                      {/* Custom profiles — skip the one currently being edited */}
                      {profiles.filter(p => !p.is_builtin && p.id !== editingProfile?.id).map(p => (
                        <div key={p.id} className="rounded-lg border border-border p-4 flex items-start justify-between group">
                          <div className="space-y-1 flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-medium">{p.name}</span>
                              {p.match_pattern && (
                                <span className="text-[10px] font-mono bg-muted px-1.5 py-0.5 rounded">{p.match_pattern}</span>
                              )}
                            </div>
                            <div className="text-xs text-muted-foreground flex flex-wrap gap-x-3 gap-y-0.5">
                              <span>temp: {p.temperature}</span>
                              <span>max_tokens: {p.max_tokens}</span>
                              {p.top_p != null && <span>top_p: {p.top_p}</span>}
                              {p.frequency_penalty != null && <span>freq_pen: {p.frequency_penalty}</span>}
                              {p.presence_penalty != null && <span>pres_pen: {p.presence_penalty}</span>}
                            </div>
                          </div>
                          <div className="flex items-center gap-0.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity ml-2">
                            <Button variant="ghost" size="icon-xs" onClick={() => openProfileEdit(p)} title="编辑">
                              <Pencil className="h-3.5 w-3.5" />
                            </Button>
                            <Button variant="ghost" size="icon-xs" onClick={() => setDeleteProfileTarget(p.id)} title="删除">
                              <Trash2 className="h-3.5 w-3.5 text-red-500" />
                            </Button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* ── Tab 3: Director Prompt Presets ── */}
              {tab === "presets" && (
                <div className="p-5 space-y-4 h-full flex flex-col">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-medium text-muted-foreground">导演提示词预设</h3>
                    {!createPresetOpen && (
                      <Button size="sm" variant="outline" onClick={openPresetCreate}>
                        <Plus className="h-3.5 w-3.5 mr-1.5" />创建预设
                      </Button>
                    )}
                  </div>

                  {/* Create / Edit form */}
                  {createPresetOpen && (
                    <div className="rounded-lg border border-primary/30 bg-primary/5 p-4 shrink-0">
                      <h4 className="text-sm font-medium mb-3">
                        {editingPreset?.is_builtin ? "查看内置预设（只读）" : editingPreset ? "编辑预设" : "创建预设"}
                      </h4>
                      <div className="space-y-3">
                        <Field label="名称">
                          <Input value={presetForm.name} onChange={e => setPresetForm(f => ({ ...f, name: e.target.value }))} placeholder="如 默认导演提示词" className="text-sm" disabled={!!editingPreset?.is_builtin} autoFocus />
                        </Field>
                        <Field label="Match Pattern (正则)">
                          <Input value={presetForm.match_pattern} onChange={e => setPresetForm(f => ({ ...f, match_pattern: e.target.value }))} placeholder="deepseek" className="text-sm" disabled={!!editingPreset?.is_builtin} />
                        </Field>
                        <Field label="模板 YAML">
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
                              {editingPreset ? "保存" : "创建"}
                            </Button>
                          )}
                          <Button size="sm" variant="outline" onClick={() => { setCreatePresetOpen(false); setEditingPreset(null); setPresetFormError("") }}>
                            {editingPreset?.is_builtin ? "关闭" : "取消"}
                          </Button>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Preset list */}
                  {presetsLoading ? (
                    <div className="flex items-center justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
                  ) : presets.length === 0 ? (
                    <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">暂无预设</div>
                  ) : (
                    <div className="space-y-2 overflow-auto flex-1">
                      {/* Built-in presets first */}
                      {presets.filter(p => p.is_builtin).map(p => (
                        <div key={p.id} className="rounded-lg border border-border bg-muted/20 p-4 flex items-start justify-between opacity-70">
                          <div className="space-y-1 flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-medium">{p.name}</span>
                              <span className="text-[10px] bg-muted px-1.5 py-0.5 rounded">built-in</span>
                            </div>
                            <div className="text-xs text-muted-foreground">内置预设，不可编辑或删除</div>
                          </div>
                          <Button variant="ghost" size="icon-xs" onClick={() => openPresetEdit(p)} title="查看">
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      ))}
                      {/* Custom presets — skip the one currently being edited */}
                      {presets.filter(p => !p.is_builtin && p.id !== editingPreset?.id).map(p => (
                        <div key={p.id} className="rounded-lg border border-border p-4 flex items-start justify-between group">
                          <div className="space-y-1 flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-medium">{p.name}</span>
                            </div>
                            <div className="text-xs text-muted-foreground font-mono whitespace-pre-wrap line-clamp-2">
                              {p.template_yaml ? p.template_yaml.slice(0, 100) + (p.template_yaml.length > 100 ? "..." : "") : "（空模板）"}
                            </div>
                          </div>
                          <div className="flex items-center gap-0.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity ml-2">
                            <Button variant="ghost" size="icon-xs" onClick={() => openPresetEdit(p)} title="编辑">
                              <Pencil className="h-3.5 w-3.5" />
                            </Button>
                            <Button variant="ghost" size="icon-xs" onClick={() => setDeletePresetTarget(p.id)} title="删除">
                              <Trash2 className="h-3.5 w-3.5 text-red-500" />
                            </Button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* ── Tab 4: Slot Assignment ── */}
              {tab === "slots" && (
                <div className="p-5 h-full flex flex-col">
                  <h3 className="text-sm font-medium text-muted-foreground mb-4">槽位指定</h3>
                  {slotsLoading ? (
                    <div className="flex items-center justify-center flex-1"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
                  ) : (
                    <div className="flex gap-6 flex-1 overflow-hidden">
                      <SlotCard
                        slotId="director"
                        label="导演模型"
                        binding={slotBindings.director}
                        models={models}
                        profiles={profiles}
                        presets={presets}
                        onChange={handleSlotChange("director")}
                      />
                      <SlotCard
                        slotId="writer"
                        label="正文模型"
                        binding={slotBindings.writer}
                        models={models}
                        profiles={profiles}
                        onChange={handleSlotChange("writer")}
                      />
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Delete confirmations */}
      <ConfirmDialog
        open={deleteProviderTarget !== null}
        title="删除供应商"
        message="删除供应商同时会删除其下所有模型，此操作不可恢复。确认删除？"
        variant="destructive"
        confirmText="删除"
        onConfirm={deleteProvider}
        onCancel={() => setDeleteProviderTarget(null)}
      />

      <ConfirmDialog
        open={deleteProfileTarget !== null}
        title="删除预设"
        message="删除后将从模型关联中移除，此操作不可恢复。确认删除？"
        variant="destructive"
        confirmText="删除"
        onConfirm={deleteProfile}
        onCancel={() => setDeleteProfileTarget(null)}
      />

      <ConfirmDialog
        open={deletePresetTarget !== null}
        title="删除导演提示词预设"
        message="删除导演提示词预设后无法恢复。确认删除？"
        variant="destructive"
        confirmText="删除"
        onConfirm={deletePreset}
        onCancel={() => setDeletePresetTarget(null)}
      />
    </>
  )
}
