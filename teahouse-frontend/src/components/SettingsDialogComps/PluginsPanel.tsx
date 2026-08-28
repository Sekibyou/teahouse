import { useRef, useState, useEffect } from "react"
import { useTranslation } from "react-i18next"
import { Loader2, Upload, X, Shield, Trash2, Power, PowerOff, Link2, Puzzle, AlertCircle } from "lucide-react"
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
import { PluginConfigPanel } from "@/components/PluginConfigPanel"
import { LibraryEmptyState } from "@/components/SettingsDialogComps/SettingsSection"
import { useCurrentLang } from "@/i18n/config"
import { resolvePluginText } from "@/lib/pluginI18n"
import { pluginsApi } from "@/lib/api"
import type { Plugin, PluginPreview, NetworkRule } from "@/lib/pluginTypes"
import { permLabels } from "@/components/SettingsDialogComps/types"

export function PluginsPanel() {
  const { t } = useTranslation("settings")
  const currentLang = useCurrentLang()
  const [plugins, setPlugins] = useState<Plugin[]>([])
  const [pluginsLoading, setPluginsLoading] = useState(false)
  const [toggling, setToggling] = useState<Set<string>>(new Set())
  const [configPlugin, setConfigPlugin] = useState<Plugin | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Plugin | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [uploading, setUploading] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [preview, setPreview] = useState<PluginPreview | null>(null)
  const [previewError, setPreviewError] = useState("")
  const [installing, setInstalling] = useState(false)
  const pendingZipRef = useRef<File | null>(null)
  const [netRulesFor, setNetRulesFor] = useState<Plugin | null>(null)
  const [netRules, setNetRules] = useState<NetworkRule[]>([])
  const [netRulesLoading, setNetRulesLoading] = useState(false)
  const [newRule, setNewRule] = useState<{ scheme: string; host: string; port: string }>({ scheme: "https", host: "", port: "" })
  const [netRuleError, setNetRuleError] = useState("")

  const loadPlugins = async () => {
    setPluginsLoading(true)
    const res = await pluginsApi.list()
    if (res.ok) setPlugins(res.data!.plugins)
    setPluginsLoading(false)
  }

  useEffect(() => { loadPlugins() }, [])

  const handleToggle = async (p: Plugin) => {
    setToggling((prev) => new Set(prev).add(p.id))
    if (p.enabled) await pluginsApi.disable(p.id)
    else await pluginsApi.enable(p.id)
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
      if (res.ok) await loadPlugins()
      else setPreviewError(res.error || t("errInstall"))
    } finally {
      setInstalling(false)
    }
  }

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

  return (
    <div className="p-5 space-y-6">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground flex items-center gap-1.5">
          {pluginsLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
          {t("plugin.count", { n: plugins.length })}
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
            <Button size="sm" variant="outline" onClick={() => { setPreview(null); pendingZipRef.current = null }}>
              {t("common:cancel")}
            </Button>
            <Button size="sm" onClick={handleConfirmInstall} disabled={installing || preview.conflicts.length > 0}>
              {installing ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null}
              {t("plugin.confirmInstall")}
            </Button>
          </div>
        </div>
      )}

      {plugins.length === 0 ? (
        <LibraryEmptyState
          icon={Puzzle}
          title={t("plugin.noPlugins")}
          lines={[t("plugin.emptyHint", { dir: "data/<user>/plugins/" }), t("plugin.hint")]}
        />
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
                    className="text-red-500 hover:text-red-700"
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
                    <Select
                      value={newRule.scheme}
                      onValueChange={(v) => setNewRule({ ...newRule, scheme: v ?? "https" })}
                    >
                      <SelectTrigger className="h-8 w-24 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="https">https</SelectItem>
                        <SelectItem value="http">http</SelectItem>
                      </SelectContent>
                    </Select>
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

      <ConfirmDialog
        open={deleteTarget !== null}
        title={t("del.pluginTitle")}
        message={t("del.pluginMessage", { name: resolvePluginText(deleteTarget?.name, deleteTarget?.i18n, currentLang) })}
        variant="destructive"
        confirmText={deleting ? t("del.uninstalling") : t("common:delete")}
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  )
}
