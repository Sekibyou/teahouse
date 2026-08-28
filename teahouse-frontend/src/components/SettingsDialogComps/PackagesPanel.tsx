import { useRef, useState, useEffect } from "react"
import { useTranslation } from "react-i18next"
import { Loader2, Upload, X, Package, Download, Trash2, AlertCircle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ConfirmDialog } from "@/components/ConfirmDialog"
import { LibraryEmptyState } from "@/components/SettingsDialogComps/SettingsSection"
import { packagesApi } from "@/lib/api"
import type { MyPackage, PackagePreview } from "@/lib/api"

export function PackagesPanel() {
  const { t } = useTranslation("settings")
  const [myPackages, setMyPackages] = useState<MyPackage[]>([])
  const [packagesLoading, setPackagesLoading] = useState(false)
  const packageFileInputRef = useRef<HTMLInputElement>(null)
  const [packagePreview, setPackagePreview] = useState<PackagePreview | null>(null)
  const [packagePreviewError, setPackagePreviewError] = useState("")
  const [packageUploading, setPackageUploading] = useState(false)
  const [packageInstalling, setPackageInstalling] = useState(false)
  const [packageDeleting, setPackageDeleting] = useState<string | null>(null)
  const [packageDeleteTarget, setPackageDeleteTarget] = useState<string | null>(null)

  const loadMyPackages = async () => {
    setPackagesLoading(true)
    const res = await packagesApi.listMy()
    if (res.ok) setMyPackages(res.data!.packages)
    setPackagesLoading(false)
  }

  useEffect(() => { loadMyPackages() }, [])

  const handlePackageImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setPackageUploading(true)
    setPackagePreviewError("")
    try {
      const form = new FormData()
      form.append("file", file)
      const res = await packagesApi.preview(form)
      if (res.ok) setPackagePreview(res.data)
      else {
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
      if (res.ok) await loadMyPackages()
      else setPackagePreviewError(res.error || t("errImport"))
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

  return (
    <div className="p-5 space-y-6">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground flex items-center gap-1.5">
          {packagesLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
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
        <LibraryEmptyState
          icon={Package}
          title={t("pkg.emptyTitle")}
          lines={[t("pkg.emptyHint"), t("pkg.hint")]}
        />
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
                    className="text-red-500 hover:text-red-700"
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

      <ConfirmDialog
        open={packageDeleteTarget !== null}
        title={t("del.pkgTitle")}
        message={t("del.pkgMessage", { name: packageDeleteTarget })}
        variant="destructive"
        confirmText={packageDeleting ? t("del.deleting") : t("common:delete")}
        onConfirm={handlePackageDelete}
        onCancel={() => setPackageDeleteTarget(null)}
      />
    </div>
  )
}
