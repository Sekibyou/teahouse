import { useEffect, useState } from "react"
import { ArrowLeft, Loader2, Settings2, Server, Star, Cpu, Puzzle } from "lucide-react"
import { useNavigate } from "react-router-dom"
import { Button } from "@/components/ui/button"
import { LLMManagementDialog } from "@/components/LLMManagementDialog"
import { llmSlotsApi, llmModelsApi, llmProvidersApi } from "@/lib/api"
import type { SlotBindings, LLMModel, LLMProvider } from "@/lib/types"

export function SettingsPage() {
  const navigate = useNavigate()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [slots, setSlots] = useState<SlotBindings>({ director: null, writer: null })
  const [models, setModels] = useState<LLMModel[]>([])
  const [providers, setProviders] = useState<LLMProvider[]>([])
  const [loading, setLoading] = useState(true)

  const loadState = async () => {
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

  useEffect(() => { loadState() }, [])
  // Refresh when dialog closes
  useEffect(() => { if (!dialogOpen) loadState() }, [dialogOpen])

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
          <h2 className="text-lg font-semibold">LLM 配置</h2>
        </div>
      </div>

      {/* Content */}
      {loading ? (
        <div className="flex-1 flex items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <div className="flex-1 overflow-auto p-6 space-y-6">
          {/* Quick status */}
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

          {/* Stats */}
          <div className="flex gap-3 text-xs text-muted-foreground">
            <span className="flex items-center gap-1">
              <Server className="h-3 w-3" />
              {providers.length} 供应商
            </span>
            <span className="flex items-center gap-1">
              <Cpu className="h-3 w-3" />
              {models.length} 模型（{models.filter(m => m.is_enabled).length} 启用）
            </span>
          </div>

          {/* Manage button */}
          <div className="space-y-2">
            <Button
              onClick={() => setDialogOpen(true)}
              className="w-full"
              variant="outline"
            >
              <Settings2 className="h-4 w-4 mr-2" />
              打开模型管理
            </Button>
            <Button
              onClick={() => navigate("/settings/plugins")}
              className="w-full"
              variant="outline"
            >
              <Puzzle className="h-4 w-4 mr-2" />
              管理插件
            </Button>
          </div>

          {/* Hint */}
          <div className="text-xs text-muted-foreground space-y-1 bg-muted/20 rounded-lg p-3">
            <p>默认的 LLM 配置管理已升级为新的三层模型系统：</p>
            <ol className="list-decimal pl-4 space-y-0.5">
              <li><strong>供应商</strong> — 管理 API 端点和密钥</li>
              <li><strong>模型池</strong> — 从供应商导入/手动添加模型，配置参数</li>
              <li><strong>槽位指定</strong> — 为两大槽位（导演/正文）选定模型</li>
            </ol>
          </div>
        </div>
      )}

      {/* Management dialog */}
      <LLMManagementDialog open={dialogOpen} onClose={() => setDialogOpen(false)} />
    </div>
  )
}
