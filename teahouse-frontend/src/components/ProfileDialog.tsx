import { useState } from "react"
import { X, Plus, Pencil, Trash2, Loader2, AlertCircle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ConfirmDialog } from "@/components/ConfirmDialog"
import { modelProfilesApi } from "@/lib/api"
import type { ModelProfile } from "@/lib/types"

interface ProfileDialogProps {
  open: boolean
  onClose: () => void
  profiles: ModelProfile[]
}

export function ProfileDialog({ open, onClose, profiles }: ProfileDialogProps) {
  const [editingProfile, setEditingProfile] = useState<ModelProfile | null>(null)
  const [form, setForm] = useState({
    name: "", match_pattern: "", temperature: 0.7, max_tokens: 8192,
    top_p: "", frequency_penalty: "", presence_penalty: "",
  })
  const [error, setError] = useState("")
  const [saving, setSaving] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)

  const openForm = (p?: ModelProfile) => {
    setError("")
    if (p) {
      setEditingProfile(p)
      setForm({
        name: p.name,
        match_pattern: p.match_pattern || "",
        temperature: p.temperature,
        max_tokens: p.max_tokens,
        top_p: p.top_p != null ? String(p.top_p) : "",
        frequency_penalty: p.frequency_penalty != null ? String(p.frequency_penalty) : "",
        presence_penalty: p.presence_penalty != null ? String(p.presence_penalty) : "",
      })
    } else {
      setEditingProfile(null)
      setForm({ name: "", match_pattern: "", temperature: 0.7, max_tokens: 8192, top_p: "", frequency_penalty: "", presence_penalty: "" })
    }
  }

  const save = async () => {
    if (!form.name.trim()) { setError("名称必填"); return }
    setSaving(true)
    setError("")
    const data: Record<string, unknown> = {
      name: form.name.trim(),
      match_pattern: form.match_pattern.trim() || null,
      temperature: form.temperature,
      max_tokens: form.max_tokens,
      top_p: form.top_p ? parseFloat(form.top_p) : null,
      frequency_penalty: form.frequency_penalty ? parseFloat(form.frequency_penalty) : null,
      presence_penalty: form.presence_penalty ? parseFloat(form.presence_penalty) : null,
    }
    if (editingProfile) {
      const res = await modelProfilesApi.update(editingProfile.id, data)
      if (res.ok) { setEditingProfile(null); onClose() }
      else setError(res.error || "更新失败")
    } else {
      const res = await modelProfilesApi.create(data as Partial<ModelProfile> & { name: string })
      if (res.ok) { setEditingProfile(null); onClose() }
      else setError(res.error || "创建失败")
    }
    setSaving(false)
  }

  const deleteProfile = async () => {
    if (!deleteTarget) return
    await modelProfilesApi.delete(deleteTarget)
    setDeleteTarget(null)
    onClose()
  }

  if (!open) return null

  return (
    <>
      <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-[60]" onClick={onClose}>
        <div
          className="bg-background rounded-lg shadow-xl flex flex-col overflow-hidden"
          style={{ width: "600px", maxHeight: "80vh" }}
          onClick={e => e.stopPropagation()}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-5 py-3 border-b border-border shrink-0">
            <div className="flex items-center gap-2">
              <span className="font-semibold text-sm">预设编辑</span>
              <span className="text-xs text-muted-foreground">模型参数配置 + 正则匹配</span>
            </div>
            <div className="flex items-center gap-2">
              <Button size="sm" variant="outline" onClick={() => openForm()}>
                <Plus className="h-3.5 w-3.5 mr-1.5" />新建
              </Button>
              <button className="p-1 rounded hover:bg-muted" onClick={onClose}>
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>

          {/* Error bar */}
          {error && (
            <div className="px-5 py-2 bg-red-500/10 border-b border-red-500/20 text-xs text-red-500 shrink-0 flex items-center gap-2">
              <AlertCircle className="h-3 w-3 shrink-0" />
              <span className="flex-1">{error}</span>
              <button className="underline shrink-0" onClick={() => setError("")}>关闭</button>
            </div>
          )}

          {/* Content */}
          <div className="overflow-auto flex-1 p-5 space-y-4">
            {/* Form */}
            {editingProfile !== undefined && (
              <div className="rounded-lg border border-border p-4 space-y-3 bg-muted/5">
                <h4 className="text-sm font-medium">{editingProfile ? "编辑预设" : "新建预设"}</h4>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="名称">
                    <Input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="如 DeepSeek 标准" className="text-sm" />
                  </Field>
                  <Field label="匹配正则">
                    <Input value={form.match_pattern} onChange={e => setForm(f => ({ ...f, match_pattern: e.target.value }))} placeholder="如 deepseek" className="text-sm font-mono" />
                  </Field>
                  <Field label="Temperature">
                    <Input type="number" step="0.1" min="0" max="2" value={form.temperature} onChange={e => setForm(f => ({ ...f, temperature: parseFloat(e.target.value) || 0 }))} className="text-sm" />
                  </Field>
                  <Field label="Max Tokens">
                    <Input type="number" step="1" min="1" value={form.max_tokens} onChange={e => setForm(f => ({ ...f, max_tokens: parseInt(e.target.value) || 0 }))} className="text-sm" />
                  </Field>
                  <Field label="Top P">
                    <Input value={form.top_p} onChange={e => setForm(f => ({ ...f, top_p: e.target.value }))} placeholder="留空不设置" className="text-sm" />
                  </Field>
                  <Field label="Frequency Penalty">
                    <Input value={form.frequency_penalty} onChange={e => setForm(f => ({ ...f, frequency_penalty: e.target.value }))} placeholder="留空不设置" className="text-sm" />
                  </Field>
                  <Field label="Presence Penalty" className="col-span-2">
                    <Input value={form.presence_penalty} onChange={e => setForm(f => ({ ...f, presence_penalty: e.target.value }))} placeholder="留空不设置" className="text-sm" />
                  </Field>
                </div>
                <div className="flex gap-2">
                  <Button size="sm" onClick={save} disabled={saving}>
                    {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : null}
                    {editingProfile ? "保存" : "创建"}
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => { setEditingProfile(undefined); setError("") }}>
                    取消
                  </Button>
                </div>
              </div>
            )}

            {/* Profile list */}
            {profiles.length === 0 ? (
              <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">暂无预设</div>
            ) : (
              <div className="space-y-1.5">
                {profiles.map(pr => (
                  <div key={pr.id} className="flex items-center gap-3 px-3 py-2.5 rounded-lg border border-border text-sm hover:bg-muted/20">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{pr.name}</span>
                        {pr.match_pattern && (
                          <span className="text-[10px] font-mono bg-muted px-1.5 py-0.5 rounded text-muted-foreground">
                            /{pr.match_pattern}/
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground mt-0.5">
                        t={pr.temperature} max={pr.max_tokens}
                        {pr.top_p != null ? ` p=${pr.top_p}` : ""}
                        {pr.frequency_penalty != null ? ` freq=${pr.frequency_penalty}` : ""}
                        {pr.presence_penalty != null ? ` pres=${pr.presence_penalty}` : ""}
                      </div>
                    </div>
                    <div className="flex items-center gap-0.5 shrink-0">
                      <Button variant="ghost" size="icon-xs" onClick={() => openForm(pr)} title="编辑">
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button variant="ghost" size="icon-xs" onClick={() => setDeleteTarget(pr.id)} title="删除">
                        <Trash2 className="h-3.5 w-3.5 text-red-500" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={deleteTarget !== null}
        title="删除预设"
        message="关联此预设的模型将被取消绑定，确认删除？"
        variant="destructive"
        confirmText="删除"
        onConfirm={deleteProfile}
        onCancel={() => setDeleteTarget(null)}
      />
    </>
  )
}

function Field({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={`space-y-1 ${className || ""}`}>
      <label className="text-xs text-muted-foreground">{label}</label>
      {children}
    </div>
  )
}
