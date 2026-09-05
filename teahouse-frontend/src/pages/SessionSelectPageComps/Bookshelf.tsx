import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { motion, AnimatePresence, useReducedMotion } from "motion/react"
import { ArrowLeft, X, Upload, Loader2, BookOpen, Download, Trash2, Play } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { CoverWithFetch } from "@/components/Cover"
import { renderText } from "@/lib/htmlSanitizer"
import { getBBCodeAnimationCSS, getBBCodeTooltipScript } from "@/lib/bbcodeParser"
import { useIsMobile } from "@/hooks/useMediaQuery"
import { useDialogBackClose } from "@/hooks/useDialogBackClose"
import { STAGGER_CONTAINER, CARD_UP, dialogShell, BACKDROP_FADE } from "@/lib/animations"
import { prototypesApi } from "@/lib/api"
import type { Prototype } from "@/lib/types"

// ============================================================================
// Bookshelf overlay — floating prototype waterfall, blurs the underlying page
// ============================================================================
export function Bookshelf({
  prototypes, importState, fileInputRef, onImport, onClose, onCreate, onDownload, onDeleteProto,
}: {
  prototypes: Prototype[]
  importState: "idle" | "loading"
  fileInputRef: React.RefObject<HTMLInputElement | null>
  onImport: (e: React.ChangeEvent<HTMLInputElement>) => void
  onClose: () => void
  onCreate: (protoId: string, name: string) => Promise<boolean>
  onDownload: (p: Prototype) => void
  onDeleteProto: (p: Prototype) => void
}) {
  const { t } = useTranslation("session")
  const [selected, setSelected] = useState<Prototype | null>(null)
  const mobile = useIsMobile()
  const reduced = useReducedMotion()
  useDialogBackClose(true, onClose)

  // Render the dialog only while the selected prototype still exists, so a
  // delete while it's open simply dismisses it (no effect / cascading render).
  const showDialog = !!selected && prototypes.some((p) => p.id === selected.id)

  return (
    <motion.div
      className="absolute inset-0 z-40"
      initial={reduced ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={reduced ? undefined : { opacity: 0, transition: { duration: 0.15 } }}
    >
      {/* Blur backdrop */}
      <motion.div
        className="absolute inset-0 bg-background/70 backdrop-blur-lg"
        onClick={onClose}
        variants={reduced ? undefined : BACKDROP_FADE}
        initial="hidden"
        animate="show"
        exit="exit"
      />

      <motion.div
        className="absolute inset-0 flex flex-col overflow-hidden px-6 sm:px-10 lg:px-16 py-6 sm:py-8 relative"
        variants={reduced ? undefined : STAGGER_CONTAINER}
        initial="hidden"
        animate="show"
      >
        {/* Back arrow — mobile: floating black circle top-left; desktop: inline in the header */}
        {mobile ? (
          <motion.button
            variants={reduced ? undefined : CARD_UP}
            className="absolute top-3 left-3 z-10 p-2 rounded-full bg-black/30 text-white hover:bg-black/50 cursor-pointer"
            onClick={onClose}
            title={t("closeShelf")}
          >
            <ArrowLeft className="h-5 w-5" />
          </motion.button>
        ) : null}
        {/* Bookshelf header */}
        <motion.div
          variants={reduced ? undefined : CARD_UP}
          className={`flex items-center gap-3 mb-2 shrink-0 ${mobile ? "pl-10" : ""}`}
        >
          <h2 className="text-lg sm:text-xl font-serif font-bold">{t("shelfTitle")}</h2>
          <div className="flex-1" />
          <input
            ref={fileInputRef}
            type="file"
            accept=".teabrew,.zip"
            className="hidden"
            onChange={onImport}
          />
          {!mobile ? (
            /* 横屏：更明显的导入按钮 + 右上角关闭 */
            <>
              <Button
                variant={prototypes.length === 0 ? "outline" : "secondary"}
                size="sm"
                className="gap-1.5"
                disabled={importState === "loading"}
                onClick={() => fileInputRef.current?.click()}
              >
                {importState === "loading" ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Upload className="h-3.5 w-3.5" />
                )}
                {t("import.title")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5"
                onClick={onClose}
              >
                <X className="h-3.5 w-3.5" />
                {t("common:close")}
              </Button>
            </>
          ) : (
            <button
              className="p-2 rounded hover:bg-muted text-muted-foreground"
              disabled={importState === "loading"}
              onClick={() => fileInputRef.current?.click()}
              title={t("import.title")}
            >
              {importState === "loading" ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Upload className="h-4 w-4" />
              )}
            </button>
          )}
        </motion.div>

        <motion.p
          variants={reduced ? undefined : CARD_UP}
          className="text-xs text-muted-foreground mb-4 shrink-0"
        >
          {t("shelfHint")}
        </motion.p>

        {/* Prototype waterfall — clicking non-card area closes the shelf (landscape) */}
        <div
          className="h-full overflow-y-auto min-h-0"
          onClick={() => { if (!mobile) onClose() }}
        >
          {prototypes.length === 0 ? (
            <div className="flex flex-col items-center justify-center text-center gap-3 py-24">
              <BookOpen className="h-12 w-12 text-muted-foreground opacity-40" />
              <p className="text-sm text-muted-foreground">{t("shelfEmpty")}</p>
              <Button variant="outline" className="gap-2" onClick={() => fileInputRef.current?.click()}>
                <Upload className="h-4 w-4" />{t("import.title")}
              </Button>
            </div>
          ) : (
            <motion.div
              className="columns-2 md:columns-3 lg:columns-4 xl:columns-5 gap-6 px-8 pb-10 pt-8"
            >
              {prototypes.map((p) => (
                <BookshelfCard key={p.id} proto={p} onSelect={() => setSelected(p)} />
              ))}
            </motion.div>
          )}
        </div>
      </motion.div>

      {/* Prototype detail dialog — floats above the shelf */}
      <AnimatePresence>
        {showDialog && selected && (
          <PrototypeDetailDialog
            prototype={selected}
            isMobile={mobile}
            onClose={() => setSelected(null)}
            onCreate={onCreate}
            onDownload={onDownload}
            onDeleteProto={onDeleteProto}
          />
        )}
      </AnimatePresence>
    </motion.div>
  )
}

function BookshelfCard({ proto, onSelect }: { proto: Prototype; onSelect: (p: Prototype) => void }) {
  const { t } = useTranslation("session")
  return (
    <div
      className="mb-6 break-inside-avoid rounded-xl overflow-hidden border border-border bg-card shadow-sm cursor-pointer
        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring card-hover-glow group"
      onClick={(e) => { e.stopPropagation(); onSelect(proto) }}
    >
      <CoverWithFetch
        kind="prototype"
        id={proto.id}
        name={proto.name}
        className="transition-transform duration-300 ease-out group-hover:scale-[1.05]"
      />
      <div className="p-3">
        <div className="flex items-center gap-2">
          <span className="font-medium text-sm truncate flex-1">{proto.name}</span>
          {proto.is_builtin ? (
            <span className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded shrink-0">{t("builtin")}</span>
          ) : null}
        </div>
        {proto.description && (
          <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{proto.description}</p>
        )}
      </div>
    </div>
  )
}

// ============================================================================
// Prototype detail dialog — floats above the bookshelf. Three-section layout
// matching the instance dialog: cover band / README / bottom create bar.
// Top-left back arrow closes it; mobile renders fullscreen.
// ============================================================================
function PrototypeDetailDialog({
  prototype, isMobile, onClose, onCreate, onDownload, onDeleteProto,
}: {
  prototype: Prototype
  isMobile: boolean
  onClose: () => void
  onCreate: (protoId: string, name: string) => Promise<boolean>
  onDownload: (p: Prototype) => void
  onDeleteProto: (p: Prototype) => void
}) {
  const { t } = useTranslation("session")
  const [readmeData, setReadmeData] = useState<{ metadata: Record<string, unknown>; readme: string } | null>(null)
  // Starts loading on mount; reset before fetching a (new) prototype's README.
  const [readmeLoading, setReadmeLoading] = useState(true)
  const [instanceName, setInstanceName] = useState("")
  const [error, setError] = useState("")
  const [creating, setCreating] = useState(false)
  // 详情是书架子层级：系统返回先关详情（回书架），再关书架（回大厅）
  useDialogBackClose(true, onClose)

  // Load README for the selected prototype (dialog remounts per prototype with
  // fresh initial state, so no synchronous reset here).
  useEffect(() => {
    let cancelled = false
    prototypesApi.getReadme(prototype.id).then((res) => {
      if (cancelled) return
      setReadmeData(res.ok && res.data ? res.data : null)
      setReadmeLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [prototype.id])

  // Inject BBCode animation CSS + tooltip script (same as the instance dialog).
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

  const reduced = useReducedMotion()
  const htmlContent = readmeData?.readme ? renderText(readmeData.readme, []) : ""

  const doCreate = async () => {
    if (!instanceName.trim()) return
    setCreating(true)
    setError("")
    const ok = await onCreate(prototype.id, instanceName)
    setCreating(false)
    if (!ok) setError(t("create.failRetry"))
  }

  // Mobile: fullscreen sheet; desktop: centered modal above the blurred shelf.
  const outer = isMobile
    ? "absolute inset-0 z-50 bg-background flex flex-col overflow-hidden"
    : "absolute inset-0 z-50 flex items-center justify-center bg-background/70 backdrop-blur-lg p-4"

  const shell = isMobile
    ? "flex-1 min-h-0 flex flex-col overflow-hidden"
    : "bg-background rounded-2xl shadow-2xl border border-border w-[80vw] max-h-[90vh] flex flex-col overflow-hidden relative"

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
            {/* Close button — floating top-left */}
            <button
              className="absolute top-3 left-3 z-10 p-2 rounded-full bg-black/30 text-white hover:bg-black/50 cursor-pointer"
              onClick={onClose}
              title={t("backShelf")}
              aria-label={t("backShelf")}
            >
              <ArrowLeft className="h-5 w-5" />
            </button>

            {/* Cover band */}
            <div className="relative shrink-0 h-44 sm:h-60 w-full overflow-hidden bg-muted">
              <CoverWithFetch kind="prototype" id={prototype.id} name={prototype.name} className="h-full" />
              <div className="absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-black/60 to-transparent" />
              <div className="absolute bottom-0 left-0 right-0 p-3.5 flex items-center gap-2 text-white">
                <h3 className="font-semibold text-lg truncate">{prototype.name}</h3>
                {prototype.is_builtin ? (
                  <span className="text-[10px] text-white/90 bg-white/25 px-1.5 py-0.5 rounded shrink-0">{t("builtin")}</span>
                ) : null}
                {!prototype.is_builtin && (
                  <div className="flex-1 flex items-center justify-end gap-1.5">
                    <button
                      className="p-2 rounded-full bg-black/30 text-white hover:bg-black/50 cursor-pointer"
                      onClick={() => onDownload(prototype)}
                      title={t("download")}
                    >
                      <Download className="h-4 w-4" />
                    </button>
                    <button
                      className="p-2 rounded-full bg-black/30 text-white hover:bg-red-600/80 cursor-pointer"
                      onClick={() => onDeleteProto(prototype)}
                      title={t("common:delete")}
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                )}
              </div>
            </div>

            {/* README */}
            <div className="flex-1 min-h-0 overflow-y-auto p-5 pb-2">
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
                <div className="text-sm text-muted-foreground">{t("noReadmeProto")}</div>
              )}
            </div>

            {/* Bottom create bar */}
            <div className="border-t border-border p-4 flex items-end gap-2 shrink-0">
              <div className="flex-1 min-w-0 flex flex-col gap-1">
                <label className="text-xs text-muted-foreground">{t("instanceNameLabel")}</label>
                <Input
                  value={instanceName}
                  onChange={(e) => { setInstanceName(e.target.value); setError("") }}
                  placeholder={t("instanceNamePh")}
                  onKeyDown={(e) => { if (e.key === "Enter") doCreate() }}
                />
                {error && <p className="text-xs text-red-500">{error}</p>}
              </div>
              <Button onClick={doCreate} disabled={!instanceName.trim() || creating} className="shrink-0 gap-1.5 h-10 px-4">
                {creating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
                {t("create.submitShort")}
              </Button>
            </div>
          </>
        ) : (
          /* ===================== 横屏：左右分栏 =====================
             左侧列 = 图片(高度自适应撑满) + 下方功能区；
             右侧列 = 标题 + markdown(内部滚动)；
             两列等高，图片高度 + 功能区高度 = markdown 高度。 */
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
              {/* 左侧列(1fr)：写死 1fr 宽；图片高度自适应收缩填入左栏除去功能区的剩余高度，
                  避免自建原型多出「下载/删除」一行时把弹窗撑高。 */}
              <div className="min-w-0 self-stretch flex flex-col justify-between min-h-0">
                {/* 图片：flex-1 填满剩余空间，Cover object-cover 裁剪不拉伸 */}
                <div className="flex-1 min-h-0 w-full overflow-hidden rounded-xl border border-border bg-card">
                  <CoverWithFetch
                    kind="prototype"
                    id={prototype.id}
                    name={prototype.name}
                    driven="width"
                    className="h-full w-full"
                  />
                </div>

                {/* 功能区：名字+badge + 创建 + 下载/删除，位于图片下方、贴底 */}
                <div className="mt-4 shrink-0 flex flex-col">
                  {/* 名字 + 内置 badge */}
                  <div className="flex items-center gap-1.5">
                    <h3 className="text-base font-serif font-bold truncate">{prototype.name}</h3>
                    {prototype.is_builtin ? (
                      <span className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded shrink-0">{t("builtin")}</span>
                    ) : null}
                  </div>

                  <label className="text-xs text-muted-foreground mt-3">{t("instanceNameLabel")}</label>
                  <Input
                    className="mt-1"
                    value={instanceName}
                    onChange={(e) => { setInstanceName(e.target.value); setError("") }}
                    placeholder={t("instanceNamePh")}
                    onKeyDown={(e) => { if (e.key === "Enter") doCreate() }}
                  />
                  {error && <p className="text-xs text-red-500 mt-1">{error}</p>}
                  <Button onClick={doCreate} disabled={!instanceName.trim() || creating} className="w-full mt-2 gap-1.5">
                    {creating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
                    {t("create.submit")}
                  </Button>

                  {!prototype.is_builtin && (
                    <div className="flex items-center gap-2 mt-3">
                      <Button variant="outline" size="sm" className="flex-1 gap-1 h-8 text-xs" onClick={() => onDownload(prototype)}>
                        <Download className="h-3.5 w-3.5" />{t("download")}
                      </Button>
                      <Button variant="outline" size="sm" className="flex-1 gap-1 h-8 text-xs text-red-500 hover:text-red-500" onClick={() => onDeleteProto(prototype)}>
                        <Trash2 className="h-3.5 w-3.5" />{t("common:delete")}
                      </Button>
                    </div>
                  )}
                </div>
              </div>

              {/* 右侧列(2fr)：纯 markdown */}
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
                    <div className="text-sm text-muted-foreground">{t("noReadmeProto")}</div>
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
