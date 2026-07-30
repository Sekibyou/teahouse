import { useEffect, useState, useRef } from "react"
import { ArrowLeft, Loader2, Settings2, Star, Cpu, Puzzle, Power, PowerOff, Trash2, Upload, Shield, SlidersHorizontal } from "lucide-react"
import { useNavigate } from "react-router-dom"
import { Button } from "@/components/ui/button"
import { LLMManagementDialog } from "@/components/LLMManagementDialog"
import { ConfirmDialog } from "@/components/ConfirmDialog"
import { PluginPanel } from "@/components/PluginPanel"
import { llmSlotsApi, llmModelsApi, llmProvidersApi, appSettingsApi, pluginsApi } from "@/lib/api"
import type { SlotBindings, LLMModel, LLMProvider, AppSettings } from "@/lib/types"
import type { Plugin } from "@/lib/pluginTypes"

type TabId = "llm" | "general" | "plugins"

const TABS: { id: TabId; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { id: "llm", label: "LLM 模型", icon: Cpu },
  { id: "general", label: "通用设置", icon: SlidersHorizontal },
  { id: "plugins", label: "插件管理", icon: Puzzle },
]

export function SettingsPage() {
  const navigate = useNavigate()
  const [activeTab, setActiveTab] = useState<TabId>("llm")
  const [dialogOpen, setDialogOpen] = useState(false)
  const [slots, setSlots] = useState<SlotBindings>({ director: null, writer: null })
  const [models, setModels] = useState<LLMModel[]>([])
  const [providers, setProviders] = useState<LLMProvider[]>([])
  const [loading, setLoading] = useState(true)

  // General settings
  const [appSettings, setAppSettings] = useState<AppSettings>({ max_retries: 3 })
  const [settingsLoading, setSettingsLoading] = useState(true)
  const [settingsSaving, setSettingsSaving] = useState(false)
  const [settingsSaved, setSettingsSaved] = useState(false)

  // Plugins
  const [plugins, setPlugins] = useState<Plugin[]>([])
  const [pluginsLoading, setPluginsLoading] = useState(true)
  const [toggling, setToggling] = useState<Set<string>>(new Set())
  const [configPlugin, setConfigPlugin] = useState<Plugin | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Plugin | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [uploading, setUploading] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // -- LLM state --
  const loadLLMState = async () => {
    setLoading(true)
    const [sRes, mRes, pRes] = await Promise.all([
      llmSlotsApi.getAll(),
      llmModelsApi.listEnabled ? llmModelsApi.listEnabled() : llmModelsApi.list(),
      llmProvidersApi.list(),
    ])
    if (sRes.ok) setSlots(sRes.data!.slots)
    if (mRes.ok) setModels(mRes.data!.models)
    if (pRes.ok) setProviders(pRes.data!.providers)
    setLoading(false)
  }

  // -- General settings state --
  const loadSettings = async () => {
    setSettingsLoading(true)
    const res = await appSettingsApi.get()
    if (res.ok) setAppSettings(res.data!)
    setSettingsLoading(false)
  }

  // -- Plugin state --
  const loadPlugins = async () => {
    setPluginsLoading(true)
    const res = await pluginsApi.list()
    if (res.ok) setPlugins(res.data!.plugins)
    setPluginsLoading(false)
  }

  useEffect(() => { loadLLMState() }, [])
  useEffect(() => { if (!dialogOpen) loadLLMState() }, [dialogOpen])

  // Load tab content on first view
  useEffect(() => {
    if (activeTab === "general" && settingsLoading && appSettings.max_retries === 3) loadSettings()
    if (activeTab === "plugins" && pluginsLoading && plugins.length === 0) loadPlugins()
  }, [activeTab])

  const handleSaveSettings = async () => {
    setSettingsSaving(true)
    setSettingsSaved(false)
    const res = await appSettingsApi.update({ max_retries: appSettings.max_retries })
    if (res.ok) {
      setAppSettings(res.data!)
      setSettingsSaved(true)
      setTimeout(() => setSettingsSaved(false), 2000)
    }
    setSettingsSaving(false)
  }

  // -- Plugin handlers --
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
    const form = new FormData()
    form.append("file", file)
    await pluginsApi.importZip(form)
    setUploading(false)
    await loadPlugins()
    if (fileInputRef.current) fileInputRef.current.value = ""
  }

  // -- Helpers --
  const getModelInfo = (modelId: string | null): LLMModel | null =>
    modelId ? models.find(m => m.id === modelId) || null : null

  const getProviderInfo = (providerId: string | undefined): LLMProvider | null =>
    providerId ? providers.find(p => p.id === providerId) || null : null

  const SlotCard = ({ slotId, label, desc }: { slotId: "director" | "writer"; label: string; desc: string }) => {
    const model = getModelInfo(slots[slotId])
    const provider = getProviderInfo(model?.provider_id)

    return (
      <div className="rounded-lg border p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Star className="h-4 w-4 text-primary" />
          <span className="font-medium">{label}</span>
        </div>
        <p className="text-xs text-muted-foreground">{desc}</p>
        {model ? (
          <div className="text-xs space-y-1 bg-muted/30 rounded p-2.5">
            <div className="font-medium">{model.name}</div>
            <div className="text-muted-foreground font-mono">{model.model_name}</div>
            {provider && <div className="text-muted-foreground">{provider.name} · {provider.api_format}</div>}
          </div>
        ) : (
          <div className="text-xs text-yellow-500 bg-yellow-500/5 rounded p-2.5 border border-yellow-500/20">
            未绑定模型
          </div>
        )}
      </div>
    )
  }

  const permLabels: Record<string, string> = {
    tool: "导演工具",
    frontend: "前端面板",
    network: "网络请求",
    file_read: "读取文件",
    file_write: "写入文件",
  }

  return (
    <div className="h-full flex flex-col max-w-2xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-border shrink-0">
        <div className="flex items-center gap-3">
          <button
            className="p-1 rounded hover:bg-muted"
            onClick={() => navigate(-1)}
            title="返回"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <h2 className="text-lg font-semibold">通用配置</h2>
        </div>
      </div>

      {/* Tab bar */}
      <div className="flex border-b border-border shrink-0 px-6">
        {TABS.map((tab) => {
          const Icon = tab.icon
          const isActive = activeTab === tab.id
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-1.5 px-4 py-2.5 text-sm border-b-2 transition-colors -mb-px ${
                isActive
                  ? "border-primary text-primary font-medium"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              <Icon className="h-3.5 w-3.5" />
              {tab.label}
            </button>
          )
        })}
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-auto p-6">
        {/* LLM Tab */}
        {activeTab === "llm" && (
          loading ? (
            <div className="flex-1 flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <div className="space-y-6">
              <div className="space-y-3">
                <h3 className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                  <Star className="h-3.5 w-3.5" />
                  模型槽位
                </h3>
                <SlotCard
                  slotId="director"
                  label="导演模型"
                  desc="导演编排 / 总结 / 设定探索。建议选用主流且实惠的模型，需要好的指令遵循能力。"
                />
                <SlotCard
                  slotId="writer"
                  label="正文模型"
                  desc="正文写作 / 修改。建议使用最好的模型，需要最佳创意品质。"
                />
              </div>

              <div className="flex gap-3 text-xs text-muted-foreground">
                <span className="flex items-center gap-1">
                  <Settings2 className="h-3 w-3" />
                  {providers.length} 供应商
                </span>
                <span className="flex items-center gap-1">
                  <Cpu className="h-3 w-3" />
                  {models.length} 模型（{models.filter(m => m.is_enabled).length} 启用）
                </span>
              </div>

              <Button
                onClick={() => setDialogOpen(true)}
                className="w-full"
                variant="outline"
              >
                <Settings2 className="h-4 w-4 mr-2" />
                打开模型管理
              </Button>

              <div className="text-xs text-muted-foreground space-y-1 bg-muted/20 rounded-lg p-3">
                <p>默认的 LLM 配置管理采用三层模型系统：</p>
                <ol className="list-decimal pl-4 space-y-0.5">
                  <li><strong>供应商</strong> — 管理 API 端点和密钥</li>
                  <li><strong>模型池</strong> — 从供应商导入/手动添加模型，配置参数</li>
                  <li><strong>槽位指定</strong> — 为两大槽位（导演/正文）选定模型</li>
                </ol>
              </div>
            </div>
          )
        )}

        {/* General Settings Tab */}
        {activeTab === "general" && (
          settingsLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <div className="space-y-6">
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
          )
        )}

        {/* Plugins Tab */}
        {activeTab === "plugins" && (
          pluginsLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <div className="space-y-6">
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
                          {p.has_backend ? "· 后端" : ""}{p.has_frontend ? "· 前端" : ""}
                        </span>
                      </div>

                      {p.enabled && p.has_frontend && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setConfigPlugin(configPlugin?.id === p.id ? null : p)}
                          className="text-xs"
                        >
                          <Puzzle className="h-3 w-3 mr-1" />
                          {configPlugin?.id === p.id ? "关闭配置面板" : "打开配置面板"}
                        </Button>
                      )}

                      {configPlugin?.id === p.id && (
                        <div className="border rounded-md overflow-hidden" style={{ height: 280 }}>
                          <PluginPanel pluginId={p.id} className="w-full h-full" />
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

      {/* Management dialog */}
      <LLMManagementDialog open={dialogOpen} onClose={() => setDialogOpen(false)} />

      <ConfirmDialog
        open={deleteTarget !== null}
        title="卸载插件"
        message={`确定卸载「${deleteTarget?.name}」吗？此操作将删除该插件的所有文件和数据。`}
        variant="destructive"
        confirmText={deleting ? "卸载中..." : "卸载"}
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  )
}
