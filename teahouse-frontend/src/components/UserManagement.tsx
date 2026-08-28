import { useEffect, useState } from "react"
import {
  Plus, Trash2, Loader2, Pencil, Save, X, KeyRound, Shield, Crown, AlertCircle,
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
import { usersApi, type ManagedUser } from "@/lib/api"
import { useAuth } from "@/stores/authStore"
import { useTranslation } from "react-i18next"

// 角色标签改用 i18n key,渲染处经 user.normalUser / user.admin / user.superAdmin 取值。
const ROLE_LABELS: Record<string, string> = {
  super: "superAdmin",
  admin: "admin",
  user: "normalUser",
}

type ManagedRole = "super" | "admin" | "user"

export function UserManagementPanel() {
  const { t } = useTranslation("misc")
  const { user: actor } = useAuth()
  const isSuper = actor?.role === "super"

  const [users, setUsers] = useState<ManagedUser[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")

  // create form
  const [creating, setCreating] = useState(false)
  const [createForm, setCreateForm] = useState({ username: "", password: "", display_name: "", role: "user" })
  const [createError, setCreateError] = useState("")
  const [createSaving, setCreateSaving] = useState(false)

  // edit states
  const [editingName, setEditingName] = useState<{ id: string; display_name: string } | null>(null)
  const [pwdFor, setPwdFor] = useState<ManagedUser | null>(null)
  const [pwdValue, setPwdValue] = useState("")
  const [pwdSaving, setPwdSaving] = useState(false)
  const [pwdError, setPwdError] = useState("")

  // confirm targets
  const [roleToggleTarget, setRoleToggleTarget] = useState<ManagedUser | null>(null)
  const [roleToggleNext, setRoleToggleNext] = useState<ManagedRole>("user")
  const [deleteTarget, setDeleteTarget] = useState<ManagedUser | null>(null)
  const [mutating, setMutating] = useState(false)

  const load = async () => {
    setLoading(true)
    const res = await usersApi.list()
    setLoading(false)
    if (res.ok) {
      setUsers(res.data!)
      setError("")
    } else {
      setError(res.error || t("user.loadFailed"))
    }
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Permission model (frontend disable layer; backend re-checks) ──
  // actor is super → can manage everyone except: can't delete self, can't touch
  // the super account's role (never demote). actor is admin → can only manage
  // regular users.
  const canSetRole = (t: ManagedUser) => isSuper && t.role !== "super"
  const isSelf = (t: ManagedUser) => t.id === actor?.user_id
  const canEdit = (t: ManagedUser) => isSuper || t.role === "user" || isSelf(t)
  const canDelete = (t: ManagedUser) =>
    isSuper ? t.id !== actor?.user_id && t.role !== "super" : t.role === "user"

  const createUser = async () => {
    if (!createForm.username.trim() || !createForm.password) {
      setCreateError(t("user.createRequired"))
      return
    }
    setCreateSaving(true)
    setCreateError("")
    const res = await usersApi.create({
      username: createForm.username.trim(),
      password: createForm.password,
      display_name: createForm.display_name.trim(),
      role: createForm.role,
    })
    setCreateSaving(false)
    if (res.ok) {
      setCreating(false)
      setCreateForm({ username: "", password: "", display_name: "", role: "user" })
      await load()
    } else {
      setCreateError(res.error || t("user.createFailed"))
    }
  }

  const saveName = async (id: string) => {
    if (!editingName) return
    const res = await usersApi.update(id, { display_name: editingName.display_name })
    if (res.ok) {
      setEditingName(null)
      await load()
    } else {
      setError(res.error || t("user.saveFailed"))
    }
  }

  const savePwd = async () => {
    if (!pwdFor) return
    if (!pwdValue) {
      setPwdError(t("user.passwordRequired"))
      return
    }
    setPwdSaving(true)
    setPwdError("")
    const res = await usersApi.update(pwdFor.id, { password: pwdValue })
    setPwdSaving(false)
    if (res.ok) {
      setPwdFor(null)
      setPwdValue("")
    } else {
      setPwdError(res.error || t("user.pwdUpdateFailed"))
    }
  }

  const applyRoleToggle = async () => {
    if (!roleToggleTarget) return
    setMutating(true)
    const res = await usersApi.update(roleToggleTarget.id, { role: roleToggleNext })
    setMutating(false)
    setRoleToggleTarget(null)
    if (res.ok) {
      await load()
    } else {
      setError(res.error || t("user.operateFailed"))
    }
  }

  const applyDelete = async () => {
    if (!deleteTarget) return
    setMutating(true)
    const res = await usersApi.delete(deleteTarget.id)
    setMutating(false)
    setDeleteTarget(null)
    if (res.ok) {
      await load()
    } else {
      setError(res.error || t("user.deleteFailed"))
    }
  }

  const openRoleToggle = (u: ManagedUser) => {
    setRoleToggleTarget(u)
    setRoleToggleNext(u.role === "user" ? "admin" : "user")
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-end">
        <Button size="sm" variant="outline" onClick={() => { setCreating((v) => !v); setCreateError("") }}>
          <Plus className="h-3.5 w-3.5 mr-1.5" />{t("user.newUser")}
        </Button>
      </div>

      {error && (
        <div className="flex items-start gap-2 text-xs text-red-600 bg-red-500/5 border border-red-500/20 rounded-md px-3 py-2">
          <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      {/* Create form */}
      {creating && (
        <div className="rounded-lg border border-primary/30 bg-primary/5 p-4 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">{t("user.username")}</label>
              <Input
                value={createForm.username}
                onChange={(e) => setCreateForm((f) => ({ ...f, username: e.target.value }))}
                placeholder={t("user.uniqueLogin")}
                className="text-sm"
                autoFocus
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">{t("user.password")}</label>
              <Input
                type="password"
                value={createForm.password}
                onChange={(e) => setCreateForm((f) => ({ ...f, password: e.target.value }))}
                placeholder={t("user.loginPassword")}
                className="text-sm"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">{t("user.displayName")}</label>
              <Input
                value={createForm.display_name}
                onChange={(e) => setCreateForm((f) => ({ ...f, display_name: e.target.value }))}
                placeholder={t("user.displayNameHint")}
                className="text-sm"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">{t("user.role")}</label>
              <Select
                value={createForm.role}
                onValueChange={(v) => setCreateForm((f) => ({ ...f, role: v ?? "user" }))}
                disabled={!isSuper}
              >
                <SelectTrigger className="w-full h-9 text-sm" title={isSuper ? "" : t("user.onlySuperCanGrant")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="user">{t("user.normalUser")}</SelectItem>
                  <SelectItem value="admin" disabled={!isSuper}>{t("user.admin")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          {createError && <p className="text-xs text-red-500">{createError}</p>}
          <div className="flex gap-2">
            <Button size="sm" onClick={createUser} disabled={createSaving}>
              {createSaving ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : null}{t("user.create")}
            </Button>
            <Button size="sm" variant="outline" onClick={() => { setCreating(false); setCreateError("") }}>
              {t("common:cancel")}
            </Button>
          </div>
        </div>
      )}

      {/* User list */}
      {loading ? (
        <div className="flex items-center justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
      ) : users.length === 0 ? (
        <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">{t("user.noUsers")}</div>
      ) : (
        <div className="space-y-2">
          {users.map((u) => {
            const canRole = canSetRole(u)
            const canE = canEdit(u)
            const canDel = canDelete(u)
            const canRoleReason = isSuper ? t("user.cannotChangeSuperRole") : t("user.onlySuperCanChangeRole")
            const canEditReason = isSuper ? undefined : t("user.onlyManageNormal")
            return (
              <div key={u.id} className="rounded-lg border p-3 flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium truncate">{u.display_name || u.username}</span>
                    <span className={`text-[10px] px-1.5 py-0.5 rounded shrink-0 ${
                      u.role === "super" ? "bg-amber-500/20 text-amber-600"
                      : u.role === "admin" ? "bg-blue-500/20 text-blue-600"
                      : "bg-muted text-muted-foreground"
                    }`}>
                      {t(`user.${ROLE_LABELS[u.role]}`)}
                    </span>
                    {u.id === actor?.user_id && <span className="text-[10px] text-muted-foreground shrink-0">{t("user.me")}</span>}
                  </div>
                  <div className="text-xs text-muted-foreground mt-0.5">
                    <span className="font-mono">{u.username}</span>
                    {!u.is_active && <span className="ml-2 text-red-500">{t("user.disabled")}</span>}
                  </div>
                </div>

                <div className="flex items-center gap-1 shrink-0">
                  {/* Toggle admin */}
                  {u.role !== "super" && (
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      onClick={() => openRoleToggle(u)}
                      disabled={!canRole}
                      title={canRole ? (u.role === "admin" ? t("user.revokeAdmin") : t("user.grantAdmin")) : canRoleReason}
                    >
                      {u.role === "admin" ? <Shield className="h-3.5 w-3.5 text-amber-500" /> : <Crown className="h-3.5 w-3.5" />}
                    </Button>
                  )}
                  {/* Edit display name */}
                  {editingName?.id === u.id ? (
                    <div className="flex items-center gap-1 mr-1">
                      <Input
                        className="text-sm w-36"
                        value={editingName.display_name}
                        onChange={(e) => setEditingName({ id: u.id, display_name: e.target.value })}
                        onBlur={() => saveName(u.id)}
                        onKeyDown={(e) => { if (e.key === "Enter") saveName(u.id); if (e.key === "Escape") setEditingName(null) }}
                        autoFocus
                      />
                    </div>
                  ) : (
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      onClick={() => setEditingName({ id: u.id, display_name: u.display_name })}
                      disabled={!canE}
                      title={canE ? t("user.editName") : canEditReason}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                  )}
                  {/* Change password */}
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    onClick={() => { setPwdFor(u); setPwdValue(""); setPwdError("") }}
                    disabled={!canE}
                    title={canE ? t("user.changePwd") : canEditReason}
                  >
                    <KeyRound className="h-3.5 w-3.5" />
                  </Button>
                  {/* Delete */}
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    onClick={() => setDeleteTarget(u)}
                    disabled={!canDel}
                    title={canDel ? t("user.deleteUser") : isSuper ? t("user.cannotDeleteSuper") : t("user.onlyDeleteNormal")}
                  >
                    <Trash2 className="h-3.5 w-3.5 text-red-500" />
                  </Button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      <div className="text-[11px] text-muted-foreground pt-2 border-t border-border">
        {isSuper ? t("user.footerTipSuper") : t("user.footerTipAdmin")}
      </div>

      {/* Change password dialog */}
      {pwdFor && (
        <div className="fixed inset-0 z-[70] bg-background/70 backdrop-blur-sm flex items-center justify-center" onClick={() => setPwdFor(null)}>
          <div className="bg-background rounded-lg border border-border shadow-xl p-4 w-[320px] space-y-3" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">{t("user.changePwdTitle", { name: pwdFor.username })}</span>
              <button className="p-1 rounded hover:bg-muted" onClick={() => setPwdFor(null)}><X className="h-4 w-4" /></button>
            </div>
            <Input
              type="password"
              value={pwdValue}
              onChange={(e) => setPwdValue(e.target.value)}
              placeholder={t("user.newPassword")}
              className="text-sm"
              autoFocus
            />
            {pwdError && <p className="text-xs text-red-500">{pwdError}</p>}
            <div className="flex gap-2 justify-end">
              <Button size="sm" variant="outline" onClick={() => setPwdFor(null)}>{t("common:cancel")}</Button>
              <Button size="sm" onClick={savePwd} disabled={pwdSaving}>
                {pwdSaving ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <Save className="h-3 w-3 mr-1" />}{t("common:save")}
              </Button>
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={roleToggleTarget !== null}
        title={roleToggleNext === "admin" ? t("user.grantRoleTitle") : t("user.revokeRoleTitle")}
        message={roleToggleTarget ? (roleToggleNext === "admin"
          ? t("user.grantRoleMsg", { name: roleToggleTarget.display_name || roleToggleTarget.username })
          : t("user.revokeRoleMsg", { name: roleToggleTarget.display_name || roleToggleTarget.username })) : ""}
        variant="default"
        confirmText={mutating ? t("user.processing") : t("common:confirm")}
        onConfirm={applyRoleToggle}
        onCancel={() => setRoleToggleTarget(null)}
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        title={t("user.deleteTitle")}
        message={deleteTarget ? t("user.deleteMsg", { name: deleteTarget.display_name || deleteTarget.username }) : ""}
        variant="destructive"
        confirmText={mutating ? t("user.deleting") : t("common:delete")}
        onConfirm={applyDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  )
}
