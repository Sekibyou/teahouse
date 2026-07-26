import { useEffect, useState } from "react"
import {
  Plus, Trash2, Loader2, Star, X, Pencil, ArrowLeft,
} from "lucide-react"
import { useNavigate } from "react-router-dom"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ConfirmDialog } from "@/components/ConfirmDialog"
import { llmConfigsApi } from "@/lib/api"
import type { LLMConfig } from "@/lib/types"

const API_FORMATS = [
  { value: "openai", label: "OpenAI 兼容" },
  { value: "anthropic", label: "Anthropic" },
]

export function SettingsPage() {
  const navigate = useNavigate()
  const [configs, setConfigs] = useState<LLMConfig[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)
  const [actionLoading, setActionLoading] = useState(false)
  const [error, setError] = useState("")

  // Form fields
  const [label, setLabel] = useState("")
  const [apiUrl, setApiUrl] = useState("")
  const [apiKey, setApiKey] = useState("")
  const [modelName, setModelName] = useState("")
  const [apiFormat, setApiFormat] = useState("openai")
  const [maxTokens, setMaxTokens] = useState(8192)
  const [temperature, setTemperature] = useState(0.7)
  const [isDefault, setIsDefault] = useState(false)

  useEffect(() => { loadConfigs() }, [])

  const loadConfigs = async () => {
    setIsLoading(true)
    const res = await llmConfigsApi.list()
    if (res.ok) {
      setConfigs(res.data?.configs || [])
    }
    setIsLoading(false)
  }

  const openCreate = () => {
    setEditingId(null)
    setLabel("")
    setApiUrl("")
    setApiKey("")
    setModelName("")
    setApiFormat("openai")
    setMaxTokens(8192)
    setTemperature(0.7)
    setIsDefault(false)
    setError("")
    setShowForm(true)
  }

  const openEdit = (c: LLMConfig) => {
    setEditingId(c.id)
    setLabel(c.label)
    setApiUrl(c.api_url)
    setApiKey(c.api_key)
    setModelName(c.model_name)
    setApiFormat(c.api_format)
    setMaxTokens(c.max_tokens)
    setTemperature(c.temperature)
    setIsDefault(!!c.is_default)
    setError("")
    setShowForm(true)
  }

  const handleSave = async () => {
    if (!label.trim() || !apiUrl.trim() || !apiKey.trim() || !modelName.trim()) return
    setActionLoading(true)
    setError("")

    const data = {
      label: label.trim(),
      api_url: apiUrl.trim(),
      api_key: apiKey.trim(),
      model_name: modelName.trim(),
      api_format: apiFormat,
      max_tokens: maxTokens,
      temperature,
      is_default: isDefault,
    }

    if (editingId) {
      const res = await llmConfigsApi.update(editingId, data)
      if (!res.ok) { setError(res.error || "更新失败"); setActionLoading(false); return }
    } else {
      const res = await llmConfigsApi.create(data)
      if (!res.ok) { setError(res.error || "创建失败"); setActionLoading(false); return }
    }

    setActionLoading(false)
    setShowForm(false)
    await loadConfigs()
  }

  const handleDelete = (id: string) => {
    setDeleteTarget(id)
  }

  const confirmDelete = async () => {
    if (!deleteTarget) return
    await llmConfigsApi.delete(deleteTarget)
    setDeleteTarget(null)
    await loadConfigs()
  }

  const handleSetDefault = async (id: string) => {
    setActionLoading(true)
    await llmConfigsApi.update(id, { is_default: true })
    await loadConfigs()
    setActionLoading(false)
  }

  if (isLoading) {
    return (
      <div className="h-full flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
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
        <Button size="sm" onClick={openCreate} className="gap-1">
          <Plus className="h-3.5 w-3.5" />
          添加配置
        </Button>
      </div>

      {/* Config list */}
      <div className="flex-1 overflow-auto p-6 space-y-3">
        {configs.length === 0 ? (
          <div className="text-center text-muted-foreground py-16">
            <p className="text-sm">暂无 LLM 配置</p>
            <p className="text-xs mt-1 opacity-60">添加 API 配置以启用 AI 聊天</p>
          </div>
        ) : (
          configs.map((c) => (
            <div
              key={c.id}
              className="flex items-start gap-3 p-4 rounded-lg border border-border bg-muted/20 hover:bg-muted/40 transition-colors"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-sm">{c.label}</span>
                  {!!c.is_default && (
                    <span className="text-xs bg-primary/10 text-primary px-1.5 py-0.5 rounded">
                      默认
                    </span>
                  )}
                  {!c.is_enabled && (
                    <span className="text-xs bg-muted text-muted-foreground px-1.5 py-0.5 rounded">
                      已禁用
                    </span>
                  )}
                </div>
                <div className="text-xs text-muted-foreground mt-1 space-y-0.5">
                  <div>{c.model_name} · {c.api_format}</div>
                  <div className="truncate">{c.api_url}</div>
                  <div>max_tokens: {c.max_tokens} · temperature: {c.temperature}</div>
                </div>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                {!c.is_default && (
                  <button
                    className="p-1.5 rounded hover:bg-muted text-muted-foreground hover:text-yellow-500 transition-colors"
                    onClick={() => handleSetDefault(c.id)}
                    title="设为默认"
                  >
                    <Star className="h-3.5 w-3.5" />
                  </button>
                )}
                <button
                  className="p-1.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                  onClick={() => openEdit(c)}
                  title="编辑"
                >
                  <Pencil className="h-3.5 w-3.5" />
                </button>
                <button
                  className="p-1.5 rounded hover:bg-muted text-muted-foreground hover:text-red-500 transition-colors"
                  onClick={() => handleDelete(c.id)}
                  title="删除"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      {/* Create / Edit dialog */}
      {showForm && (
        <div className="fixed inset-0 bg-black/40 flex items-start justify-center z-50 pt-[10vh]" onClick={() => setShowForm(false)}>
          <div className="bg-background rounded-lg shadow-lg w-full max-w-md mx-4 p-6 space-y-4 max-h-[80vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h3 className="font-semibold text-lg">{editingId ? "编辑配置" : "添加 LLM 配置"}</h3>
              <button onClick={() => setShowForm(false)} className="p-1 rounded hover:bg-muted">
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="space-y-3">
              <Field label="名称" required>
                <Input value={label} onChange={e => setLabel(e.target.value)} placeholder="我的 Claude" autoFocus />
              </Field>

              <Field label="API URL" required>
                <Input value={apiUrl} onChange={e => setApiUrl(e.target.value)} placeholder="https://api.anthropic.com" />
              </Field>

              <Field label="API Key" required>
                <Input value={apiKey} onChange={e => setApiKey(e.target.value)} type="password" placeholder="sk-..." />
              </Field>

              <Field label="Model" required>
                <Input value={modelName} onChange={e => setModelName(e.target.value)} placeholder="claude-sonnet-5" />
              </Field>

              <Field label="协议格式">
                <select
                  className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm"
                  value={apiFormat}
                  onChange={e => setApiFormat(e.target.value)}
                >
                  {API_FORMATS.map(f => (
                    <option key={f.value} value={f.value}>{f.label}</option>
                  ))}
                </select>
              </Field>

              <div className="grid grid-cols-2 gap-3">
                <Field label="Max Tokens">
                  <Input
                    value={String(maxTokens)}
                    onChange={e => setMaxTokens(Number(e.target.value) || 0)}
                    type="number"
                  />
                </Field>
                <Field label="Temperature">
                  <Input
                    value={String(temperature)}
                    onChange={e => setTemperature(Number(e.target.value) || 0)}
                    type="number"
                    step="0.1"
                  />
                </Field>
              </div>

              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  checked={isDefault}
                  onChange={e => setIsDefault(e.target.checked)}
                  className="rounded"
                />
                设为默认配置
              </label>
            </div>

            {error && <p className="text-sm text-red-500">{error}</p>}

            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" size="sm" onClick={() => setShowForm(false)}>取消</Button>
              <Button
                size="sm"
                onClick={handleSave}
                disabled={!label.trim() || !apiUrl.trim() || !apiKey.trim() || !modelName.trim() || actionLoading}
              >
                {actionLoading && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}
                {editingId ? "保存" : "添加"}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Confirm delete dialog */}
      <ConfirmDialog
        open={deleteTarget !== null}
        title="确认删除"
        message="确定删除此配置？此操作不可撤销。"
        variant="destructive"
        confirmText="删除"
        onConfirm={confirmDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  )
}

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <label className="text-sm font-medium">
        {label}
        {required && <span className="text-red-500 ml-0.5">*</span>}
      </label>
      {children}
    </div>
  )
}
