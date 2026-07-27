import { useEffect, useState, useCallback } from "react"
import {
  Server, Cpu, Sliders, X, Loader2, Plus, Pencil, Trash2,
  CheckCircle2, AlertCircle, Download, Star,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ConfirmDialog } from "@/components/ConfirmDialog"
import { llmProvidersApi, llmModelsApi, modelProfilesApi, llmSlotsApi } from "@/lib/api"
import type { LLMProvider, LLMModel, ModelProfile, SlotBindings, AvailableModel } from "@/lib/types"
import { ProfileDialog } from "@/components/ProfileDialog"

interface LLMManagementDialogProps {
  open: boolean
  onClose: () => void
}

type TabKey = "providers" | "models" | "slots"

const API_FORMAT_LABELS: Record<string, string> = {
  openai: "OpenAI 兼容",
  openai_strict: "OpenAI 严格",
  anthropic: "Anthropic",
}

// ─── Inline field helper ───
function Field({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={`space-y-1 ${className || ""}`}>
      <label className="text-xs text-muted-foreground">{label}</label>
      {children}
    </div>
  )
}

// ─── Edit modal shared component ───
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

export function LLMManagementDialog({ open, onClose }: LLMManagementDialogProps) {
  const [tab, setTab] = useState<TabKey>("providers")
  const [showProfileDialog, setShowProfileDialog] = useState(false)

  // Provider state
  const [providers, setProviders] = useState<LLMProvider[]>([])
  const [providersLoading, setProvidersLoading] = useState(false)
  const [showProviderCreate, setShowProviderCreate] = useState(false)
  const [providerCreateForm, setProviderCreateForm] = useState({ name: "", api_url: "", api_key: "", api_format: "openai" })
  const [editingProvider, setEditingProvider] = useState<LLMProvider | null>(null)
  const [providerEditForm, setProviderEditForm] = useState({ name: "", api_url: "", api_key: "", api_format: "openai" })
  const [providerError, setProviderError] = useState("")
  const [providerSaving, setProviderSaving] = useState(false)
  const [deleteProviderTarget, setDeleteProviderTarget] = useState<string | null>(null)

  // Model import state
  const [importingFromProvider, setImportingFromProvider] = useState<string | null>(null)
  const [availableModels, setAvailableModels] = useState<AvailableModel[]>([])
  const [importModelLoading, setImportModelLoading] = useState(false)
  const [selectedModels, setSelectedModels] = useState<Set<string>>(new Set())
  const [importProfileId, setImportProfileId] = useState("")

  // Model state
  const [models, setModels] = useState<LLMModel[]>([])
  const [modelsLoading, setModelsLoading] = useState(false)
  const [showModelCreate, setShowModelCreate] = useState(false)
  const [modelCreateForm, setModelCreateForm] = useState({ name: "", provider_id: "", model_name: "", profile_id: "" })
  const [editingModel, setEditingModel] = useState<LLMModel | null>(null)
  const [modelEditForm, setModelEditForm] = useState({ name: "", provider_id: "", model_name: "", profile_id: "" })
  const [modelError, setModelError] = useState("")
  const [modelSaving, setModelSaving] = useState(false)
  const [deleteModelTarget, setDeleteModelTarget] = useState<string | null>(null)

  // Profile context (for dropdowns)
  const [profiles, setProfiles] = useState<ModelProfile[]>([])

  // Slot state
  const [slotBindings, setSlotBindings] = useState<SlotBindings>({ director: null, writer: null })
  const [slotsLoading, setSlotsLoading] = useState(false)
  const [selectedSlot, setSelectedSlot] = useState<"director" | "writer" | null>(null)

  const [error, setError] = useState("")

  const loadAll = useCallback(async () => {
    setProvidersLoading(true)
    setModelsLoading(true)
    setSlotsLoading(true)
    setError("")

    const [pRes, mRes, sRes, profRes] = await Promise.all([
      llmProvidersApi.list(),
      llmModelsApi.list(),
      llmSlotsApi.getAll(),
      modelProfilesApi.list(),
    ])

    if (pRes.ok) setProviders(pRes.data!.providers)
    else setError(pRes.error || "加载供应商失败")

    if (mRes.ok) setModels(mRes.data!.models)
    else setError(mRes.error || "加载模型失败")

    if (sRes.ok) setSlotBindings(sRes.data!.slots)
    else setError(sRes.error || "加载槽位失败")

    if (profRes.ok) setProfiles(profRes.data!.profiles)

    setProvidersLoading(false)
    setModelsLoading(false)
    setSlotsLoading(false)
  }, [])

  useEffect(() => {
    if (open) loadAll()
  }, [open, loadAll])

  if (!open) return null

  // ─── Provider handlers ───

  const openProviderCreate = () => {
    setProviderError("")
    setProviderCreateForm({ name: "", api_url: "", api_key: "", api_format: "openai" })
    setShowProviderCreate(true)
  }

  const openProviderEdit = (p: LLMProvider) => {
    setProviderError("")
    setEditingProvider(p)
    setProviderEditForm({ name: p.name, api_url: p.api_url, api_key: p.api_key, api_format: p.api_format })
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

  const saveProviderEdit = async () => {
    if (!editingProvider) return
    const f = providerEditForm
    if (!f.name || !f.api_url || !f.api_key) { setProviderError("请填写所有必填字段"); return }
    setProviderSaving(true)
    setProviderError("")
    const res = await llmProvidersApi.update(editingProvider.id, { name: f.name.trim(), api_url: f.api_url.trim(), api_key: f.api_key.trim(), api_format: f.api_format })
    if (res.ok) { setEditingProvider(null); await loadAll() }
    else setProviderError(res.error || "更新失败")
    setProviderSaving(false)
  }

  const deleteProvider = async () => {
    if (!deleteProviderTarget) return
    await llmProvidersApi.delete(deleteProviderTarget)
    setDeleteProviderTarget(null)
    await loadAll()
  }

  const fetchAvailableModels = async (providerId: string) => {
    setImportingFromProvider(providerId)
    setImportModelLoading(true)
    setSelectedModels(new Set())
    setImportProfileId("")
    const res = await llmProvidersApi.availableModels(providerId)
    if (res.ok) setAvailableModels(res.data!.models)
    else setError(res.error || "获取模型列表失败")
    setImportModelLoading(false)
  }

  const importSelectedModels = async () => {
    if (!importingFromProvider || selectedModels.size === 0) return
    setImportModelLoading(true)
    const modelProfiles: Record<string, string> = {}
    for (const modelName of selectedModels) {
      modelProfiles[modelName] = importProfileId || ""
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

  const toggleModelSelection = (modelName: string) => {
    const next = new Set(selectedModels)
    if (next.has(modelName)) next.delete(modelName)
    else next.add(modelName)
    setSelectedModels(next)
  }

  // ─── Model handlers ───

  const openModelCreate = () => {
    setModelError("")
    setModelCreateForm({ name: "", provider_id: providers[0]?.id || "", model_name: "", profile_id: "" })
    setShowModelCreate(true)
  }

  const openModelEdit = (m: LLMModel) => {
    setModelError("")
    setEditingModel(m)
    setModelEditForm({ name: m.name, provider_id: m.provider_id, model_name: m.model_name, profile_id: m.profile_id || "" })
  }

  const saveModelCreate = async () => {
    const f = modelCreateForm
    if (!f.name || !f.provider_id || !f.model_name) { setModelError("请填写所有必填字段"); return }
    setModelSaving(true)
    setModelError("")
    const res = await llmModelsApi.create({ name: f.name.trim(), provider_id: f.provider_id, model_name: f.model_name.trim(), profile_id: f.profile_id || undefined })
    if (res.ok) {
      setShowModelCreate(false)
      setModelCreateForm({ name: "", provider_id: providers[0]?.id || "", model_name: "", profile_id: "" })
      await loadAll()
    } else setModelError(res.error || "创建失败")
    setModelSaving(false)
  }

  const saveModelEdit = async () => {
    if (!editingModel) return
    const f = modelEditForm
    if (!f.name || !f.provider_id || !f.model_name) { setModelError("请填写所有必填字段"); return }
    setModelSaving(true)
    setModelError("")
    const res = await llmModelsApi.update(editingModel.id, { name: f.name.trim(), provider_id: f.provider_id, model_name: f.model_name.trim(), profile_id: f.profile_id || null })
    if (res.ok) { setEditingModel(null); await loadAll() }
    else setModelError(res.error || "更新失败")
    setModelSaving(false)
  }

  const deleteModel = async () => {
    if (!deleteModelTarget) return
    await llmModelsApi.delete(deleteModelTarget)
    setDeleteModelTarget(null)
    await loadAll()
  }

  const toggleModelEnabled = async (model: LLMModel) => {
    await llmModelsApi.update(model.id, { is_enabled: !model.is_enabled })
    await loadAll()
  }

  // ─── Slot handlers ───
  const assignSlot = async (slotId: "director" | "writer", modelId: string | null) => {
    await llmSlotsApi.setSlot(slotId, modelId)
    await loadAll()
  }

  // ─── Derived ───
  const enabledModels = models.filter(m => m.is_enabled)

  // ─── Render helpers ───

  const renderProviderCreateForm = () => (
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
            {Object.entries(API_FORMAT_LABELS).map(([v, label]) => (
              <option key={v} value={v}>{label}</option>
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
  )

  const renderProviderEditForm = () => (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <Field label="名称">
          <Input value={providerEditForm.name} onChange={e => setProviderEditForm(f => ({ ...f, name: e.target.value }))} placeholder="如 OpenAI" className="text-sm" autoFocus />
        </Field>
        <Field label="API 格式">
          <select
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
            value={providerEditForm.api_format}
            onChange={e => setProviderEditForm(f => ({ ...f, api_format: e.target.value }))}
          >
            {Object.entries(API_FORMAT_LABELS).map(([v, label]) => (
              <option key={v} value={v}>{label}</option>
            ))}
          </select>
        </Field>
        <Field label="API URL" className="col-span-2">
          <Input value={providerEditForm.api_url} onChange={e => setProviderEditForm(f => ({ ...f, api_url: e.target.value }))} placeholder="https://api.openai.com" className="text-sm font-mono" />
        </Field>
        <Field label="API Key" className="col-span-2">
          <Input type="password" value={providerEditForm.api_key} onChange={e => setProviderEditForm(f => ({ ...f, api_key: e.target.value }))} placeholder="sk-..." className="text-sm" />
        </Field>
      </div>
      {providerError && <p className="text-xs text-red-500">{providerError}</p>}
      <div className="flex gap-2">
        <Button size="sm" onClick={saveProviderEdit} disabled={providerSaving}>
          {providerSaving ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : null}保存
        </Button>
        <Button size="sm" variant="outline" onClick={() => { setEditingProvider(null); setProviderError("") }}>
          取消
        </Button>
      </div>
    </div>
  )

  const renderModelCreateForm = () => (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <Field label="显示名称">
          <Input value={modelCreateForm.name} onChange={e => setModelCreateForm(f => ({ ...f, name: e.target.value }))} placeholder="如 GPT-4o Fast" className="text-sm" autoFocus />
        </Field>
        <Field label="Model ID">
          <Input value={modelCreateForm.model_name} onChange={e => setModelCreateForm(f => ({ ...f, model_name: e.target.value }))} placeholder="gpt-4o" className="text-sm font-mono" />
        </Field>
        <Field label="供应商">
          <select
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
            value={modelCreateForm.provider_id}
            onChange={e => setModelCreateForm(f => ({ ...f, provider_id: e.target.value }))}
          >
            {providers.map(p => (<option key={p.id} value={p.id}>{p.name}</option>))}
          </select>
        </Field>
        <Field label="参数配置">
          <select
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
            value={modelCreateForm.profile_id}
            onChange={e => setModelCreateForm(f => ({ ...f, profile_id: e.target.value }))}
          >
            <option value="">不绑定</option>
            {profiles.map(pr => (<option key={pr.id} value={pr.id}>{pr.name}</option>))}
          </select>
        </Field>
      </div>
      {modelError && <p className="text-xs text-red-500">{modelError}</p>}
      <div className="flex gap-2">
        <Button size="sm" onClick={saveModelCreate} disabled={modelSaving}>
          {modelSaving ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : null}创建
        </Button>
        <Button size="sm" variant="outline" onClick={() => { setShowModelCreate(false); setModelCreateForm({ name: "", provider_id: providers[0]?.id || "", model_name: "", profile_id: "" }); setModelError("") }}>
          取消
        </Button>
      </div>
    </div>
  )

  const renderModelEditForm = () => (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <Field label="显示名称">
          <Input value={modelEditForm.name} onChange={e => setModelEditForm(f => ({ ...f, name: e.target.value }))} placeholder="如 GPT-4o Fast" className="text-sm" autoFocus />
        </Field>
        <Field label="Model ID">
          <Input value={modelEditForm.model_name} onChange={e => setModelEditForm(f => ({ ...f, model_name: e.target.value }))} placeholder="gpt-4o" className="text-sm font-mono" />
        </Field>
        <Field label="供应商">
          <select
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
            value={modelEditForm.provider_id}
            onChange={e => setModelEditForm(f => ({ ...f, provider_id: e.target.value }))}
          >
            {providers.map(p => (<option key={p.id} value={p.id}>{p.name}</option>))}
          </select>
        </Field>
        <Field label="参数配置">
          <select
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
            value={modelEditForm.profile_id}
            onChange={e => setModelEditForm(f => ({ ...f, profile_id: e.target.value }))}
          >
            <option value="">不绑定</option>
            {profiles.map(pr => (<option key={pr.id} value={pr.id}>{pr.name}</option>))}
          </select>
        </Field>
      </div>
      {modelError && <p className="text-xs text-red-500">{modelError}</p>}
      <div className="flex gap-2">
        <Button size="sm" onClick={saveModelEdit} disabled={modelSaving}>
          {modelSaving ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : null}保存
        </Button>
        <Button size="sm" variant="outline" onClick={() => { setEditingModel(null); setModelError("") }}>
          取消
        </Button>
      </div>
    </div>
  )

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
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => { setShowProfileDialog(true); setError("") }}>
                <Sliders className="h-3.5 w-3.5 mr-1.5" />
                预设编辑
              </Button>
              <button className="p-1 rounded hover:bg-muted" onClick={onClose}>
                <X className="h-4 w-4" />
              </button>
            </div>
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
            <div className="w-40 shrink-0 border-r border-border flex flex-col bg-muted/10">
              <div className="flex flex-col gap-0.5 p-2">
                {([
                  ["providers", Server, "供应商"],
                  ["models", Cpu, "模型池"],
                  ["slots", Star, "槽位指定"],
                ] as const).map(([key, Icon, label]) => (
                  <button
                    key={key}
                    className={`flex items-center gap-2.5 px-3 py-2.5 text-sm rounded-md transition-colors text-left ${
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
              {/* ── Tab: Providers ── */}
              {tab === "providers" && (
                <div className="p-5 space-y-4">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-medium text-muted-foreground">API 供应商</h3>
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
                      {renderProviderCreateForm()}
                    </div>
                  )}

                  {/* Edit modal overlay */}
                  {editingProvider && (
                    <EditModal title="编辑供应商" onClose={() => { setEditingProvider(null); setProviderError("") }}>
                      {renderProviderEditForm()}
                    </EditModal>
                  )}

                  {/* Provider list */}
                  {providersLoading ? (
                    <div className="flex items-center justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
                  ) : providers.length === 0 ? (
                    <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">暂无供应商</div>
                  ) : (
                    <div className="space-y-2">
                      {providers.map(p => (
                        <div key={p.id} className={`rounded-lg border p-4 space-y-2 ${p.is_enabled ? "border-border" : "border-muted opacity-60"}`}>
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-medium">{p.name}</span>
                              <span className="text-[10px] font-mono bg-muted px-1.5 py-0.5 rounded">{API_FORMAT_LABELS[p.api_format] || p.api_format}</span>
                              {p.is_enabled ? (
                                <span className="text-[10px] text-green-500 flex items-center gap-0.5"><CheckCircle2 className="h-3 w-3" />启用</span>
                              ) : (
                                <span className="text-[10px] text-muted-foreground flex items-center gap-0.5"><AlertCircle className="h-3 w-3" />禁用</span>
                              )}
                            </div>
                            <div className="flex items-center gap-1">
                              <Button variant="ghost" size="icon-xs" onClick={() => fetchAvailableModels(p.id)} title="获取模型列表">
                                <Download className="h-3.5 w-3.5" />
                              </Button>
                              <Button variant="ghost" size="icon-xs" onClick={() => openProviderEdit(p)} title="编辑">
                                <Pencil className="h-3.5 w-3.5" />
                              </Button>
                              <Button variant="ghost" size="icon-xs" onClick={() => setDeleteProviderTarget(p.id)} title="删除">
                                <Trash2 className="h-3.5 w-3.5 text-red-500" />
                              </Button>
                            </div>
                          </div>
                          <div className="text-xs text-muted-foreground font-mono truncate">{p.api_url}</div>

                          {/* Import models panel */}
                          {importingFromProvider === p.id && (
                            <div className="border-t border-border pt-3 mt-3 space-y-2">
                              <h5 className="text-xs font-medium">可用模型</h5>
                              {importModelLoading ? (
                                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                                  <Loader2 className="h-3 w-3 animate-spin" />加载中...
                                </div>
                              ) : availableModels.length === 0 ? (
                                <p className="text-xs text-muted-foreground">未获取到模型或该供应商不支持模型列表 API</p>
                              ) : (
                                <>
                                  <div className="flex items-center gap-2 mb-2">
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
                                    {profiles.length > 0 && (
                                      <select
                                        className="ml-auto text-xs rounded border border-input bg-background px-1.5 py-1"
                                        value={importProfileId}
                                        onChange={e => setImportProfileId(e.target.value)}
                                      >
                                        <option value="">不绑定配置</option>
                                        {profiles.map(pr => (
                                          <option key={pr.id} value={pr.id}>{pr.name}</option>
                                        ))}
                                      </select>
                                    )}
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
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* ── Tab: Models ── */}
              {tab === "models" && (
                <div className="p-5 space-y-4">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-medium text-muted-foreground">模型池</h3>
                    {!showModelCreate && (
                      <Button size="sm" variant="outline" onClick={openModelCreate}>
                        <Plus className="h-3.5 w-3.5 mr-1.5" />添加模型
                      </Button>
                    )}
                  </div>

                  {/* Inline create form */}
                  {showModelCreate && (
                    <div className="rounded-lg border border-primary/30 bg-primary/5 p-4">
                      <h4 className="text-sm font-medium mb-3">添加模型</h4>
                      {renderModelCreateForm()}
                    </div>
                  )}

                  {/* Edit modal overlay */}
                  {editingModel && (
                    <EditModal title="编辑模型" onClose={() => { setEditingModel(null); setModelError("") }}>
                      {renderModelEditForm()}
                    </EditModal>
                  )}

                  {/* Model list */}
                  {modelsLoading ? (
                    <div className="flex items-center justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
                  ) : models.length === 0 ? (
                    <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">暂无模型</div>
                  ) : (
                    <div className="space-y-1">
                      {models.map(m => (
                        <div key={m.id} className={`flex items-center gap-3 px-3 py-2.5 rounded-lg border text-sm ${m.is_enabled ? "border-border hover:bg-muted/20" : "border-muted opacity-50"}`}>
                          <button
                            onClick={() => toggleModelEnabled(m)}
                            className={`shrink-0 transition-colors ${m.is_enabled ? "text-green-500" : "text-muted-foreground"}`}
                            title={m.is_enabled ? "启用中，点击禁用" : "已禁用，点击启用"}
                          >
                            {m.is_enabled ? <CheckCircle2 className="h-4 w-4" /> : <AlertCircle className="h-4 w-4" />}
                          </button>

                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="font-medium truncate">{m.name}</span>
                              <span className="text-xs font-mono text-muted-foreground truncate">{m.model_name}</span>
                            </div>
                            <div className="text-xs text-muted-foreground">
                              {m.provider_name || m.provider_id}
                              {profiles.find(pr => pr.id === m.profile_id) && (
                                <span className="ml-2 text-[10px] bg-muted px-1 rounded">
                                  {profiles.find(pr => pr.id === m.profile_id)?.name}
                                </span>
                              )}
                            </div>
                          </div>

                          <div className="flex items-center gap-0.5 shrink-0">
                            <Button variant="ghost" size="icon-xs" onClick={() => openModelEdit(m)} title="编辑">
                              <Pencil className="h-3.5 w-3.5" />
                            </Button>
                            <Button variant="ghost" size="icon-xs" onClick={() => setDeleteModelTarget(m.id)} title="删除">
                              <Trash2 className="h-3.5 w-3.5 text-red-500" />
                            </Button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* ── Tab: Slots ── */}
              {tab === "slots" && (
                <div className="p-5 h-full flex flex-col">
                  <h3 className="text-sm font-medium text-muted-foreground mb-4">槽位指定</h3>
                  {slotsLoading ? (
                    <div className="flex items-center justify-center flex-1"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
                  ) : (
                    <div className="flex gap-6 flex-1 overflow-hidden">
                      {/* Left: slot cards */}
                      <div className="w-72 shrink-0 space-y-3">
                        {(["director", "writer"] as const).map(slotId => {
                          const boundModel = models.find(m => m.id === slotBindings[slotId])
                          const isSelected = selectedSlot === slotId
                          return (
                            <button
                              key={slotId}
                              className={`w-full text-left rounded-lg border-2 p-4 transition-colors ${
                                isSelected ? "border-primary bg-primary/5" : "border-border hover:border-primary/40"
                              }`}
                              onClick={() => setSelectedSlot(isSelected ? null : slotId)}
                            >
                              <div className="flex items-center gap-2 mb-2">
                                <Star className={`h-4 w-4 ${isSelected ? "text-primary" : "text-muted-foreground"}`} />
                                <span className="font-medium text-sm">
                                  {slotId === "director" ? "导演模型" : "正文模型"}
                                </span>
                              </div>
                              <p className="text-xs text-muted-foreground mb-3">
                                {slotId === "director"
                                  ? "建议选用主流且实惠的模型。负责编排决策 / 总结 / 设定探索，需要好的指令遵循能力。"
                                  : "建议使用最好的模型。负责正文写作和修改，需要最佳创意品质。"}
                              </p>
                              {boundModel ? (
                                <div className="text-xs space-y-0.5 bg-muted/30 rounded p-2">
                                  <div className="font-medium">{boundModel.name}</div>
                                  <div className="text-muted-foreground font-mono">{boundModel.model_name}</div>
                                  <div className="text-muted-foreground">{boundModel.provider_name}</div>
                                </div>
                              ) : (
                                <div className="text-xs text-yellow-500 bg-yellow-500/5 rounded p-2">
                                  未绑定模型
                                </div>
                              )}
                            </button>
                          )
                        })}
                      </div>

                      {/* Right: enabled model list */}
                      <div className="flex-1 overflow-auto">
                        <h4 className="text-xs font-medium text-muted-foreground mb-2">
                          已启用模型 ({enabledModels.length})
                        </h4>
                        {enabledModels.length === 0 ? (
                          <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
                            没有已启用的模型
                          </div>
                        ) : (
                          <div className="space-y-1">
                            {enabledModels.map(m => {
                              const boundSlots = (Object.entries(slotBindings) as [string, string | null][]).filter(([, mid]) => mid === m.id).map(([sid]) => sid)
                              const isBound = boundSlots.length > 0
                              return (
                                <button
                                  key={m.id}
                                  className={`w-full text-left flex items-center gap-3 px-3 py-2.5 rounded-lg border text-sm transition-colors ${
                                    isBound ? "border-primary/50 bg-primary/5" : "border-border hover:bg-muted/20"
                                  }`}
                                  onClick={() => {
                                    if (selectedSlot) {
                                      const alreadyBound = boundSlots.includes(selectedSlot)
                                      assignSlot(selectedSlot, alreadyBound ? null : m.id)
                                    }
                                  }}
                                >
                                  <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-2">
                                      <span className="font-medium truncate">{m.name}</span>
                                      <span className="text-xs font-mono text-muted-foreground truncate">{m.model_name}</span>
                                    </div>
                                    <div className="text-xs text-muted-foreground">{m.provider_name}</div>
                                  </div>
                                  {boundSlots.length > 0 && (
                                    <span className="text-[10px] bg-primary/10 text-primary px-1.5 py-0.5 rounded shrink-0">
                                      {boundSlots.map(s => s === "director" ? "导演" : "正文").join(" · ")}
                                    </span>
                                  )}
                                </button>
                              )
                            })}
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Profile sub-dialog */}
      <ProfileDialog
        open={showProfileDialog}
        onClose={() => { setShowProfileDialog(false); loadAll() }}
        profiles={profiles}
      />

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
        open={deleteModelTarget !== null}
        title="删除模型"
        message="删除模型后将从槽位绑定中移除，此操作不可恢复。确认删除？"
        variant="destructive"
        confirmText="删除"
        onConfirm={deleteModel}
        onCancel={() => setDeleteModelTarget(null)}
      />
    </>
  )
}
