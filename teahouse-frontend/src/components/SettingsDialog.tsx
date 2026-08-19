import { useEffect, useState, useCallback, useRef } from "react"
import { useTranslation } from "react-i18next"
import {
  Server, Cpu, Sliders, X, ChevronLeft, Check, Loader2, Plus, Pencil, Trash2,
  AlertCircle, Download, Star, FileText, Link2,
  Sun, Moon, SlidersHorizontal, Puzzle, Upload, Power, PowerOff, Shield,
  BookOpen, Package, Users, Languages,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select"
import { useCurrentLang, useLangStore, SUPPORTED_LANGS, LANG_LABELS } from "@/i18n/config"
import { resolvePluginText } from "@/lib/pluginI18n"
import { ConfirmDialog } from "@/components/ConfirmDialog"
import { PluginConfigPanel } from "@/components/PluginConfigPanel"
import { llmProvidersApi, llmModelsApi, modelProfilesApi, llmSlotsApi, directorPromptPresetsApi, appSettingsApi, pluginsApi, skillsApi, packagesApi } from "@/lib/api"
import type { LLMProvider, LLMModel, ModelProfile, SlotBindings, AvailableModel, SlotBinding, DirectorPromptPreset, AppSettings } from "@/lib/types"
import { SlotCard } from "@/components/SlotCard"
import { useThemeStore } from "@/stores/themeStore"
import { useSettingsDialogStore } from "@/stores/settingsDialogStore"
import { useIsMobile } from "@/hooks/useMediaQuery"
import { useDialogBackClose } from "@/hooks/useDialogBackClose"
import { useAuth, isAdminRole } from "@/stores/authStore"
import { UserManagementPanel } from "@/components/UserManagement"
import type { Plugin, PluginPreview, NetworkRule } from "@/lib/pluginTypes"
import type { MySkill, SkillPreview, MyPackage, PackagePreview } from "@/lib/api"

interface SettingsDialogProps {
  open?: boolean
  onClose?: () => void
  defaultTab?: TabKey
}

type TabKey = "models" | "profiles" | "presets" | "slots" | "general" | "plugins" | "skills" | "packages" | "users"

const API_FORMAT_OPTIONS = [
  { value: "openai", label: "openai" },
  { value: "openai_strict", label: "openai_strict" },
  { value: "anthropic", label: "anthropic" },
]

const TAB_ITEMS: { key: TabKey; Icon: typeof Server; label: string; adminOnly?: boolean }[] = [
  { key: "general", Icon: SlidersHorizontal, label: "tab.general" },
  { key: "models", Icon: Server, label: "tab.models" },
  { key: "slots", Icon: Link2, label: "tab.slots" },
  { key: "profiles", Icon: Sliders, label: "tab.profiles" },
  { key: "presets", Icon: FileText, label: "tab.presets" },
  { key: "plugins", Icon: Puzzle, label: "tab.plugins" },
  { key: "skills", Icon: BookOpen, label: "tab.skills" },
  { key: "packages", Icon: Package, label: "tab.packages" },
  { key: "users", Icon: Users, label: "tab.users", adminOnly: true },
]

const permLabels: Record<string, string> = {
  tool: "perm.tool",
  frontend: "perm.frontend",
  network: "perm.network",
  file_read: "perm.file_read",
  file_write: "perm.file_write",
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
  const [tab, setTab] = useState<TabKey>("general")
  const { t } = useTranslation("settings")
  const currentLang = useCurrentLang()
  const setLang = useLangStore((s) => s.setLang)
  const isMobile = useIsMobile()
  useDialogBackClose(open, onClose)
  const [tabMenuOpen, setTabMenuOpen] = useState(false)

  // 「用户管理」tab 仅登录用户是管理员/超级管理员时可见
  const { user: currentUser } = useAuth()
  const visibleTabs = TAB_ITEMS.filter((t) => !t.adminOnly || isAdminRole(currentUser?.role))

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
  const [appSettings, setAppSettings] = useState<AppSettings>({ max_retries: 3, max_tool_rounds: 15, max_parse_depth: 10 })
  const [settingsLoading, setSettingsLoading] = useState(false)

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

  // ─── Skills state (user-level skill library) ───
  const [mySkills, setMySkills] = useState<MySkill[]>([])
  const [skillsLoading, setSkillsLoading] = useState(false)
  const skillFileInputRef = useRef<HTMLInputElement>(null)
  const [skillPreview, setSkillPreview] = useState<SkillPreview | null>(null)
  const [skillPreviewError, setSkillPreviewError] = useState("")
  const [skillUploading, setSkillUploading] = useState(false)
  const [skillInstalling, setSkillInstalling] = useState(false)
  const [skillDeleting, setSkillDeleting] = useState<string | null>(null)
  const [skillDeleteTarget, setSkillDeleteTarget] = useState<string | null>(null)

  // ─── Prompt packages state (user-level package library) ───
  const [myPackages, setMyPackages] = useState<MyPackage[]>([])
  const [packagesLoading, setPackagesLoading] = useState(false)
  const packageFileInputRef = useRef<HTMLInputElement>(null)
  const [packagePreview, setPackagePreview] = useState<PackagePreview | null>(null)
  const [packagePreviewError, setPackagePreviewError] = useState("")
  const [packageUploading, setPackageUploading] = useState(false)
  const [packageInstalling, setPackageInstalling] = useState(false)
  const [packageDeleting, setPackageDeleting] = useState<string | null>(null)
  const [packageDeleteTarget, setPackageDeleteTarget] = useState<string | null>(null)

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
    else setError(pRes.error || t("errLoadProviders"))

    if (mRes.ok) setModels(mRes.data!.models)
    else setError(mRes.error || t("errLoadModels"))

    if (profRes.ok) setProfiles(profRes.data!.profiles)

    if (presRes.ok) setPresets(presRes.data!.presets)

    if (sRes.ok) setSlotBindings(sRes.data!.slots)
    else setError(sRes.error || t("errLoadSlots"))

    setProvidersLoading(false)
    setProfilesLoading(false)
    setPresetsLoading(false)
    setSlotsLoading(false)
  }, [])

  // Set defaultTab when dialog opens
  useEffect(() => {
    if (open) {
      setTab(defaultTab || "general")
      loadAll()
    }
  }, [open, defaultTab, loadAll])

  // Theme readthrough
  const isDark = useThemeStore((s) => s.isDark)
  const setTheme = useThemeStore((s) => s.setTheme)

  // Lazy-load general / plugins / skills on first visit of those tabs
  const settingsLoadedRef = useRef(false)
  const pluginsLoadedRef = useRef(false)
  const skillsLoadedRef = useRef(false)
  const packagesLoadedRef = useRef(false)
  // 通用设置滑块即时生效的 debounce 计时器
  const settingSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
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
    if (tab === "skills" && !skillsLoadedRef.current) {
      skillsLoadedRef.current = true
      loadMySkills()
    }
    if (tab === "packages" && !packagesLoadedRef.current) {
      packagesLoadedRef.current = true
      loadMyPackages()
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
    // 列表里出现的是已激活模型：点星的语义是「取消激活」，即从模型池删除。
    await llmModelsApi.delete(model.id)
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
    for (const modelName of selectedModels) {
      modelProfiles[modelName] = ""
    }
    const res = await llmProvidersApi.importModels(importingFromProvider, modelProfiles)
    if (res.ok) {
      setImportingFromProvider(null)
      setAvailableModels([])
      setSelectedModels(new Set())
      await loadAll()
    } else setError(res.error || t("errImport"))
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
    if (!f.name) { setProfileFormError(t("profile.needName")); return }
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
      else setProfileFormError(res.error || t("errUpdate"))
    } else {
      const res = await modelProfilesApi.create(payload as ModelProfile & { name: string })
      if (res.ok) { setCreateProfileOpen(false); await loadAll() }
      else setProfileFormError(res.error || t("errCreate"))
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

  // 滑块即时生效：本地先更新以保持拖拽手感，随后 debounce 推到后端。
  const setAppSetting = (patch: Partial<AppSettings>) => {
    setAppSettings((prev) => ({ ...prev, ...patch }))
    if (settingSaveTimer.current) clearTimeout(settingSaveTimer.current)
    settingSaveTimer.current = setTimeout(async () => {
      const res = await appSettingsApi.update(patch)
      if (res.ok) setAppSettings(res.data!)
    }, 250)
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
        setPreviewError(res.error || t("errPluginPreview"))
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
        setPreviewError(res.error || t("errInstall"))
      }
    } finally {
      setInstalling(false)
    }
  }

  // ─── Skills handlers ───
  const loadMySkills = async () => {
    setSkillsLoading(true)
    const res = await skillsApi.listMy()
    if (res.ok) setMySkills(res.data!.skills)
    setSkillsLoading(false)
  }

  const handleSkillImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setSkillUploading(true)
    setSkillPreviewError("")
    try {
      const form = new FormData()
      form.append("file", file)
      const res = await skillsApi.preview(form)
      if (res.ok) {
        setSkillPreview(res.data)
      } else {
        setSkillPreviewError(res.error || t("errSkillPreview"))
        setSkillPreview(null)
      }
    } finally {
      setSkillUploading(false)
      if (skillFileInputRef.current) skillFileInputRef.current.value = ""
    }
  }

  const handleSkillConfirmInstall = async () => {
    if (!skillPreview) return
    setSkillInstalling(true)
    try {
      const res = await skillsApi.confirmInstall(skillPreview.preview_id)
      setSkillPreview(null)
      if (res.ok) {
        await loadMySkills()
      } else {
        setSkillPreviewError(res.error || t("errImport"))
      }
    } finally {
      setSkillInstalling(false)
    }
  }

  const handleSkillDelete = async () => {
    if (!skillDeleteTarget) return
    setSkillDeleting(skillDeleteTarget)
    const res = await skillsApi.deleteMy(skillDeleteTarget)
    setSkillDeleting(null)
    setSkillDeleteTarget(null)
    if (res.ok) await loadMySkills()
  }

  // ─── Prompt packages handlers ───
  const loadMyPackages = async () => {
    setPackagesLoading(true)
    const res = await packagesApi.listMy()
    if (res.ok) setMyPackages(res.data!.packages)
    setPackagesLoading(false)
  }

  const handlePackageImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setPackageUploading(true)
    setPackagePreviewError("")
    try {
      const form = new FormData()
      form.append("file", file)
      const res = await packagesApi.preview(form)
      if (res.ok) {
        setPackagePreview(res.data)
      } else {
        setPackagePreviewError(res.error || t("errPackagePreview"))
        setPackagePreview(null)
      }
    } finally {
      setPackageUploading(false)
      if (packageFileInputRef.current) packageFileInputRef.current.value = ""
    }
  }

  const handlePackageConfirmInstall = async () => {
    if (!packagePreview) return
    setPackageInstalling(true)
    try {
      const res = await packagesApi.confirmInstall(packagePreview.preview_id)
      setPackagePreview(null)
      if (res.ok) {
        await loadMyPackages()
      } else {
        setPackagePreviewError(res.error || t("errImport"))
      }
    } finally {
      setPackageInstalling(false)
    }
  }

  const handlePackageDelete = async () => {
    if (!packageDeleteTarget) return
    setPackageDeleting(packageDeleteTarget)
    const res = await packagesApi.deleteMy(packageDeleteTarget)
    setPackageDeleting(null)
    setPackageDeleteTarget(null)
    if (res.ok) await loadMyPackages()
  }

  // ─── Network allowlist handlers ───
  const loadNetRules = async (p: Plugin) => {
    setNetRulesFor(p)
    setNetRulesLoading(true)
    setNetRuleError("")
    const res = await pluginsApi.getNetworkRules(p.id)
    if (res.ok && res.data) setNetRules(res.data.rules)
    else setNetRuleError(res.error || t("errLoadNetRules"))
    setNetRulesLoading(false)
  }

  const closeNetRules = () => {
    setNetRulesFor(null)
    setNetRules([])
  }

  const handleAddRule = async () => {
    if (!netRulesFor) return
    const port = newRule.port.trim() === "" ? null : Number(newRule.port)
    if (!newRule.host.trim()) { setNetRuleError(t("errNetRuleHostEmpty")); return }
    if (newRule.port.trim() !== "" && !(port && port >= 1 && port <= 65535)) {
      setNetRuleError(t("errNetRulePortRange"))
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
      setNetRuleError(res.error || t("errNetRuleAdd"))
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
      setError(res.error || t("errSave"))
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
                aria-label={t("common:back")}
              >
                <ChevronLeft className="h-5 w-5" />
              </button>
              <span className="font-semibold text-sm">{t("title")}</span>
              {/* Right: tab dropdown trigger */}
              <div className="absolute right-1">
                <button
                  className="p-2 rounded hover:bg-muted flex items-center gap-1 text-sm"
                  onClick={() => setTabMenuOpen((v) => !v)}
                  aria-label={t("ariaSwitchTab")}
                >
                  {(() => { const cur = visibleTabs.find((t) => t.key === tab); return cur ? <cur.Icon className="h-4 w-4" /> : null })()}
                </button>
                {tabMenuOpen && (
                  <>
                    <div className="fixed inset-0 z-40" onClick={() => setTabMenuOpen(false)} />
                    <div className="absolute right-1 top-full mt-1 z-50 bg-background border border-border rounded-md shadow-lg py-1 min-w-[150px]">
                      {visibleTabs.map(({ key, Icon, label }) => (
                        <button
                          key={key}
                          className={`w-full flex items-center gap-2 px-3 py-2.5 text-sm text-left hover:bg-muted ${
                            tab === key ? "text-primary font-medium" : "text-foreground"
                          }`}
                          onClick={() => { setTab(key); setTabMenuOpen(false) }}
                        >
                          <Icon className="h-4 w-4 shrink-0" />
                          <span className="flex-1">{t(label)}</span>
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
                <span className="font-semibold">{t("title")}</span>
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
              <button className="underline shrink-0" onClick={() => setError("")}>{t("errorDismiss")}</button>
            </div>
          )}

          {/* Body: sidebar + content */}
          <div className="flex flex-1 overflow-hidden">
            {/* Left sidebar (desktop only; mobile uses the top tab dropdown) */}
            {!isMobile && (
            <div className="w-44 shrink-0 border-r border-border flex flex-col bg-muted/10">
              <div className="flex flex-col gap-0.5 p-2">
                {visibleTabs.map(({ key, Icon, label }) => (
                  <button
                    key={key}
                    className={`flex items-center gap-2 px-3 py-2.5 text-xs rounded-md transition-colors text-left whitespace-nowrap ${
                      tab === key ? "bg-accent text-accent-foreground font-medium" : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
                    }`}
                    onClick={() => setTab(key)}
                  >
                    <Icon className="h-4 w-4 shrink-0" />
                    {t(label)}
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
                    <h3 className="text-sm font-medium text-muted-foreground">{t("tab.models")}</h3>
                    {!showProviderCreate && (
                      <Button size="sm" variant="outline" onClick={openProviderCreate}>
                        <Plus className="h-3.5 w-3.5 mr-1.5" />{t("provider.add")}
                      </Button>
                    )}
                  </div>

                  {/* Inline create form */}
                  {showProviderCreate && (
                    <div className="rounded-lg border border-primary/30 bg-primary/5 p-4">
                      <h4 className="text-sm font-medium mb-3">{t("provider.add")}</h4>
                      <div className="space-y-3">
                        <div className="grid grid-cols-2 gap-3">
                          <Field label={t("provider.nameLabel")}>
                            <Input value={providerCreateForm.name} onChange={e => setProviderCreateForm(f => ({ ...f, name: e.target.value }))} placeholder={t("provider.namePH")} className="text-sm" autoFocus />
                          </Field>
                          <Field label={t("provider.apiFormat")}>
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
                          <Field label={t("provider.apiUrl")} className="col-span-2">
                            <Input value={providerCreateForm.api_url} onChange={e => setProviderCreateForm(f => ({ ...f, api_url: e.target.value }))} placeholder={t("provider.apiUrlPH")} className="text-sm font-mono" />
                          </Field>
                          <Field label={t("provider.apiKey")} className="col-span-2">
                            <Input type="password" value={providerCreateForm.api_key} onChange={e => setProviderCreateForm(f => ({ ...f, api_key: e.target.value }))} placeholder={t("provider.apiKeyPH")} className="text-sm" />
                          </Field>
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

                  {/* Provider list */}
                  {providersLoading ? (
                    <div className="flex items-center justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
                  ) : providers.length === 0 ? (
                    <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">{t("provider.none")}</div>
                  ) : (
                    <div className="space-y-3">
                      {providers.map(p => {
                        const form = getProviderFormFor(p)
                        const saveNeeded = isProviderSaveNeeded(p)
                        const providerModels = getProviderModels(p.id)
                        // 该供应商已激活模型，用于导入面板去重（已激活即以灰色点亮显示、不可再选）
                        const enabledModelNames = new Set(providerModels.filter(mm => mm.is_enabled).map(mm => mm.model_name))

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
                                  title={t("provider.editNameTitle")}
                                >
                                  {p.name}
                                </span>
                              )}
                              <div className="flex items-center gap-1">
                                <Button variant="ghost" size="icon-xs" onClick={() => setDeleteProviderTarget(p.id)} title={t("provider.deleteTitle")}>
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
                              <Field label={t("provider.apiUrl")}>
                                <Input
                                  value={form.api_url}
                                  onChange={e => setProviderFormField(p.id, "api_url", e.target.value)}
                                  placeholder={t("provider.apiUrlPH")}
                                  className="text-sm font-mono"
                                />
                              </Field>
                              <Field label={t("provider.apiKey")}>
                                <Input
                                  type="password"
                                  value={form.api_key}
                                  onChange={e => setProviderFormField(p.id, "api_key", e.target.value)}
                                  placeholder={t("provider.apiKeyPH")}
                                  className="text-sm"
                                />
                              </Field>
                              <Field label={t("provider.modelFetchUrl")}>
                                <Input
                                  value={p.api_url ? form.model_fetch_url : ""}
                                  onChange={e => setProviderFormField(p.id, "model_fetch_url", e.target.value)}
                                  placeholder={t("provider.modelFetchUrlPH")}
                                  className="text-sm font-mono"
                                />
                              </Field>
                            </div>

                            {/* Save button */}
                            {saveNeeded && (
                              <div>
                                <Button size="sm" onClick={() => saveProviderOverrides(p.id)}>{t("provider.saveConfig")}</Button>
                              </div>
                            )}

                            {/* Model list under provider — always visible */}
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

                            {/* Model list footer — prominent import trigger (default style) */}
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

                            {/* Import models sub-panel */}
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
                                          // 全选只针对未导入的可导入模型；已激活的不可再选
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
                </div>
              )}

              {/* ── Tab 2: Model Profiles ── */}
              {tab === "profiles" && (
                <div className="p-5 space-y-4 h-full flex flex-col">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-medium text-muted-foreground">{t("tab.profiles")}</h3>
                    {!createProfileOpen && (
                      <Button size="sm" variant="outline" onClick={openProfileCreate}>
                        <Plus className="h-3.5 w-3.5 mr-1.5" />{t("profile.create")}
                      </Button>
                    )}
                  </div>

                  {/* Create / Edit form */}
                  {createProfileOpen && (
                    <div className="rounded-lg border border-primary/30 bg-primary/5 p-4 shrink-0">
                      <h4 className="text-sm font-medium mb-3">
                        {editingProfile?.is_builtin ? t("profile.viewBuiltin") : editingProfile ? t("profile.edit") : t("profile.create")}
                      </h4>
                      <div className="space-y-3">
                        <div className="grid grid-cols-2 gap-3">
                          <Field label={t("profile.nameLabel")}>
                            <Input value={profileForm.name} onChange={e => setProfileForm(f => ({ ...f, name: e.target.value }))} placeholder={t("profile.namePH")} className="text-sm" disabled={!!editingProfile?.is_builtin} autoFocus />
                          </Field>
                          <Field label={t("profile.matchPattern")}>
                            <Input value={profileForm.match_pattern} onChange={e => setProfileForm(f => ({ ...f, match_pattern: e.target.value }))} placeholder={t("profile.matchPatternPH")} className="text-sm font-mono" disabled={!!editingProfile?.is_builtin} />
                          </Field>
                          <Field label="Temperature">
                            <Input type="number" step="0.1" min="0" max="2" value={profileForm.temperature} onChange={e => setProfileForm(f => ({ ...f, temperature: parseFloat(e.target.value) || 0 }))} className="text-sm" disabled={!!editingProfile?.is_builtin} />
                          </Field>
                          <Field label="Max Tokens">
                            <Input type="number" step="1" min="1" value={profileForm.max_tokens} onChange={e => setProfileForm(f => ({ ...f, max_tokens: parseInt(e.target.value) || 0 }))} className="text-sm" disabled={!!editingProfile?.is_builtin} />
                          </Field>
                          <Field label={t("profile.maxContext70")}>
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
                              {editingProfile ? t("profile.save") : t("profile.create")}
                            </Button>
                          )}
                          <Button size="sm" variant="outline" onClick={() => { setCreateProfileOpen(false); setEditingProfile(null); setProfileFormError("") }}>
                            {editingProfile?.is_builtin ? t("common:close") : t("common:cancel")}
                          </Button>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Profile list */}
                  {profilesLoading ? (
                    <div className="flex items-center justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
                  ) : profiles.length === 0 ? (
                    <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">{t("profile.none")}</div>
                  ) : (
                    <div className="space-y-2 overflow-auto flex-1">
                      {/* Built-in profiles */}
                      {profiles.filter(p => p.is_builtin).map(p => (
                        <div key={p.id} className="rounded-lg border border-border bg-muted/20 p-4 flex items-start justify-between opacity-70">
                          <div className="space-y-1 flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-medium">{p.name}</span>
                              <span className="text-[10px] bg-muted px-1.5 py-0.5 rounded">{t("profile.builtIn")}</span>
                            </div>
                            <div className="text-xs text-muted-foreground">{t("profile.builtInView")}</div>
                          </div>
                          <Button variant="ghost" size="icon-xs" onClick={() => openProfileEdit(p)} title={t("profile.viewTitle")}>
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
                            <Button variant="ghost" size="icon-xs" onClick={() => openProfileEdit(p)} title={t("profile.editTitle")}>
                              <Pencil className="h-3.5 w-3.5" />
                            </Button>
                            <Button variant="ghost" size="icon-xs" onClick={() => setDeleteProfileTarget(p.id)} title={t("profile.deleteTitle")}>
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
                    <h3 className="text-sm font-medium text-muted-foreground">{t("tab.presets")}</h3>
                    {!createPresetOpen && (
                      <Button size="sm" variant="outline" onClick={openPresetCreate}>
                        <Plus className="h-3.5 w-3.5 mr-1.5" />{t("preset.create")}
                      </Button>
                    )}
                  </div>

                  {/* Create / Edit form */}
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

                  {/* Preset list */}
                  {presetsLoading ? (
                    <div className="flex items-center justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
                  ) : presets.length === 0 ? (
                    <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">{t("preset.none")}</div>
                  ) : (
                    <div className="space-y-2 overflow-auto flex-1">
                      {/* Built-in presets first */}
                      {presets.filter(p => p.is_builtin).map(p => (
                        <div key={p.id} className="rounded-lg border border-border bg-muted/20 p-4 flex items-start justify-between opacity-70">
                          <div className="space-y-1 flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-medium">{p.name}</span>
                              <span className="text-[10px] bg-muted px-1.5 py-0.5 rounded">{t("preset.builtIn")}</span>
                            </div>
                            <div className="text-xs text-muted-foreground">{t("preset.builtInView")}</div>
                          </div>
                          <Button variant="ghost" size="icon-xs" onClick={() => openPresetEdit(p)} title={t("preset.viewTitle")}>
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
                </div>
              )}

              {/* ── Tab 4: Slot Assignment ── */}
              {tab === "slots" && (
                <div className="p-5 h-full flex flex-col">
                  <h3 className="text-sm font-medium text-muted-foreground mb-4">{t("tab.slots")}</h3>
                  {slotsLoading ? (
                    <div className="flex items-center justify-center flex-1"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
                  ) : (
                    <div className="flex flex-col gap-4 flex-1 overflow-y-auto">
                      <SlotCard
                        slotId="director"
                        label={t("slot.director")}
                        binding={slotBindings.director}
                        models={models}
                        profiles={profiles}
                        presets={presets}
                        onChange={handleSlotChange("director")}
                      />
                      <SlotCard
                        slotId="writer"
                        label={t("slot.writer")}
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
                        <div className="text-sm font-medium">{t("general.appearance")}</div>
                        <p className="text-xs text-muted-foreground mt-1">
                          {t("general.appearanceDesc")}
                        </p>
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setTheme(!isDark)}
                        className="gap-1.5"
                      >
                        {isDark ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
                        {isDark ? t("general.switchLight") : t("general.switchDark")}
                      </Button>
                    </div>
                  </div>

                  <div className="rounded-lg border p-4">
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="text-sm font-medium flex items-center gap-1.5">
                          <Languages className="h-3.5 w-3.5" />
                          {t("general.language")}
                        </div>
                        <p className="text-xs text-muted-foreground mt-1">
                          {t("general.languageDesc")}
                        </p>
                      </div>
                      <Select value={currentLang} onValueChange={(v) => setLang(v as typeof currentLang)}>
                        <SelectTrigger className="w-36 h-8">
                          <SelectValue>{LANG_LABELS[currentLang]}</SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          {SUPPORTED_LANGS.map((l) => (
                            <SelectItem key={l} value={l}>
                              {LANG_LABELS[l]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
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
                            <span>{t("general.maxRetries")}</span>
                            <span className="text-muted-foreground font-mono text-xs bg-muted px-2 py-0.5 rounded">
                              {appSettings.max_retries}
                            </span>
                          </label>
                          <p className="text-xs text-muted-foreground mt-1">
                            {t("general.maxRetriesDesc")}
                          </p>
                          <div className="mt-3 flex items-center gap-3">
                            <input
                              type="range"
                              min={0}
                              max={10}
                              value={appSettings.max_retries}
                              onChange={(e) => setAppSetting({ max_retries: Number(e.target.value) })}
                              className="flex-1 h-2 rounded-full appearance-none bg-muted cursor-pointer accent-primary"
                            />
                            <input
                              type="number"
                              min={0}
                              max={10}
                              value={appSettings.max_retries}
                              onChange={(e) => {
                                const v = Math.max(0, Math.min(10, Number(e.target.value) || 0))
                                setAppSetting({ max_retries: v })
                              }}
                              className="w-16 h-8 rounded border border-border bg-muted/30 text-center text-sm font-mono [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                            />
                          </div>
                        </div>
                      </div>

                      <div className="rounded-lg border p-4 space-y-4">
                        <div>
                          <label className="text-sm font-medium flex items-center justify-between">
                            <span>{t("general.maxToolRounds")}</span>
                            <span className="text-muted-foreground font-mono text-xs bg-muted px-2 py-0.5 rounded">
                              {appSettings.max_tool_rounds}
                            </span>
                          </label>
                          <p className="text-xs text-muted-foreground mt-1">
                            {t("general.maxToolRoundsDesc")}
                          </p>
                          <div className="mt-3 flex items-center gap-3">
                            <input
                              type="range"
                              min={1}
                              max={200}
                              value={appSettings.max_tool_rounds}
                              onChange={(e) => setAppSetting({ max_tool_rounds: Number(e.target.value) })}
                              className="flex-1 h-2 rounded-full appearance-none bg-muted cursor-pointer accent-primary"
                            />
                            <input
                              type="number"
                              min={1}
                              max={200}
                              value={appSettings.max_tool_rounds}
                              onChange={(e) => {
                                const v = Math.max(1, Math.min(200, Number(e.target.value) || 1))
                                setAppSetting({ max_tool_rounds: v })
                              }}
                              className="w-16 h-8 rounded border border-border bg-muted/30 text-center text-sm font-mono [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                            />
                          </div>
                        </div>
                      </div>

                      <div className="rounded-lg border p-4 space-y-4">
                        <div>
                          <label className="text-sm font-medium flex items-center justify-between">
                            <span>{t("general.maxParseDepth")}</span>
                            <span className="text-muted-foreground font-mono text-xs bg-muted px-2 py-0.5 rounded">
                              {appSettings.max_parse_depth}
                            </span>
                          </label>
                          <p className="text-xs text-muted-foreground mt-1">
                            {t("general.maxParseDepthDesc")}
                          </p>
                          <div className="mt-3 flex items-center gap-3">
                            <input
                              type="range"
                              min={0}
                              max={30}
                              value={appSettings.max_parse_depth}
                              onChange={(e) => setAppSetting({ max_parse_depth: Number(e.target.value) })}
                              className="flex-1 h-2 rounded-full appearance-none bg-muted cursor-pointer accent-primary"
                            />
                            <input
                              type="number"
                              min={0}
                              max={30}
                              value={appSettings.max_parse_depth}
                              onChange={(e) => {
                                const v = Math.max(0, Math.min(30, Number(e.target.value) || 0))
                                setAppSetting({ max_parse_depth: v })
                              }}
                              className="w-16 h-8 rounded border border-border bg-muted/30 text-center text-sm font-mono [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                            />
                          </div>
                        </div>
                      </div>
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
                        {t("plugin.foundCount", { n: plugins.length })}
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
                          {t("plugin.import")}
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
                              {resolvePluginText(preview.manifest.name, preview.manifest.i18n, currentLang)}
                              <span className="text-[10px] text-muted-foreground font-normal">v{preview.manifest.version}</span>
                              {preview.manifest.description && (
                                <span className="text-xs text-muted-foreground font-normal truncate max-w-[220px]">{resolvePluginText(preview.manifest.description, preview.manifest.i18n, currentLang)}</span>
                              )}
                            </div>
                            <p className="text-[10px] text-muted-foreground mt-0.5">{t("plugin.pluginId", { id: preview.manifest.id })}</p>
                          </div>
                          <button onClick={() => { setPreview(null); pendingZipRef.current = null }} className="text-muted-foreground hover:text-foreground">
                            <X className="h-4 w-4" />
                          </button>
                        </div>

                        {preview.conflicts.length > 0 && (
                          <div className="text-xs text-red-600 bg-red-500/5 border border-red-500/20 rounded-md px-3 py-2">
                            <div className="font-medium mb-1">{t("plugin.conflictTitle")}</div>
                            <div className="flex flex-wrap gap-1.5">
                              {preview.conflicts.map((c) => (
                                <span key={c} className="bg-red-500/10 px-1.5 py-0.5 rounded">{c}</span>
                              ))}
                            </div>
                            <div className="mt-1.5">{t("plugin.conflictCantInstall")}</div>
                          </div>
                        )}

                        <div className="grid grid-cols-2 gap-3 text-xs">
                          <div>
                            <div className="text-muted-foreground mb-1">{t("plugin.permission")}</div>
                            <div className="flex flex-wrap gap-1.5">
                              {(preview.manifest.permissions.length > 0 ? preview.manifest.permissions : [t("plugin.none")]).map((perm) => (
                                <span key={perm} className="inline-flex items-center gap-1 bg-muted/50 px-1.5 py-0.5 rounded">
                                  <Shield className="h-2.5 w-2.5" />
                                  {permLabels[perm] ? t(permLabels[perm]) : perm}
                                </span>
                              ))}
                            </div>
                          </div>
                          <div>
                            <div className="text-muted-foreground mb-1">{t("plugin.tools")}</div>
                            <div className="flex flex-wrap gap-1.5">
                              {(preview.manifest.tools.length > 0 ? preview.manifest.tools.map(t => t.name) : [t("plugin.none")]).map((n) => (
                                <span key={n} className="bg-muted/50 px-1.5 py-0.5 rounded">{n}</span>
                              ))}
                            </div>
                          </div>
                        </div>

                        {preview.network_allowlist.length > 0 && (
                          <div>
                            <div className="text-xs text-muted-foreground mb-1">{t("plugin.netAllowlist")}</div>
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
                            {t("common:cancel")}
                          </Button>
                          <Button
                            size="sm"
                            onClick={handleConfirmInstall}
                            disabled={installing || preview.conflicts.length > 0}
                          >
                            {installing ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null}
                            {t("plugin.confirmInstall")}
                          </Button>
                        </div>
                      </div>
                    )}

                    {plugins.length === 0 ? (
                      <div className="text-center text-muted-foreground py-12">
                        <Puzzle className="h-12 w-12 mx-auto mb-3 opacity-20" />
                        <p className="text-sm">{t("plugin.noPlugins")}</p>
                        <p className="text-xs mt-1 opacity-60">{t("plugin.emptyHint", { dir: `data/{用户名}/plugins/` })}</p>
                      </div>
                    ) : (
                      <div className="space-y-4">
                        {plugins.map((p) => (
                          <div key={p.id} className="rounded-lg border p-4 space-y-3">
                            <div className="flex items-center justify-between">
                              <div>
                                <div className="font-medium flex items-center gap-2">
                                  {resolvePluginText(p.name, p.i18n, currentLang)}
                                  <span className="text-[10px] text-muted-foreground font-normal">v{p.version}</span>
                                </div>
                                <p className="text-xs text-muted-foreground mt-0.5">{resolvePluginText(p.description, p.i18n, currentLang)}</p>
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
                                  {p.enabled ? t("plugin.enabled") : t("plugin.disabled")}
                                </Button>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="text-muted-foreground hover:text-red-500"
                                  onClick={() => setDeleteTarget(p)}
                                  title={t("plugin.uninstallTitle")}
                                >
                                  <Trash2 className="h-3 w-3" />
                                </Button>
                              </div>
                            </div>

                            <div className="flex flex-wrap gap-1.5">
                              {p.permissions.map((perm) => (
                                <span key={perm} className="inline-flex items-center gap-1 text-[10px] bg-muted/50 px-1.5 py-0.5 rounded">
                                  <Shield className="h-2.5 w-2.5" />
                                  {permLabels[perm] ? t(permLabels[perm]) : perm}
                                </span>
                              ))}
                              <span className="text-[10px] text-muted-foreground ml-1">
                                {p.has_backend ? t("plugin.hasBackend") : ""}{p.has_frontend ? t("plugin.hasFrontend") : ""}
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
                                {netRulesFor?.id === p.id ? t("plugin.collapseNet") : t("plugin.expandNet")}
                              </Button>
                            )}

                            {netRulesFor?.id === p.id && (
                              <div className="border rounded-md p-3 space-y-3">
                                <div className="flex items-center justify-between">
                                  <span className="text-xs font-medium">{t("plugin.netPanelTitle")}</span>
                                  {netRulesLoading && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
                                </div>

                                {netRuleError && (
                                  <div className="flex items-start gap-2 text-xs text-red-600 bg-red-500/5 border border-red-500/20 rounded-md px-2 py-1.5">
                                    <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                                    <span>{netRuleError}</span>
                                  </div>
                                )}

                                {netRules.length === 0 && !netRulesLoading && (
                                  <p className="text-xs text-muted-foreground">{t("plugin.noNetRules")}</p>
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
                                          {rule.source === "user" ? t("plugin.ruleMine") : t("plugin.ruleDeclared")}
                                        </span>
                                      </div>
                                      <div className="flex items-center gap-1 shrink-0">
                                        <button
                                          onClick={() => handleToggleRule(rule)}
                                          className={`px-1.5 py-0.5 rounded text-[10px] ${rule.enabled ? "text-emerald-600" : "text-muted-foreground"}`}
                                          title={rule.enabled ? t("plugin.ruleDisableTitle") : t("plugin.ruleEnableTitle")}
                                        >
                                          {rule.enabled ? t("plugin.ruleEnabled") : t("plugin.ruleDisabled")}
                                        </button>
                                        {rule.source === "user" && (
                                          <button
                                            onClick={() => handleDeleteRule(rule)}
                                            className="text-red-500 hover:text-red-700 px-1"
                                            title={t("plugin.deleteRuleTitle")}
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
                                    placeholder={t("plugin.hostPH")}
                                    value={newRule.host}
                                    onChange={(e) => setNewRule({ ...newRule, host: e.target.value })}
                                  />
                                  <Input
                                    className="h-8 text-xs w-16"
                                    placeholder={t("plugin.portPH")}
                                    value={newRule.port}
                                    onChange={(e) => setNewRule({ ...newRule, port: e.target.value })}
                                  />
                                  <Button size="sm" variant="outline" className="shrink-0" onClick={handleAddRule}>
                                    {t("plugin.add")}
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
                                {configPlugin?.id === p.id ? t("plugin.collapseConfig") : t("plugin.expandConfig")}
                              </Button>
                            )}

                            {configPlugin?.id === p.id && (
                              <div className="border rounded-md">
                                <PluginConfigPanel
                                  pluginId={p.id}
                                  config={p.config || []}
                                  i18n={p.i18n}
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

              {/* ── Tab 7: Skills (user-level library) ── */}
              {tab === "skills" && (
                skillsLoading ? (
                  <div className="flex items-center justify-center py-12">
                    <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                  </div>
                ) : (
                  <div className="p-5 space-y-6">
                    <div className="flex items-center justify-between">
                      <p className="text-xs text-muted-foreground">
                        {t("skill.count", { n: mySkills.length })}
                      </p>
                      <div>
                        <input
                          ref={skillFileInputRef}
                          type="file"
                          accept=".zip"
                          onChange={handleSkillImport}
                          className="hidden"
                        />
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => skillFileInputRef.current?.click()}
                          disabled={skillUploading}
                        >
                          {skillUploading ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <Upload className="h-3 w-3 mr-1" />}
                          {t("skill.import")}
                        </Button>
                      </div>
                    </div>

                    {skillPreviewError && (
                      <div className="flex items-start gap-2 text-xs text-red-600 bg-red-500/5 border border-red-500/20 rounded-md px-3 py-2">
                        <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                        <span>{skillPreviewError}</span>
                      </div>
                    )}

                    {skillPreview && (
                      <div className="border rounded-md p-4 space-y-3 bg-card">
                        <div className="flex items-start justify-between">
                          <div>
                            <div className="font-medium">{t("skill.importHeading", { name: skillPreview.name })}</div>
                            <p className="text-[11px] text-muted-foreground mt-0.5">
                              {t("skill.fileCount", { n: skillPreview.preview.file_count })}
                            </p>
                          </div>
                          <button onClick={() => setSkillPreview(null)} className="text-muted-foreground hover:text-foreground">
                            <X className="h-4 w-4" />
                          </button>
                        </div>
                        <div className="flex justify-end gap-2 pt-1">
                          <Button size="sm" variant="outline" onClick={() => setSkillPreview(null)}>{t("common:cancel")}</Button>
                          <Button size="sm" onClick={handleSkillConfirmInstall} disabled={skillInstalling}>
                            {skillInstalling ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null}
                            {t("skill.confirmImport")}
                          </Button>
                        </div>
                      </div>
                    )}

                    {mySkills.length === 0 ? (
                      <div className="text-center text-muted-foreground py-12">
                        <BookOpen className="h-12 w-12 mx-auto mb-3 opacity-20" />
                        <p className="text-sm">{t("skill.emptyTitle")}</p>
                        <p className="text-xs mt-1 opacity-60">
                          {t("skill.emptyHint")}
                        </p>
                      </div>
                    ) : (
                      <div className="space-y-4">
                        {mySkills.map((s) => (
                          <div key={s.name} className="rounded-lg border p-4 space-y-2">
                            <div className="flex items-center justify-between">
                              <div>
                                <div className="font-medium flex items-center gap-2">
                                  <BookOpen className="h-4 w-4 text-muted-foreground" />
                                  {s.name}
                                </div>
                                <p className="text-[11px] text-muted-foreground mt-1">
                                  {s.has_skill ? t("skill.filesCount", { n: s.file_count }) : t("skill.missingSkillMd")}
                                  {s.size ? ` · ${(s.size / 1024).toFixed(1)} KB` : ""}
                                </p>
                              </div>
                              <div className="flex items-center gap-1 shrink-0">
                                <Button size="sm" variant="outline" onClick={() => window.open(skillsApi.downloadUrl(s.name), "_blank")}>
                                  <Download className="h-3 w-3 mr-1" />
                                  {t("skill.download")}
                                </Button>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="text-red-500 hover:text-red-500"
                                  onClick={() => setSkillDeleteTarget(s.name)}
                                  disabled={skillDeleting === s.name}
                                >
                                  <Trash2 className="h-3 w-3 mr-1" />
                                  {t("skill.delete")}
                                </Button>
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}

                    <div className="text-[11px] text-muted-foreground pt-2 border-t border-border">
                      {t("skill.hint")}
                    </div>
                  </div>
                )
              )}

              {tab === "packages" && (
                packagesLoading ? (
                  <div className="flex items-center justify-center py-12">
                    <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                  </div>
                ) : (
                  <div className="p-5 space-y-6">
                    <div className="flex items-center justify-between">
                      <p className="text-xs text-muted-foreground">
                        {t("pkg.count", { n: myPackages.length })}
                      </p>
                      <div>
                        <input
                          ref={packageFileInputRef}
                          type="file"
                          accept=".zip"
                          onChange={handlePackageImport}
                          className="hidden"
                        />
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => packageFileInputRef.current?.click()}
                          disabled={packageUploading}
                        >
                          {packageUploading ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <Upload className="h-3 w-3 mr-1" />}
                          {t("pkg.import")}
                        </Button>
                      </div>
                    </div>

                    {packagePreviewError && (
                      <div className="flex items-start gap-2 text-xs text-red-600 bg-red-500/5 border border-red-500/20 rounded-md px-3 py-2">
                        <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                        <span>{packagePreviewError}</span>
                      </div>
                    )}

                    {packagePreview && (
                      <div className="border rounded-md p-4 space-y-3 bg-card">
                        <div className="flex items-start justify-between">
                          <div>
                            <div className="font-medium">{t("pkg.importHeading", { name: packagePreview.name })}</div>
                            <p className="text-[11px] text-muted-foreground mt-0.5">
                              {t("pkg.fileCount", { n: packagePreview.preview.file_count })}
                            </p>
                          </div>
                          <button onClick={() => setPackagePreview(null)} className="text-muted-foreground hover:text-foreground">
                            <X className="h-4 w-4" />
                          </button>
                        </div>
                        <div className="flex justify-end gap-2 pt-1">
                          <Button size="sm" variant="outline" onClick={() => setPackagePreview(null)}>{t("common:cancel")}</Button>
                          <Button size="sm" onClick={handlePackageConfirmInstall} disabled={packageInstalling}>
                            {packageInstalling ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null}
                            {t("pkg.confirmImport")}
                          </Button>
                        </div>
                      </div>
                    )}

                    {myPackages.length === 0 ? (
                      <div className="text-center text-muted-foreground py-12">
                        <Package className="h-12 w-12 mx-auto mb-3 opacity-20" />
                        <p className="text-sm">{t("pkg.emptyTitle")}</p>
                        <p className="text-xs mt-1 opacity-60">
                          {t("pkg.emptyHint")}
                        </p>
                      </div>
                    ) : (
                      <div className="space-y-4">
                        {myPackages.map((p) => (
                          <div key={p.name} className="rounded-lg border p-4 space-y-2">
                            <div className="flex items-center justify-between">
                              <div>
                                <div className="font-medium flex items-center gap-2">
                                  <Package className="h-4 w-4 text-muted-foreground" />
                                  {p.name}
                                </div>
                                <p className="text-[11px] text-muted-foreground mt-1">
                                  {t("pkg.filesCount", { n: p.file_count })}
                                  {p.has_readme ? t("pkg.hasReadme") : t("pkg.noReadme")}
                                  {p.size ? ` · ${(p.size / 1024).toFixed(1)} KB` : ""}
                                </p>
                              </div>
                              <div className="flex items-center gap-1 shrink-0">
                                <Button size="sm" variant="outline" onClick={() => window.open(packagesApi.downloadUrl(p.name), "_blank")}>
                                  <Download className="h-3 w-3 mr-1" />
                                  {t("pkg.download")}
                                </Button>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="text-red-500 hover:text-red-500"
                                  onClick={() => setPackageDeleteTarget(p.name)}
                                  disabled={packageDeleting === p.name}
                                >
                                  <Trash2 className="h-3 w-3 mr-1" />
                                  {t("pkg.delete")}
                                </Button>
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}

                    <div className="text-[11px] text-muted-foreground pt-2 border-t border-border">
                      {t("pkg.hint")}
                    </div>
                  </div>
                )
              )}

              {/* ── Tab 9: User Management (admin/super only) ── */}
              {tab === "users" && (
                <div className="p-5 space-y-4">
                  <UserManagementPanel />
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Delete confirmations */}
      <ConfirmDialog
        open={deleteProviderTarget !== null}
        title={t("del.providerTitle")}
        message={t("del.providerMessage")}
        variant="destructive"
        confirmText={t("common:delete")}
        onConfirm={deleteProvider}
        onCancel={() => setDeleteProviderTarget(null)}
      />

      <ConfirmDialog
        open={deleteProfileTarget !== null}
        title={t("del.profileTitle")}
        message={t("del.profileMessage")}
        variant="destructive"
        confirmText={t("common:delete")}
        onConfirm={deleteProfile}
        onCancel={() => setDeleteProfileTarget(null)}
      />

      <ConfirmDialog
        open={deletePresetTarget !== null}
        title={t("del.presetTitle")}
        message={t("del.presetMessage")}
        variant="destructive"
        confirmText={t("common:delete")}
        onConfirm={deletePreset}
        onCancel={() => setDeletePresetTarget(null)}
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        title={t("del.pluginTitle")}
        message={t("del.pluginMessage", { name: resolvePluginText(deleteTarget?.name, deleteTarget?.i18n, currentLang) })}
        variant="destructive"
        confirmText={deleting ? t("del.uninstalling") : t("common:delete")}
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />

      <ConfirmDialog
        open={skillDeleteTarget !== null}
        title={t("del.skillTitle")}
        message={t("del.skillMessage", { name: skillDeleteTarget })}
        variant="destructive"
        confirmText={skillDeleting ? t("del.deleting") : t("common:delete")}
        onConfirm={handleSkillDelete}
        onCancel={() => setSkillDeleteTarget(null)}
      />

      <ConfirmDialog
        open={packageDeleteTarget !== null}
        title={t("del.pkgTitle")}
        message={t("del.pkgMessage", { name: packageDeleteTarget })}
        variant="destructive"
        confirmText={packageDeleting ? t("del.deleting") : t("common:delete")}
        onConfirm={handlePackageDelete}
        onCancel={() => setPackageDeleteTarget(null)}
      />
    </>
  )
}
