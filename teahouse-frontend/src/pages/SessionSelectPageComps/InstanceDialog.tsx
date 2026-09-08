import { useEffect } from "react"
import { useTranslation } from "react-i18next"
import { Pencil, Hash, Clock, Play, BookOpen, Package, Copy, Trash2, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { CoverWithFetch } from "@/components/Cover"
import { renderText } from "@/lib/htmlSanitizer"
import { getBBCodeAnimationCSS, getBBCodeTooltipScript } from "@/lib/bbcodeParser"
import { formatDateShort } from "./formatDateShort"
import type { Instance } from "@/lib/types"

// ============================================================================
// Instance detail content — cover + README + continue + rename
// 作为真实路由页(InstanceDetailPage)的正文内容；不含弹层壳/遮罩/useDialogBackClose。
// 页面进出/返回由路由接管，此处不再压假条目（避免裸假条目夹在真实路由间写坏 react-router 序号）。
// ============================================================================
export function InstanceDialog({
  instance, readmeData, readmeLoading, renaming, renameValue, isMobile,
  onRenameValue, onToggleRename, onConfirmRename, actionLoading,
  onContinue, onDelete, onCopy, onManageSkills, onManagePackages,
}: {
  instance: Instance
  readmeData: { metadata: Record<string, unknown>; readme: string } | null
  readmeLoading: boolean
  renaming: boolean
  renameValue: string
  isMobile: boolean
  onRenameValue: (v: string) => void
  onToggleRename: () => void
  onConfirmRename: () => void
  actionLoading: boolean
  onContinue: () => void
  onDelete: () => void
  onCopy: () => void
  onManageSkills: () => void
  onManagePackages: () => void
}) {
  const { t } = useTranslation("session")
  const htmlContent = readmeData?.readme ? renderText(readmeData.readme, []) : ""

  // 容器：作为路由页正文，由外层(InstanceDetailPage)包 h-full 容器；这里只定内容自身的布局形态。
  // 移动 = 纵向三段占满；桌面 = 分栏占满(去掉 modal 遮罩/圆角/最大尺寸约束)。
  const shell = isMobile
    ? "flex-1 min-h-0 flex flex-col overflow-hidden bg-background"
    : "flex-1 min-h-0 flex flex-col overflow-hidden bg-background"

  useEffect(() => {
    const cssId = "bbcode-animation-css-readme"
    if (!document.getElementById(cssId)) {
      const style = document.createElement("style")
      style.id = cssId
      style.textContent = getBBCodeAnimationCSS()
      document.head.appendChild(style)
    }
    const tipId = "bbcode-tip-script"
    if (!document.getElementById(tipId)) {
      const s = document.createElement("script")
      s.id = tipId
      s.textContent = getBBCodeTooltipScript()
      document.head.appendChild(s)
    }
    return () => {
      const style = document.getElementById(cssId)
      if (style) style.remove()
      const s = document.getElementById(tipId)
      if (s) s.remove()
    }
  }, [])

  return (
    <div className={shell}>
        {isMobile ? (
          /* ===================== 窄屏：纵向三段式 ===================== */
          <>
            {/* Cover band */}
            <div className="relative shrink-0 h-52 w-full overflow-hidden bg-muted">
              <CoverWithFetch
                kind="instance"
                id={instance.id}
                name={instance.name}
                className="h-full"
              />
            </div>

            {/* Body */}
            <div className="flex-1 overflow-y-auto p-6 flex flex-col gap-4">
              <div>
                {renaming ? (
                  <div className="flex items-center gap-2">
                    <Input
                      value={renameValue}
                      onChange={(e) => onRenameValue(e.target.value)}
                      className="h-9 text-base font-medium"
                      autoFocus
                      onKeyDown={(e) => { if (e.key === "Enter") onConfirmRename() }}
                    />
                    <Button size="sm" onClick={onConfirmRename} disabled={!renameValue.trim()} className="shrink-0">
                      {actionLoading && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}
                      {t("common:ok")}
                    </Button>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <h2 className="text-xl font-serif font-bold">{instance.name}</h2>
                    <button className="p-1.5 rounded hover:bg-muted text-muted-foreground" onClick={onToggleRename} title={t("rename.title")}>
                      <Pencil className="h-4 w-4" />
                    </button>
                  </div>
                )}
                <div className="flex items-center gap-4 text-xs text-muted-foreground mt-1.5">
                  {instance.prototype_name && <span>{t("source", { name: instance.prototype_name })}</span>}
                  <span className="flex items-center gap-1"><Hash className="h-3 w-3" />{t("floorsLabel", { count: instance.floor_count })}</span>
                  <span className="flex items-center gap-1"><Clock className="h-3 w-3" />{formatDateShort(instance.updated_at)}</span>
                </div>
              </div>

              {/* README */}
              <div className="flex-1">
                {readmeLoading ? (
                  <div className="flex items-center justify-center py-10">
                    <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                  </div>
                ) : htmlContent ? (
                  <div
                    className="prose prose-sm dark:prose-invert max-w-none"
                    dangerouslySetInnerHTML={{ __html: htmlContent }}
                  />
                ) : (
                  <div className="text-sm text-muted-foreground">
                    {instance.prototype_id
                      ? t("noReadmeProto")
                      : t("noReadmeInstance")}
                  </div>
                )}
              </div>
            </div>

            {/* Actions */}
            <div className="border-t border-border p-4 flex items-center gap-2 shrink-0">
              <Button className="flex-1 gap-2" onClick={onContinue} disabled={actionLoading}>
                <Play className="h-4 w-4" />
                {t("start")}
              </Button>
              <Button variant="outline" onClick={onManageSkills} disabled={actionLoading} title={t("manageSkills")}>
                <BookOpen className="h-4 w-4" />
              </Button>
              <Button variant="outline" onClick={onManagePackages} disabled={actionLoading} title={t("managePackages")}>
                <Package className="h-4 w-4" />
              </Button>
              <Button variant="outline" onClick={onCopy} disabled={actionLoading} title={t("copy.title")}>
                <Copy className="h-4 w-4" />
              </Button>
              <Button variant="outline" className="text-red-500 hover:text-red-500" onClick={onDelete} disabled={actionLoading} title={t("common:delete")}>
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          </>
        ) : (
          /* ===================== 横屏：左右分栏 =====================
             左侧列 = 图片(高度自适应撑满) + 下方功能区(开始/复制/删除)；
             右侧列 = 标题 + markdown(内部滚动)；两列等高。 */
          <>
            <div className="flex-1 min-h-0 p-5 grid grid-cols-[1fr_2fr] grid-rows-1 gap-8 min-w-0">
              {/* 左侧列(1/3)：写死 1fr 宽；上=封面(占剩余高、超高裁剪) 下=功能区贴底 */}
              <div className="min-w-0 self-stretch flex flex-col min-h-0">
                {/* 封面区：flex-1 占据功能区之外的剩余高度；封面铺满该区宽、按宽推导高，
                    若高于剩余高度则由 overflow-hidden 裁剪而非挤推下方按钮（保证按钮始终可点）。 */}
                <div className="relative flex-1 min-h-0 overflow-hidden rounded-xl border border-border bg-card">
                  <CoverWithFetch
                    kind="instance"
                    id={instance.id}
                    name={instance.name}
                    className="w-full"
                  />
                </div>

                {/* 功能区：名字+meta + 开始 + 复制/删除，位于封面下方、贴底 */}
                <div className="mt-4 shrink-0 flex flex-col">
                  {/* 名字 + 改名 */}
                  {renaming ? (
                    <div className="flex items-center gap-2">
                      <Input
                        value={renameValue}
                        onChange={(e) => onRenameValue(e.target.value)}
                        className="h-8 text-sm font-medium"
                        autoFocus
                        onKeyDown={(e) => { if (e.key === "Enter") onConfirmRename() }}
                      />
                      <Button size="sm" onClick={onConfirmRename} disabled={!renameValue.trim()} className="shrink-0">
                        {actionLoading && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}
                        {t("common:ok")}
                      </Button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-1.5">
                      <h2 className="text-base font-serif font-bold truncate">{instance.name}</h2>
                      <button className="p-1 rounded hover:bg-muted text-muted-foreground shrink-0" onClick={onToggleRename} title={t("rename.title")}>
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  )}

                  {/* meta */}
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground mt-1">
                    {instance.prototype_name && <span>{t("source", { name: instance.prototype_name })}</span>}
                    <span className="flex items-center gap-1"><Hash className="h-3 w-3" />{t("floorsLabel", { count: instance.floor_count })}</span>
                    <span className="flex items-center gap-1"><Clock className="h-3 w-3" />{formatDateShort(instance.updated_at)}</span>
                  </div>

                  {/* 开始 */}
                  <Button className="w-full gap-2 mt-3" onClick={onContinue} disabled={actionLoading}>
                    <Play className="h-4 w-4" />
                    {t("start")}
                  </Button>

                  {/* 复制/删除 — 更小 */}
                  <div className="flex items-center gap-2 mt-2">
                    <Button variant="outline" size="sm" className="flex-1 gap-1 h-8 text-xs" onClick={onManageSkills} disabled={actionLoading} title={t("manageSkillsShort")}>
                      <BookOpen className="h-3.5 w-3.5" />Skill
                    </Button>
                    <Button variant="outline" size="sm" className="flex-1 gap-1 h-8 text-xs" onClick={onManagePackages} disabled={actionLoading} title={t("managePackagesShort")}>
                      <Package className="h-3.5 w-3.5" />{t("packagesShort")}
                    </Button>
                    <Button variant="outline" size="sm" className="flex-1 gap-1 h-8 text-xs" onClick={onCopy} disabled={actionLoading} title={t("copy.title")}>
                      <Copy className="h-3.5 w-3.5" />{t("copy.submit")}
                    </Button>
                    <Button variant="outline" size="sm" className="flex-1 gap-1 h-8 text-xs text-red-500 hover:text-red-500" onClick={onDelete} disabled={actionLoading} title={t("common:delete")}>
                      <Trash2 className="h-3.5 w-3.5" />{t("common:delete")}
                    </Button>
                  </div>
                </div>
              </div>

              {/* 右侧列(2fr)：markdown */}
              <div className="min-w-0 min-h-0 flex flex-col">
                <div className="flex-1 min-h-0 overflow-y-auto pr-1">
                  {readmeLoading ? (
                    <div className="py-10 flex items-center justify-center">
                      <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                    </div>
                  ) : htmlContent ? (
                    <div
                      className="prose prose-sm dark:prose-invert max-w-none"
                      dangerouslySetInnerHTML={{ __html: htmlContent }}
                    />
                  ) : (
                    <div className="text-sm text-muted-foreground">
                      {instance.prototype_id
                        ? t("noReadmeProto")
                        : t("noReadmeInstance")}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </>
        )}
    </div>
  )
}
