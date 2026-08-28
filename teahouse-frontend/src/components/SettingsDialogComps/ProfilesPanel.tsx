import { useState, useCallback, useEffect } from "react"
import { useTranslation } from "react-i18next"
import { Plus, Loader2, Pencil, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ConfirmDialog } from "@/components/ConfirmDialog"
import { useIsMobile } from "@/hooks/useMediaQuery"
import { Field } from "@/components/SettingsDialogComps/SettingsSection"
import { modelProfilesApi } from "@/lib/api"
import type { ModelProfile } from "@/lib/types"
import { profileDisplayName } from "@/lib/builtinNames"

export function ProfilesPanel() {
  const { t } = useTranslation("settings")
  const isMobile = useIsMobile()
  const [profiles, setProfiles] = useState<ModelProfile[]>([])
  const [profilesLoading, setProfilesLoading] = useState(false)
  const [createProfileOpen, setCreateProfileOpen] = useState(false)
  const [editingProfile, setEditingProfile] = useState<ModelProfile | null>(null)
  const [profileForm, setProfileForm] = useState({ name: "", match_pattern: "", temperature: 1.0, max_tokens: 4096, max_context: 131072, top_p: "", frequency_penalty: "", presence_penalty: "" })
  const [profileFormError, setProfileFormError] = useState("")
  const [profileFormSaving, setProfileFormSaving] = useState(false)
  const [deleteProfileTarget, setDeleteProfileTarget] = useState<string | null>(null)

  const loadProfiles = useCallback(async () => {
    setProfilesLoading(true)
    const res = await modelProfilesApi.list()
    if (res.ok) setProfiles(res.data!.profiles)
    setProfilesLoading(false)
  }, [])

  useEffect(() => { loadProfiles() }, [loadProfiles])

  const openProfileCreate = () => {
    setProfileFormError("")
    setProfileForm({ name: "", match_pattern: "", temperature: 1.0, max_tokens: 4096, max_context: 131072, top_p: "", frequency_penalty: "", presence_penalty: "" })
    setEditingProfile(null)
    setCreateProfileOpen(true)
  }

  const openProfileEdit = (p: ModelProfile) => {
    setProfileFormError("")
    setProfileForm({
      name: profileDisplayName(p, t),
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
      if (res.ok) { setCreateProfileOpen(false); setEditingProfile(null); await loadProfiles() }
      else setProfileFormError(res.error || t("errUpdate"))
    } else {
      const res = await modelProfilesApi.create(payload as ModelProfile & { name: string })
      if (res.ok) { setCreateProfileOpen(false); await loadProfiles() }
      else setProfileFormError(res.error || t("errCreate"))
    }
    setProfileFormSaving(false)
  }

  const deleteProfile = async () => {
    if (!deleteProfileTarget) return
    await modelProfilesApi.delete(deleteProfileTarget)
    setDeleteProfileTarget(null)
    await loadProfiles()
  }

  return (
    <div className="p-5 space-y-4 h-full flex flex-col">
      <div className="flex items-center justify-end">
        {!createProfileOpen && (
          <Button size="sm" variant="outline" onClick={openProfileCreate}>
            <Plus className="h-3.5 w-3.5 mr-1.5" />{t("profile.create")}
          </Button>
        )}
      </div>

      {createProfileOpen && (
        <div className="rounded-lg border border-primary/30 bg-primary/5 p-4 shrink-0">
          <h4 className="text-sm font-medium mb-3">
            {editingProfile?.is_builtin ? t("profile.viewBuiltin") : editingProfile ? t("profile.edit") : t("profile.create")}
          </h4>
          <div className="space-y-3">
            <div className={`grid ${isMobile ? "grid-cols-1" : "grid-cols-2"} gap-3`}>
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

      {profilesLoading ? (
        <div className="flex items-center justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
      ) : profiles.length === 0 ? (
        <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">{t("profile.none")}</div>
      ) : (
        <div className={`grid ${isMobile ? "grid-cols-1" : "grid-cols-2"} gap-3 overflow-auto flex-1 content-start`}>
          {profiles.filter(p => p.is_builtin).map(p => (
            <div key={p.id} className="rounded-lg border border-border bg-muted/20 p-4 flex items-start justify-between opacity-70">
              <div className="space-y-1 flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{profileDisplayName(p, t)}</span>
                  <span className="text-[10px] bg-muted px-1.5 py-0.5 rounded">{t("profile.builtIn")}</span>
                </div>
                <div className="text-xs text-muted-foreground">{t("profile.builtInView")}</div>
              </div>
              <Button variant="ghost" size="icon-xs" onClick={() => openProfileEdit(p)} title={t("profile.viewTitle")}>
                <Pencil className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
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

      <ConfirmDialog
        open={deleteProfileTarget !== null}
        title={t("del.profileTitle")}
        message={t("del.profileMessage")}
        variant="destructive"
        confirmText={t("common:delete")}
        onConfirm={deleteProfile}
        onCancel={() => setDeleteProfileTarget(null)}
      />
    </div>
  )
}
