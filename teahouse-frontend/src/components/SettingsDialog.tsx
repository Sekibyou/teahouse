import { useEffect, useState, useCallback, useRef } from "react"
import {
  Server, Cpu, Sliders, X, ChevronLeft, Check, Loader2, Plus, Pencil, Trash2,
  AlertCircle, Download, Star, FileText, Link2,
  Sun, Moon, SlidersHorizontal, Puzzle, Upload, Power, PowerOff, Shield,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ConfirmDialog } from "@/components/ConfirmDialog"
import { PluginConfigPanel } from "@/components/PluginConfigPanel"
import { llmProvidersApi, llmModelsApi, modelProfilesApi, llmSlotsApi, directorPromptPresetsApi, appSettingsApi, pluginsApi } from "@/lib/api"
import type { LLMProvider, LLMModel, ModelProfile, SlotBindings, AvailableModel, SlotBinding, DirectorPromptPreset, AppSettings } from "@/lib/types"
import { SlotCard } from "@/components/SlotCard"
import { useThemeStore } from "@/stores/themeStore"
import { useSettingsDialogStore } from "@/stores/settingsDialogStore"
import { useIsMobile } from "@/hooks/useMediaQuery"
import { useDialogBackClose } from "@/hooks/useDialogBackClose"
import type { Plugin, PluginPreview, NetworkRule } from "@/lib/pluginTypes"

interface SettingsDialogProps {
  open?: boolean
  onClose?: () => void
  defaultTab?: TabKey
}

type TabKey = "models" | "profiles" | "presets" | "slots" | "general" | "plugins"

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
  { key: "general", Icon: SlidersHorizontal, label: "通用设置" },
  { key: "plugins", Icon: Puzzle, label: "插件管理" },
]

const permLabels: Record<string, string> = {
  tool: "导演工具",
  frontend: "前端面板",
  network: "网络请求",
  file_read: "读取文件",
  file_write: "写入文件",
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

export function SettingsDialog({ open: openProp, onClose: onCloseProp, defaultTab: defaultTabProp }: SettingsDialogProps) {
  const storeOpen = useSettingsDialogStore((s) => s.open)
  const storeDefaultTab = useSettingsDialogStore((s) => s.defaultTab)
  const closeSettings = useSettingsDialogStore((s) => s.closeSettings)

  // 未显式传 props 时由全局 store 驱动（MainLayout 挂载单实例）；
  // 传了 props 则回退到受控用法（如 ChatPanel 旧的本地 llmDialogOpen）。
  const open = openProp ?? storeOpen
  const onClose = onCloseProp ?? closeSettings
  const defaultTab = (defaultTabProp ?? storeDefaultTab) as TabKey | undefined
  const [tab, setTab] = useState<TabKey>("models")
  const isMobile = useIsMobile()
  useDialogBackClose(open, onClose)
  const [tabMenuOpen, setTabMenuOpen] = useState(false)

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
  const [importingFromProvider, setImportingFromProvider] = useState<string | null>(null)
  const [availableModels, setAvailableModels] = useState<AvailableModel[]>([])
  const [importModelLoading, setImportModelLoading] = useState(false)
  const [selectedModels, setSelectedModels] = useState<Set<string>>(new Set())

  // ─── Model state ───
  const [models, setModels] = useState<LLMModel[]>([])

  // ─── Profile state ───
  const [profiles, setProfiles] = useState<ModelProfile[]>([])
  const [profilesLoading, setProfilesLoading] = useState(false)
  const [createProfileOpen, setCreateProfileOpen] = useState(false)
  const [editingProfile, setEditingProfile] = useState<ModelProfile | null>(null)
  const [profileForm, setProfileForm] = useState({ name: "", match_pattern: "", temperature: 1.0, max_tokens: 4096, max_context: 131072, top_p: "", frequency_penalty: "", presence_penalty: "" })
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

  // ─── General settings state ───
  const [appSettings, setAppSettings] = useState<AppSettings>({ max_retries: 3, max_tool_rounds: 15 })
  const [settingsLoading, setSettingsLoading] = useState(false)
  const [settingsSaving, setSettingsSaving] = useState(false)
  const [settingsSaved, setSettingsSaved] = useState(false)

  // ─── Plugins state ───
  const [plugins, setPlugins] = useState<Plugin[]>([])
  const [pluginsLoading, setPluginsLoading] = useState(false)
  const [toggling, setToggling] = useState<Set<string>>(new Set())
  const [configPlugin, setConfigPlugin] = useState<Plugin | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Plugin | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [uploading, setUploading] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  // install confirmation (two-phase)
  const [preview, setPreview] = useState<PluginPreview | null>(null)
  const [previewError, setPreviewError] = useState("")
  const [installing, setInstalling] = useState(false)
  const pendingZipRef = useRef<File | null>(null)
  // network allowlist per-plugin panel
  const [netRulesFor, setNetRulesFor] = useState<Plugin | null>(null)
  const [netRules, setNetRules] = useState<NetworkRule[]>([])
  const [netRulesLoading, setNetRulesLoading] = useState(false)
  const [newRule, setNewRule] = useState<{ scheme: string; host: string; port: string }>({ scheme: "https", host: "", port: "" })
  const [netRuleError, setNetRuleError] = useState("")

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

  // Theme readthrough
  const isDark = useThemeStore((s) => s.isDark)
  const setTheme = useThemeStore((s) => s.setTheme)

  // Lazy-load general / plugins on first visit of those tabs
  const settingsLoadedRef = useRef(false)
  const pluginsLoadedRef = useRef(false)
  useEffect(() => {
    if (!open) return
    if (tab === "general" && !settingsLoadedRef.current) {
      settingsLoadedRef.current = true
      loadAppSettings()
    }
    if (tab === "plugins" && !pluginsLoadedRef.current) {
      pluginsLoadedRef.current = true
      loadPlugins()
    }
  }, [open, tab]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!open) return null

  // ─── Provider helpers ───

  const getProviderModels = (providerId: string): (LLMModel & { stale?: boolean })[] => {
    return models.filter(m => m.provider_id === providerId)
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
    setProfileForm({ name: "", match_pattern: "", temperature: 1.0, max_tokens: 4096, max_context: 131072, top_p: "", frequency_penalty: "", presence_penalty: "" })
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
      max_context: p.max_context ?? 131072,
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
      max_context: f.max_context,
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

  // ─── General settings handlers ───
  const loadAppSettings = async () => {
    setSettingsLoading(true)
    const res = await appSettingsApi.get()
    if (res.ok) setAppSettings(res.data!)
    setSettingsLoading(false)
  }

  const handleSaveSettings = async () => {
    setSettingsSaving(true)
    setSettingsSaved(false)
    const res = await appSettingsApi.update({ max_retries: appSettings.max_retries, max_tool_rounds: appSettings.max_tool_rounds })
    if (res.ok) {
      setAppSettings(res.data!)
      setSettingsSaved(true)
      setTimeout(() => setSettingsSaved(false), 2000)
    }
    setSettingsSaving(false)
  }

  // ─── Plugins handlers ───
  const loadPlugins = async () => {
    setPluginsLoading(true)
    const res = await pluginsApi.list()
    if (res.ok) setPlugins(res.data!.plugins)
    setPluginsLoading(false)
  }

  const handleToggle = async (p: Plugin) => {
    setToggling((prev) => new Set(prev).add(p.id))
    if (p.enabled) {
      await pluginsApi.disable(p.id)
    } else {
      await pluginsApi.enable(p.id)
    }
    await loadPlugins()
    setToggling((prev) => {
      const next = new Set(prev)
      next.delete(p.id)
      return next
    })
  }

  const handleDelete = async () => {
    if (!deleteTarget) return
    setDeleting(true)
    const res = await pluginsApi.uninstall(deleteTarget.id)
    setDeleting(false)
    setDeleteTarget(null)
    if (res.ok) {
      if (configPlugin?.id === deleteTarget.id) setConfigPlugin(null)
      await loadPlugins()
    }
  }

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setUploading(true)
    setPreviewError("")
    try {
      const form = new FormData()
      form.append("file", file)
      const res = await pluginsApi.preview(form)
      if (res.ok) {
        pendingZipRef.current = file
        setPreview(res.data)
      } else {
        setPreviewError(res.error || "插件预检失败")
        setPreview(null)
      }
    } finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ""
    }
  }

  const handleConfirmInstall = async () => {
    if (!preview) return
    setInstalling(true)
    try {
      const res = await pluginsApi.confirmInstall(preview.preview_id)
      setPreview(null)
      pendingZipRef.current = null
      if (res.ok) {
        await loadPlugins()
      } else {
        setPreviewError(res.error || "安装失败")
      }
    } finally {
      setInstalling(false)
    }
  }

  // ─── Network allowlist handlers ───
  const loadNetRules = async (p: Plugin) => {
    setNetRulesFor(p)
    setNetRulesLoading(true)
    setNetRuleError("")
    const res = await pluginsApi.getNetworkRules(p.id)
    if (res.ok && res.data) setNetRules(res.data.rules)
    else setNetRuleError(res.error || "加载网络白名单失败")
    setNetRulesLoading(false)
  }

  const closeNetRules = () => {
    setNetRulesFor(null)
    setNetRules([])
  }

  const handleAddRule = async () => {
    if (!netRulesFor) return
    const port = newRule.port.trim() === "" ? null : Number(newRule.port)
    if (!newRule.host.trim()) { setNetRuleError("host 不能为空"); return }
    if (newRule.port.trim() !== "" && !(port && port >= 1 && port <= 65535)) {
      setNetRuleError("port 需在 1-65535 之间")
      return
    }
    const res = await pluginsApi.addNetworkRule(netRulesFor.id, {
      scheme: newRule.scheme,
      host: newRule.host.trim(),
      port: port && port >= 1 && port <= 65535 ? port : null,
    })
    if (res.ok && res.data) {
      setNetRules((prev) => [...prev, res.data!.rule])
      setNewRule({ scheme: "https", host: "", port: "" })
      setNetRuleError("")
    } else {
      setNetRuleError(res.error || "新增规则失败")
    }
  }

  const handleToggleRule = async (rule: NetworkRule) => {
    if (!netRulesFor) return
    const next = !rule.enabled
    const res = next
      ? await pluginsApi.enableNetworkRule(netRulesFor.id, rule.id)
      : await pluginsApi.disableNetworkRule(netRulesFor.id, rule.id)
    if (res.ok) setNetRules((prev) => prev.map((r) => r.id === rule.id ? { ...r, enabled: next } : r))
  }

  const handleDeleteRule = async (rule: NetworkRule) => {
    if (!netRulesFor) return
    const res = await pluginsApi.deleteNetworkRule(netRulesFor.id, rule.id)
    if (res.ok) setNetRules((prev) => prev.filter((r) => r.id !== rule.id))
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
      <div
        className={`fixed inset-0 z-50 ${isMobile ? "bg-background" : "bg-background/70 backdrop-blur-lg flex items-center justify-center"}`}
        onClick={onClose}
      >
        <div
          className={`flex flex-col overflow-hidden ${isMobile
            ? "h-full w-full"
            : "bg-background rounded-lg shadow-xl"
          }`}
          style={
            isMobile
              ? undefined
              : { width: "90vw", height: "90vh", maxWidth: 1400, maxHeight: 900 }
          }
          onClick={e => e.stopPropagation()}
        >
          {/* Header */}
          {isMobile ? (
            <div className="relative h-10 border-b border-border flex items-center justify-center shrink-0 z-10">
              {/* Left: back arrow (close) */}
              <button
                className="absolute left-2 p-2 rounded hover:bg-muted flex items-center justify-center"
                onClick={onClose}
                aria-label="返回"
              >
                <ChevronLeft className="h-5 w-5" />
              </button>
              <span className="font-semibold text-sm">设置</span>
              {/* Right: tab dropdown trigger */}
              <div className="absolute right-1">
                <button
                  className="p-2 rounded hover:bg-muted flex items-center gap-1 text-sm"
                  onClick={() => setTabMenuOpen((v) => !v)}
                  aria-label="切换设置分类"
                >
                  {(() => { const cur = TAB_ITEMS.find((t) => t.key === tab); return cur ? <cur.Icon className="h-4 w-4" /> : null })()}
                </button>
                {tabMenuOpen && (
                  <>
                    <div className="fixed inset-0 z-40" onClick={() => setTabMenuOpen(false)} />
                    <div className="absolute right-1 top-full mt-1 z-50 bg-background border border-border rounded-md shadow-lg py-1 min-w-[150px]">
                      {TAB_ITEMS.map(({ key, Icon, label }) => (
                        <button
                          key={key}
                          className={`w-full flex items-center gap-2 px-3 py-2.5 text-sm text-left hover:bg-muted ${
                            tab === key ? "text-primary font-medium" : "text-foreground"
                          }`}
                          onClick={() => { setTab(key); setTabMenuOpen(false) }}
                        >
                          <Icon className="h-4 w-4 shrink-0" />
                          <span className="flex-1">{label}</span>
                          {tab === key && <Check className="h-4 w-4 shrink-0" />}
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-between px-6 py-3 border-b border-border shrink-0">
              <div className="flex items-center gap-2">
                <Cpu className="h-4 w-4 text-primary" />
                <span className="font-semibold">设置</span>
              </div>
              <button className="p-1 rounded hover:bg-muted" onClick={onClose}>
                <X className="h-4 w-4" />
              </button>
            </div>
          )}

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
            {/* Left sidebar (desktop only; mobile uses the top tab dropdown) */}
            {!isMobile && (
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
            )}

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
                              {providerModels.length === 0 ? (
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
                          <Field label="Max Context (自动压缩阈值为此值的70%)">
                            <Input type="number" step="1" min="1024" value={profileForm.max_context} onChange={e => setProfileForm(f => ({ ...f, max_context: parseInt(e.target.value) || 1024 }))} className="text-sm" disabled={!!editingProfile?.is_builtin} />
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
                              <span>max_ctx: {p.max_context ?? 131072}</span>
                              {p.top_p != null && <span>top_p: {p.top_p}</span>}
                              {p.frequency_penalty != null && <span>freq_pen: {p.frequency_penalty}</span>}
                              {p.presence_penalty != null && <span>pres_pen: {p.presence_penalty}</span>}
                            </div>
                          </div>
                          <div className={`flex items-center gap-0.5 shrink-0 transition-opacity ml-2${isMobile ? "" : " opacity-0 group-hover:opacity-100"}`}>
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
                          <div className={`flex items-center gap-0.5 shrink-0 transition-opacity ml-2${isMobile ? "" : " opacity-0 group-hover:opacity-100"}`}>
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

              {/* ── Tab 5: General Settings ── */}
              {tab === "general" && (
                <div className="p-5 space-y-6">
                  <div className="rounded-lg border p-4">
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="text-sm font-medium">外观</div>
                        <p className="text-xs text-muted-foreground mt-1">
                          切换界面明暗主题。
                        </p>
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setTheme(!isDark)}
                        className="gap-1.5"
                      >
                        {isDark ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
                        {isDark ? "切换日间模式" : "切换夜间模式"}
                      </Button>
                    </div>
                  </div>

                  {settingsLoading ? (
                    <div className="flex items-center justify-center py-12">
                      <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                    </div>
                  ) : (
                    <div className="space-y-4">
                      <div className="rounded-lg border p-4 space-y-4">
                        <div>
                          <label className="text-sm font-medium flex items-center justify-between">
                            <span>LLM 请求最大重试次数</span>
                            <span className="text-muted-foreground font-mono text-xs bg-muted px-2 py-0.5 rounded">
                              {appSettings.max_retries}
                            </span>
                          </label>
                          <p className="text-xs text-muted-foreground mt-1">
                            网络波动时自动重试 LLM API 请求。不重试业务错误（4xx/5xx）。设为 0 则禁用重试。
                          </p>
                          <div className="mt-3 flex items-center gap-3">
                            <input
                              type="range"
                              min={0}
                              max={10}
                              value={appSettings.max_retries}
                              onChange={(e) => setAppSettings({ ...appSettings, max_retries: Number(e.target.value) })}
                              className="flex-1 h-2 rounded-full appearance-none bg-muted cursor-pointer accent-primary"
                            />
                            <input
                              type="number"
                              min={0}
                              max={10}
                              value={appSettings.max_retries}
                              onChange={(e) => {
                                const v = Math.max(0, Math.min(10, Number(e.target.value) || 0))
                                setAppSettings({ ...appSettings, max_retries: v })
                              }}
                              className="w-16 h-8 rounded border border-border bg-muted/30 text-center text-sm font-mono [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                            />
                          </div>
                        </div>
                      </div>

                      <div className="rounded-lg border p-4 space-y-4">
                        <div>
                          <label className="text-sm font-medium flex items-center justify-between">
                            <span>单轮最大调用次数</span>
                            <span className="text-muted-foreground font-mono text-xs bg-muted px-2 py-0.5 rounded">
                              {appSettings.max_tool_rounds}
                            </span>
                          </label>
                          <p className="text-xs text-muted-foreground mt-1">
                            导演工具调用循环的轮数上限，防止单轮陷入过长的工具循环。
                          </p>
                          <div className="mt-3 flex items-center gap-3">
                            <input
                              type="range"
                              min={1}
                              max={200}
                              value={appSettings.max_tool_rounds}
                              onChange={(e) => setAppSettings({ ...appSettings, max_tool_rounds: Number(e.target.value) })}
                              className="flex-1 h-2 rounded-full appearance-none bg-muted cursor-pointer accent-primary"
                            />
                            <input
                              type="number"
                              min={1}
                              max={200}
                              value={appSettings.max_tool_rounds}
                              onChange={(e) => {
                                const v = Math.max(1, Math.min(200, Number(e.target.value) || 1))
                                setAppSettings({ ...appSettings, max_tool_rounds: v })
                              }}
                              className="w-16 h-8 rounded border border-border bg-muted/30 text-center text-sm font-mono [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                            />
                          </div>
                        </div>
                      </div>

                      <Button
                        onClick={handleSaveSettings}
                        disabled={settingsSaving}
                        className="w-full"
                      >
                        {settingsSaving ? (
                          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        ) : settingsSaved ? (
                          <span>已保存</span>
                        ) : (
                          "保存设置"
                        )}
                      </Button>
                    </div>
                  )}
                </div>
              )}

              {/* ── Tab 6: Plugins ── */}
              {tab === "plugins" && (
                pluginsLoading ? (
                  <div className="flex items-center justify-center py-12">
                    <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                  </div>
                ) : (
                  <div className="p-5 space-y-6">
                    <div className="flex items-center justify-between">
                      <p className="text-xs text-muted-foreground">
                        已发现 {plugins.length} 个插件
                      </p>
                      <div>
                        <input
                          ref={fileInputRef}
                          type="file"
                          accept=".zip"
                          onChange={handleImport}
                          className="hidden"
                        />
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => fileInputRef.current?.click()}
                          disabled={uploading}
                        >
                          {uploading ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <Upload className="h-3 w-3 mr-1" />}
                          导入插件
                        </Button>
                      </div>
                    </div>

                    {previewError && (
                      <div className="flex items-start gap-2 text-xs text-red-600 bg-red-500/5 border border-red-500/20 rounded-md px-3 py-2">
                        <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                        <span>{previewError}</span>
                      </div>
                    )}

                    {preview && (
                      <div className="border rounded-md p-4 space-y-3 bg-card">
                        <div className="flex items-start justify-between">
                          <div>
                            <div className="font-medium flex items-center gap-2">
                              {preview.manifest.name}
                              <span className="text-[10px] text-muted-foreground font-normal">v{preview.manifest.version}</span>
                              {preview.manifest.description && (
                                <span className="text-xs text-muted-foreground font-normal truncate max-w-[220px]">{preview.manifest.description}</span>
                              )}
                            </div>
                            <p className="text-[10px] text-muted-foreground mt-0.5">插件 ID: {preview.manifest.id}</p>
                          </div>
                          <button onClick={() => { setPreview(null); pendingZipRef.current = null }} className="text-muted-foreground hover:text-foreground">
                            <X className="h-4 w-4" />
                          </button>
                        </div>

                        {preview.conflicts.length > 0 && (
                          <div className="text-xs text-red-600 bg-red-500/5 border border-red-500/20 rounded-md px-3 py-2">
                            <div className="font-medium mb-1">以下工具与内置工具冲突，安装将被拒绝：</div>
                            <div className="flex flex-wrap gap-1.5">
                              {preview.conflicts.map((c) => (
                                <span key={c} className="bg-red-500/10 px-1.5 py-0.5 rounded">{c}</span>
                              ))}
                            </div>
                            <div className="mt-1.5">该插件无法安装，请插件作者修改工具名后重试。</div>
                          </div>
                        )}

                        <div className="grid grid-cols-2 gap-3 text-xs">
                          <div>
                            <div className="text-muted-foreground mb-1">权限</div>
                            <div className="flex flex-wrap gap-1.5">
                              {(preview.manifest.permissions.length > 0 ? preview.manifest.permissions : ["（无）"]).map((perm) => (
                                <span key={perm} className="inline-flex items-center gap-1 bg-muted/50 px-1.5 py-0.5 rounded">
                                  <Shield className="h-2.5 w-2.5" />
                                  {permLabels[perm] || perm}
                                </span>
                              ))}
                            </div>
                          </div>
                          <div>
                            <div className="text-muted-foreground mb-1">工具</div>
                            <div className="flex flex-wrap gap-1.5">
                              {(preview.manifest.tools.length > 0 ? preview.manifest.tools.map(t => t.name) : ["（无）"]).map((n) => (
                                <span key={n} className="bg-muted/50 px-1.5 py-0.5 rounded">{n}</span>
                              ))}
                            </div>
                          </div>
                        </div>

                        {preview.network_allowlist.length > 0 && (
                          <div>
                            <div className="text-xs text-muted-foreground mb-1">声明的网络访问白名单</div>
                            <div className="flex flex-wrap gap-1.5">
                              {preview.network_allowlist.map((r, i) => (
                                <span key={i} className="text-[11px] bg-muted/50 px-1.5 py-0.5 rounded font-mono">
                                  {r.scheme}://{r.host}{r.port ? `:${r.port}` : ""}
                                </span>
                              ))}
                            </div>
                          </div>
                        )}

                        <div className="flex justify-end gap-2 pt-1">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => { setPreview(null); pendingZipRef.current = null }}
                          >
                            取消
                          </Button>
                          <Button
                            size="sm"
                            onClick={handleConfirmInstall}
                            disabled={installing || preview.conflicts.length > 0}
                          >
                            {installing ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null}
                            确认安装
                          </Button>
                        </div>
                      </div>
                    )}

                    {plugins.length === 0 ? (
                      <div className="text-center text-muted-foreground py-12">
                        <Puzzle className="h-12 w-12 mx-auto mb-3 opacity-20" />
                        <p className="text-sm">暂无可用插件</p>
                        <p className="text-xs mt-1 opacity-60">将插件放入 {`data/{用户名}/plugins/`} 目录后自动发现，或点击「导入插件」上传 .zip</p>
                      </div>
                    ) : (
                      <div className="space-y-4">
                        {plugins.map((p) => (
                          <div key={p.id} className="rounded-lg border p-4 space-y-3">
                            <div className="flex items-center justify-between">
                              <div>
                                <div className="font-medium flex items-center gap-2">
                                  {p.name}
                                  <span className="text-[10px] text-muted-foreground font-normal">v{p.version}</span>
                                </div>
                                <p className="text-xs text-muted-foreground mt-0.5">{p.description}</p>
                              </div>
                              <div className="flex items-center gap-1 shrink-0">
                                <Button
                                  size="sm"
                                  variant={p.enabled ? "default" : "outline"}
                                  onClick={() => handleToggle(p)}
                                  disabled={toggling.has(p.id)}
                                >
                                  {toggling.has(p.id) ? (
                                    <Loader2 className="h-3 w-3 animate-spin mr-1" />
                                  ) : p.enabled ? (
                                    <PowerOff className="h-3 w-3 mr-1" />
                                  ) : (
                                    <Power className="h-3 w-3 mr-1" />
                                  )}
                                  {p.enabled ? "已启用" : "已禁用"}
                                </Button>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="text-muted-foreground hover:text-red-500"
                                  onClick={() => setDeleteTarget(p)}
                                  title="卸载插件"
                                >
                                  <Trash2 className="h-3 w-3" />
                                </Button>
                              </div>
                            </div>

                            <div className="flex flex-wrap gap-1.5">
                              {p.permissions.map((perm) => (
                                <span key={perm} className="inline-flex items-center gap-1 text-[10px] bg-muted/50 px-1.5 py-0.5 rounded">
                                  <Shield className="h-2.5 w-2.5" />
                                  {permLabels[perm] || perm}
                                </span>
                              ))}
                              <span className="text-[10px] text-muted-foreground ml-1">
                                {p.has_backend ? "· 后端" : ""}{p.has_frontend ? "· 配置面板" : ""}
                              </span>
                            </div>

                            {(p.permissions || []).includes("network") && (
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => netRulesFor?.id === p.id ? closeNetRules() : loadNetRules(p)}
                                className="text-xs"
                              >
                                <Link2 className="h-3 w-3 mr-1" />
                                {netRulesFor?.id === p.id ? "收起网络白名单" : "展开网络白名单"}
                              </Button>
                            )}

                            {netRulesFor?.id === p.id && (
                              <div className="border rounded-md p-3 space-y-3">
                                <div className="flex items-center justify-between">
                                  <span className="text-xs font-medium">网络访问白名单</span>
                                  {netRulesLoading && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
                                </div>

                                {netRuleError && (
                                  <div className="flex items-start gap-2 text-xs text-red-600 bg-red-500/5 border border-red-500/20 rounded-md px-2 py-1.5">
                                    <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                                    <span>{netRuleError}</span>
                                  </div>
                                )}

                                {netRules.length === 0 && !netRulesLoading && (
                                  <p className="text-xs text-muted-foreground">暂无白名单规则，插件无法访问网络。</p>
                                )}

                                <div className="space-y-2">
                                  {netRules.map((rule) => (
                                    <div key={rule.id} className="flex items-center justify-between gap-2 text-xs border rounded-md px-2.5 py-1.5">
                                      <div className="flex items-center gap-2 min-w-0">
                                        <span className="font-mono truncate">
                                          {rule.scheme}://{rule.host}{rule.port ? `:${rule.port}` : ""}
                                        </span>
                                        <span
                                          className={`shrink-0 px-1.5 py-0.5 text-[10px] rounded ${
                                            rule.source === "user"
                                              ? "bg-blue-500/10 text-blue-600"
                                              : rule.enabled
                                                ? "bg-emerald-500/10 text-emerald-600"
                                                : "bg-muted/50 text-muted-foreground"
                                          }`}
                                        >
                                          {rule.source === "user" ? "我的" : "声明"}
                                        </span>
                                      </div>
                                      <div className="flex items-center gap-1 shrink-0">
                                        <button
                                          onClick={() => handleToggleRule(rule)}
                                          className={`px-1.5 py-0.5 rounded text-[10px] ${rule.enabled ? "text-emerald-600" : "text-muted-foreground"}`}
                                          title={rule.enabled ? "点击禁用" : "点击启用"}
                                        >
                                          {rule.enabled ? "启用" : "禁用"}
                                        </button>
                                        {rule.source === "user" && (
                                          <button
                                            onClick={() => handleDeleteRule(rule)}
                                            className="text-red-500 hover:text-red-700 px-1"
                                            title="删除规则"
                                          >
                                            <Trash2 className="h-3 w-3" />
                                          </button>
                                        )}
                                      </div>
                                    </div>
                                  ))}
                                </div>

                                <div className="flex items-center gap-2 pt-1">
                                  <select
                                    value={newRule.scheme}
                                    onChange={(e) => setNewRule({ ...newRule, scheme: e.target.value })}
                                    className="h-8 rounded-md border bg-transparent text-xs px-2"
                                  >
                                    <option value="https">https</option>
                                    <option value="http">http</option>
                                  </select>
                                  <Input
                                    className="h-8 text-xs flex-1"
                                    placeholder="api.example.com 或 127.0.0.1"
                                    value={newRule.host}
                                    onChange={(e) => setNewRule({ ...newRule, host: e.target.value })}
                                  />
                                  <Input
                                    className="h-8 text-xs w-16"
                                    placeholder="端口"
                                    value={newRule.port}
                                    onChange={(e) => setNewRule({ ...newRule, port: e.target.value })}
                                  />
                                  <Button size="sm" variant="outline" className="shrink-0" onClick={handleAddRule}>
                                    添加
                                  </Button>
                                </div>
                              </div>
                            )}

                            {p.enabled && p.has_frontend && (
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => setConfigPlugin(configPlugin?.id === p.id ? null : p)}
                                className="text-xs"
                              >
                                <Puzzle className="h-3 w-3 mr-1" />
                                {configPlugin?.id === p.id ? "收起配置面板" : "展开配置面板"}
                              </Button>
                            )}

                            {configPlugin?.id === p.id && (
                              <div className="border rounded-md">
                                <PluginConfigPanel
                                  pluginId={p.id}
                                  config={p.config || []}
                                  onSaved={() => loadPlugins()}
                                />
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )
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

      <ConfirmDialog
        open={deleteTarget !== null}
        title="卸载插件"
        message={`确定卸载「${deleteTarget?.name}」吗？此操作将删除该插件的所有文件和数据。`}
        variant="destructive"
        confirmText={deleting ? "卸载中..." : "卸载"}
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </>
  )
}
