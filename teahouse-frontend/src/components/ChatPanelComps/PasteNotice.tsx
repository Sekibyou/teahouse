import { useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { FileText, Loader2, X } from "lucide-react"
import { instancesApi } from "@/lib/api"
import { parsePasteNotice } from "./utils"

/**
 * 「本轮粘贴了长文本」的系统气泡。徽章本身可点开：内联记录直接在弹层里按
 * 【粘贴N】 分块展示，暂存记录则按需 readText 拉取落盘的 temp/pasted/<hex8>.md。
 * 目的是让用户回看时能确认自己当初到底贴了什么，而不是只看到一句提示。
 */
export function PasteNotice({ content, instanceId }: { content: string; instanceId?: string }) {
  const { t } = useTranslation("misc")
  const [open, setOpen] = useState(false)
  const [fileText, setFileText] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const info = useMemo(() => parsePasteNotice(content), [content])
  const hasBody = !!info.spilled || info.blocks.length > 0
  // 徽章文案按解析结果选一条；具体措辞走 i18n（utils 只负责结构化解析）。
  const label = useMemo(() => {
    if (info.spilled) return t("chatInput.pasteNoticeSpilled")
    if (info.blocks.length === 0) return t("chatInput.pasteNoticeSent")
    return t("chatInput.pasteNoticeBlocks", { n: info.blocks.length })
  }, [info, t])

  const openViewer = () => {
    if (!hasBody) return
    setOpen(true)
    if (info.spilled && fileText === null && !loading && instanceId) {
      setLoading(true)
      setFailed(false)
      instancesApi.readText(instanceId, info.spilled)
        .then((res) => {
          if (res.ok && res.data) setFileText(res.data.content)
          else setFailed(true)
        })
        .catch(() => setFailed(true))
        .finally(() => setLoading(false))
    }
  }

  const badge = (
    <>
      <FileText className="h-3 w-3 text-muted-foreground/60" />
      <span>{label}</span>
    </>
  )

  if (!hasBody) {
    return (
      <div className="max-w-fit rounded-md px-2.5 py-1 text-[11px] text-muted-foreground/70 bg-muted/40 flex items-center gap-1.5">
        {badge}
      </div>
    )
  }

  const shown: { n: number; text: string }[] = info.spilled
    ? [{ n: 0, text: fileText ?? "" }]
    : info.blocks

  return (
    <>
      <button
        type="button"
        onClick={openViewer}
        className="max-w-fit cursor-pointer rounded-md px-2.5 py-1 text-[11px] text-muted-foreground/70 bg-muted/40 hover:bg-muted/70 transition-colors flex items-center gap-1.5"
        title={t("chatInput.viewPaste")}
      >
        {badge}
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-4 pt-[10vh] overflow-y-auto"
          onClick={() => setOpen(false)}
        >
          <div
            className="w-full max-w-2xl rounded-lg border border-border bg-background shadow-xl p-3 space-y-2 my-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium flex items-center gap-1.5">
                <FileText className="h-4 w-4 text-primary" />
                {t("chatInput.viewPaste")}
              </span>
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground"
                onClick={() => setOpen(false)}
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {info.spilled && (
              <p className="text-xs text-muted-foreground font-mono break-all">{info.spilled}</p>
            )}

            {loading ? (
              <div className="flex items-center gap-2 py-6 justify-center text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                {t("chatInput.loadingPaste")}
              </div>
            ) : failed ? (
              <div className="py-6 text-center text-sm text-destructive">
                {t("chatInput.loadPasteFailed")}
              </div>
            ) : (
              <div className="max-h-[60vh] space-y-2 overflow-y-auto">
                {shown.map((b, i) => (
                  <div key={i} className="rounded-md border border-border bg-muted/30">
                    {b.n > 0 && (
                      <div className="border-b border-border px-2 py-1 text-[11px] font-mono text-muted-foreground">
                        {t("chatInput.pasteBadge", { n: b.n })}
                      </div>
                    )}
                    <pre className="whitespace-pre-wrap break-words px-2 py-2 text-sm font-mono">{b.text}</pre>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  )
}
