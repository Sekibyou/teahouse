import { useEffect } from "react"
import { useTranslation } from "react-i18next"
import { motion, useReducedMotion } from "motion/react"
import { ArrowLeft, Pencil, Hash, Clock, Play, BookOpen, Package, Copy, Trash2, X, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { CoverWithFetch } from "@/components/Cover"
import { renderText } from "@/lib/htmlSanitizer"
import { getBBCodeAnimationCSS, getBBCodeTooltipScript } from "@/lib/bbcodeParser"
import { useDialogBackClose } from "@/hooks/useDialogBackClose"
import { dialogShell } from "@/lib/animations"
import { formatDateShort } from "./formatDateShort"
import type { Instance } from "@/lib/types"

// ============================================================================
// Instance detail dialog — cover + README + continue + rename
// ============================================================================
export function InstanceDialog({
  instance, readmeData, readmeLoading, renaming, renameValue, isMobile,
  onRenameValue, onToggleRename, onConfirmRename, actionLoading,
  onContinue, onDelete, onCopy, onClose, onManageSkills, onManagePackages,
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
  onClose: () => void
  onManageSkills: () => void
  onManagePackages: () => void
}) {
  const { t } = useTranslation("session")
  const htmlContent = readmeData?.readme ? renderText(readmeData.readme, []) : ""
  useDialogBackClose(true, onClose)
  const reduced = useReducedMotion()

  // Mobile: fullscreen sheet; desktop: centered modal above a dimmed backdrop.
  const outer = isMobile
    ? "absolute inset-0 z-50 bg-background flex flex-col overflow-hidden"
    : "absolute inset-0 z-50 flex items-center justify-center p-4 bg-background/70 backdrop-blur-lg"

  const shell = isMobile
    ? "flex-1 min-h-0 flex flex-col overflow-hidden"
    : "bg-background rounded-2xl shadow-2xl border border-border w-[80vw] max-h-[90vh] flex flex-col overflow-hidden relative"

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
    <motion.div
      className={outer}
      onClick={isMobile ? undefined : onClose}
      initial={reduced ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={reduced ? undefined : { opacity: 0, transition: { duration: 0.15 } }}
    >
      <motion.div
        className={shell}
        onClick={(e) => e.stopPropagation()}
        variants={reduced ? undefined : dialogShell(isMobile ? "mobile" : "desktop")}
        initial="hidden"
        animate="show"
        exit="exit"
      >
        {isMobile ? (
          /* ===================== 窄屏：纵向三段式 ===================== */
          <>
            <button
              className="absolute top-3 left-3 z-10 p-2 rounded-full bg-black/30 text-white hover:bg-black/50 cursor-pointer"
              onClick={onClose}
              title={t("common:back")}
              aria-label={t("common:back")}
            >
              <ArrowLeft className="h-5 w-5" />
            </button>

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
            {/* Close button — top-right */}
            <button
              className="absolute top-3 right-10 z-10 p-2 rounded-full bg-black/30 text-white hover:bg-black/50 cursor-pointer"
              onClick={onClose}
              title={t("common:close")}
              aria-label={t("common:close")}
            >
              <X className="h-4 w-4" />
            </button>

            <div className="flex-1 min-h-0 p-5 grid grid-cols-[1fr_2fr] gap-8 min-w-0">
              {/* 左侧列(1/3)：写死 1fr 宽，图片铺满该列 */}
              <div className="min-w-0 self-stretch flex flex-col justify-between min-h-0">
                {/* 图片：宽=左列宽(1/3)，高=宽×4/3 健康比例；Cover 填满容器，img object-cover 居中裁剪不拉伸 */}
                <div className="shrink-0 w-full aspect-[3/4] overflow-hidden rounded-xl border border-border bg-card">
                  <CoverWithFetch
                    kind="instance"
                    id={instance.id}
                    name={instance.name}
                    driven="width"
                    className="h-full w-full"
                  />
                </div>

                {/* 功能区：名字+meta + 开始 + 复制/删除，位于图片下方、贴底 */}
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
      </motion.div>
    </motion.div>
  )
}
