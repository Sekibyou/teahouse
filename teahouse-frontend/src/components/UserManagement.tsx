import { useEffect, useState } from "react"
import {
  Plus, Trash2, Loader2, Pencil, Save, X, KeyRound, Shield, Crown, AlertCircle,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ConfirmDialog } from "@/components/ConfirmDialog"
import { usersApi, type ManagedUser } from "@/lib/api"
import { useAuth } from "@/stores/authStore"

const ROLE_LABELS: Record<string, string> = {
  super: "超级管理员",
  admin: "管理员",
  user: "普通用户",
}

type ManagedRole = "super" | "admin" | "user"

export function UserManagementPanel() {
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
      setError(res.error || "加载用户失败")
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
      setCreateError("用户名和密码必填")
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
      setCreateError(res.error || "创建失败")
    }
  }

  const saveName = async (id: string) => {
    if (!editingName) return
    const res = await usersApi.update(id, { display_name: editingName.display_name })
    if (res.ok) {
      setEditingName(null)
      await load()
    } else {
      setError(res.error || "保存失败")
    }
  }

  const savePwd = async () => {
    if (!pwdFor) return
    if (!pwdValue) {
      setPwdError("密码不能为空")
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
      setPwdError(res.error || "修改失败")
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
      setError(res.error || "操作失败")
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
      setError(res.error || "删除失败")
    }
  }

  const openRoleToggle = (u: ManagedUser) => {
    setRoleToggleTarget(u)
    setRoleToggleNext(u.role === "user" ? "admin" : "user")
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-muted-foreground">用户管理</h3>
        <Button size="sm" variant="outline" onClick={() => { setCreating((v) => !v); setCreateError("") }}>
          <Plus className="h-3.5 w-3.5 mr-1.5" />新建用户
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
              <label className="text-xs text-muted-foreground">用户名</label>
              <Input
                value={createForm.username}
                onChange={(e) => setCreateForm((f) => ({ ...f, username: e.target.value }))}
                placeholder="唯一登录标识"
                className="text-sm"
                autoFocus
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">密码</label>
              <Input
                type="password"
                value={createForm.password}
                onChange={(e) => setCreateForm((f) => ({ ...f, password: e.target.value }))}
                placeholder="登录密码"
                className="text-sm"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">显示名</label>
              <Input
                value={createForm.display_name}
                onChange={(e) => setCreateForm((f) => ({ ...f, display_name: e.target.value }))}
                placeholder="可随意，可撞名"
                className="text-sm"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">角色</label>
              <select
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
                value={createForm.role}
                onChange={(e) => setCreateForm((f) => ({ ...f, role: e.target.value }))}
                disabled={!isSuper}
                title={isSuper ? "" : "仅超级管理员可授予管理员角色"}
              >
                <option value="user">普通用户</option>
                <option value="admin" disabled={!isSuper}>管理员</option>
              </select>
            </div>
          </div>
          {createError && <p className="text-xs text-red-500">{createError}</p>}
          <div className="flex gap-2">
            <Button size="sm" onClick={createUser} disabled={createSaving}>
              {createSaving ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : null}创建
            </Button>
            <Button size="sm" variant="outline" onClick={() => { setCreating(false); setCreateError("") }}>
              取消
            </Button>
          </div>
        </div>
      )}

      {/* User list */}
      {loading ? (
        <div className="flex items-center justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
      ) : users.length === 0 ? (
        <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">暂无用户</div>
      ) : (
        <div className="space-y-2">
          {users.map((u) => {
            const canRole = canSetRole(u)
            const canE = canEdit(u)
            const canDel = canDelete(u)
            const canRoleReason = isSuper ? "不能变更超级管理员的角色" : "仅超级管理员可变更角色"
            const canEditReason = isSuper ? undefined : "只能管理普通用户"
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
                      {ROLE_LABELS[u.role]}
                    </span>
                    {u.id === actor?.user_id && <span className="text-[10px] text-muted-foreground shrink-0">（我）</span>}
                  </div>
                  <div className="text-xs text-muted-foreground mt-0.5">
                    <span className="font-mono">{u.username}</span>
                    {!u.is_active && <span className="ml-2 text-red-500">已禁用</span>}
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
                      title={canRole ? (u.role === "admin" ? "撤销管理员" : "设为管理员") : canRoleReason}
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
                      title={canE ? "改显示名" : canEditReason}
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
                    title={canE ? "改密码" : canEditReason}
                  >
                    <KeyRound className="h-3.5 w-3.5" />
                  </Button>
                  {/* Delete */}
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    onClick={() => setDeleteTarget(u)}
                    disabled={!canDel}
                    title={canDel ? "删除用户" : isSuper ? "不能删除超级管理员账户" : "只能删除普通用户"}
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
        微小的提示：超级管理员不可被删除或降级；{isSuper ? "你（超级管理员）可管理所有账户。" : "管理员只能管理普通用户，任免管理员需超级管理员。"}
      </div>

      {/* Change password dialog */}
      {pwdFor && (
        <div className="fixed inset-0 z-[70] bg-background/70 backdrop-blur-sm flex items-center justify-center" onClick={() => setPwdFor(null)}>
          <div className="bg-background rounded-lg border border-border shadow-xl p-4 w-[320px] space-y-3" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">修改 {pwdFor.username} 的密码</span>
              <button className="p-1 rounded hover:bg-muted" onClick={() => setPwdFor(null)}><X className="h-4 w-4" /></button>
            </div>
            <Input
              type="password"
              value={pwdValue}
              onChange={(e) => setPwdValue(e.target.value)}
              placeholder="新密码"
              className="text-sm"
              autoFocus
            />
            {pwdError && <p className="text-xs text-red-500">{pwdError}</p>}
            <div className="flex gap-2 justify-end">
              <Button size="sm" variant="outline" onClick={() => setPwdFor(null)}>取消</Button>
              <Button size="sm" onClick={savePwd} disabled={pwdSaving}>
                {pwdSaving ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <Save className="h-3 w-3 mr-1" />}保存
              </Button>
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={roleToggleTarget !== null}
        title={roleToggleNext === "admin" ? "授予管理员权限" : "撤销管理员权限"}
        message={roleToggleTarget ? `${roleToggleNext === "admin" ? "确认将「" : "确认撤销「"}${
          roleToggleTarget.display_name || roleToggleTarget.username
        }」${roleToggleNext === "admin" ? "」提升为管理员？" : "」的管理员权限，降为普通用户？"}` : ""}
        variant="default"
        confirmText={mutating ? "处理中..." : "确认"}
        onConfirm={applyRoleToggle}
        onCancel={() => setRoleToggleTarget(null)}
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        title="删除用户"
        message={deleteTarget ? `删除用户「${deleteTarget.display_name || deleteTarget.username}」？其工作区、API 密钥等数据将一并删除，不可恢复。` : ""}
        variant="destructive"
        confirmText={mutating ? "删除中..." : "删除"}
        onConfirm={applyDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  )
}
