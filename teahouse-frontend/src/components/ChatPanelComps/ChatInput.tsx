import { useRef, useState } from "react"
import { Send, Square, Minimize2, Maximize2, CheckCircle2, Paperclip, ImagePlus, X, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useTranslation } from "react-i18next"
import { useIsMobile } from "@/hooks/useMediaQuery"
import { ImageLightbox } from "./MessageImage"

interface CommandDef {
  name: string
  description: string
  params?: {
    name: string
    description: string
  }[]
}

interface PendingApproval {
  id: string
  args: Record<string, unknown>
}

interface PasteBlock {
  id: number
  content: string
}

/** 一条待发送的附件图片。上传完成前 path 为空、uploading 为 true。 */
export interface PendingImage {
  id: number
  path: string
  mime: string
  /** 本地对象 URL，仅用于发送前的缩略图预览 */
  previewUri: string
  uploading?: boolean
}

interface ChatInputProps {
  // Input state
  input: string
  onInputChange: (value: string) => void
  onKeyDown: (e: React.KeyboardEvent) => void
  inputRef: React.RefObject<HTMLTextAreaElement | null>
  isStreaming: boolean
  isCompacting?: boolean

  // Paste blocks (oversized pasted chunks shown as badges above the input)
  pastes: PasteBlock[]
  onAddPaste: (content: string) => void
  onRemovePaste: (id: number) => void
  onUpdatePaste: (id: number, content: string) => void

  // Attached images (pasted or file-picked), shown as thumbnail chips
  images: PendingImage[]
  onAddImages: (files: File[]) => void
  onRemoveImage: (id: number) => void

  // Expand toggle
  expandedInput: boolean
  onToggleExpand: () => void

  // Send / Stop
  onSend: () => void
  onStop: () => void
  onFocus?: () => void

  // Command autocomplete
  filteredCommands: CommandDef[]
  commandIndex: number
  onCommandHover: (index: number) => void
  onCommandSelect: (name: string) => void

  // Git approval
  pendingApproval: PendingApproval | null
  approving: boolean
  commitPreview: string
  onApprove: () => void | Promise<void>
  onReject: () => void | Promise<void>

  // 移动端信息栏紧贴输入框上方时,去掉两者间的顶线,让它们视觉连成整体
  // (分隔线改由信息栏自身的顶线承担)。
  hideTopBorder?: boolean
}

// Paste content longer than this becomes a badge block instead of entering the
// textarea directly.
const PASTE_BLOCK_THRESHOLD = 300

export function ChatInput({
  input,
  onInputChange,
  onKeyDown,
  inputRef,
  isStreaming,
  expandedInput,
  onToggleExpand,
  onSend,
  onStop,
  onFocus,
  filteredCommands,
  commandIndex,
  onCommandHover,
  onCommandSelect,
  pendingApproval,
  approving,
  commitPreview,
  onApprove,
  onReject,
  isCompacting = false,
  pastes = [],
  onAddPaste,
  onRemovePaste,
  onUpdatePaste,
  images = [],
  onAddImages,
  onRemoveImage,
  hideTopBorder = false,
}: ChatInputProps) {
  const { t } = useTranslation("misc")
  const isMobile = useIsMobile()
  const compactingText = t("chatInput.summarizing")
  // Id of the paste block being edited in the popover, or null.
  const [editingPasteId, setEditingPasteId] = useState<number | null>(null)
  const [draftContent, setDraftContent] = useState("")
  const fileInputRef = useRef<HTMLInputElement>(null)
  // 尚未发送的附件预览图：点缩略图放大查看
  const [previewUri, setPreviewUri] = useState<string | null>(null)
  const editing = pastes.find((p) => p.id === editingPasteId) || null
  const imagesUploading = images.some((img) => img.uploading)

  const insertAtCursor = (text: string) => {
    const el = inputRef.current
    const start = el?.selectionStart ?? input.length
    const end = el?.selectionEnd ?? input.length
    const next = input.slice(0, start) + text + input.slice(end)
    onInputChange(next)
    requestAnimationFrame(() => {
      const pos = start + text.length
      el?.setSelectionRange(pos, pos)
    })
  }

  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const dt = e.clipboardData
    // Images take priority: pasting a screenshot should attach it, not dump
    // whatever text flavor the clipboard also carries.
    const imageFiles: File[] = []
    const dtItems = dt?.items
    if (dtItems) {
      for (let i = 0; i < dtItems.length; i++) {
        const it = dtItems[i]
        if (it.kind === "file" && it.type.startsWith("image/")) {
          const f = it.getAsFile()
          if (f) imageFiles.push(f)
        }
      }
    }
    if (imageFiles.length > 0) {
      e.preventDefault()
      onAddImages(imageFiles)
      return
    }
    const text = dt?.getData("text") ?? ""
    if (text) {
      if (text.length > PASTE_BLOCK_THRESHOLD) {
        e.preventDefault()
        onAddPaste(text)
      }
      return
    }
    // Mobile fallback: browsers触发 getData("text") 为空时(输入法/长按菜单粘贴,
    // 尤其安卓 Chrome),剪贴板文本仍在 items 里,需异步 getAsString 读取。
    const items = dt?.items
    if (!items || items.length === 0) return
    let hasText = false
    let buf = ""
    let pending = 0
    let settled = false
    const settle = () => {
      if (settled) return
      settled = true
      if (buf.length > PASTE_BLOCK_THRESHOLD) {
        onAddPaste(buf)
      } else if (buf.length > 0) {
        insertAtCursor(buf)
      }
    }
    for (const item of items) {
      if (item.kind === "string" && item.type === "text/plain") {
        hasText = true
        pending++
        item.getAsString((s) => {
          buf += s
          if (--pending === 0) settle()
        })
      }
    }
    // 只在确定有可用文本时拦默认粘贴,避免影响图片/无文本粘贴。
    if (hasText) e.preventDefault()
  }
  return (
    <div className={`relative ${expandedInput
      ? "flex-[0.8] min-h-0 flex flex-col p-3"
      // hideTopBorder 移动端信息栏紧贴输入框上方：去掉顶线，并收窄顶部 padding，
      // 让楼层统计与输入框连成整体而非留一片空白断层
      : (hideTopBorder ? "shrink-0 pt-1.5 px-3 pb-3" : "shrink-0 p-3")}`}>
      {filteredCommands.length > 0 && (
        <div className="absolute bottom-full left-3 right-3 mb-1 rounded-md border border-border bg-popover shadow-lg overflow-hidden">
          {filteredCommands.map((cmd, i) => (
            <button
              key={cmd.name}
              className={`w-full px-3 py-1.5 text-left text-sm flex items-center gap-2 transition-colors ${
                i === commandIndex ? "bg-accent text-accent-foreground" : "text-popover-foreground"
              }`}
              onMouseEnter={() => onCommandHover(i)}
              onMouseDown={(e) => {
                e.preventDefault()
                onCommandSelect(cmd.name)
              }}
            >
              <span className="font-mono text-primary">{cmd.name}</span>
              <span className="text-xs text-muted-foreground">{cmd.description}</span>
            </button>
          ))}
        </div>
      )}
      {pendingApproval ? (
        <div className="rounded-lg border border-purple-500/30 bg-purple-500/5 p-3 space-y-2">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-semibold flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-purple-500" />
              {t("chatInput.confirmGitCommit")}
            </h4>
          </div>
          <p className="text-xs text-muted-foreground">
            <span className="font-mono text-foreground text-sm">{commitPreview}</span>
          </p>
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={approving}
              onClick={onReject}
            >
              {t("chatInput.reject")}
            </Button>
            <Button
              variant="default"
              size="sm"
              disabled={approving}
              onClick={onApprove}
            >
              {approving ? t("chatInput.committing") : t("chatInput.commit")}
            </Button>
          </div>
        </div>
      ) : (
        <div className={`flex flex-col gap-1 ${expandedInput ? "flex-1 min-h-0" : ""}`}>
          {(pastes.length > 0 || images.length > 0) && (
            <div className="flex flex-wrap items-end gap-1.5">
              {pastes.map((p, i) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => { setEditingPasteId(p.id); setDraftContent(p.content) }}
                  className="inline-flex items-center gap-1.5 rounded-full border border-primary/40 bg-primary/10 px-2.5 py-0.5 text-xs text-primary hover:bg-primary/20 transition-colors"
                  title={t("chatInput.editPaste")}
                >
                  <Paperclip className="h-3 w-3" />
                  {t("chatInput.pasteBadge", { n: i + 1 })}
                </button>
              ))}
              {images.map((img, i) => (
                <span
                  key={img.id}
                  className="relative inline-flex shrink-0 rounded-md border border-primary/40 bg-primary/10 p-0.5"
                  title={t("chatInput.imageBadge", { n: i + 1 })}
                >
                  <img
                    src={img.previewUri}
                    alt=""
                    className="h-12 w-12 cursor-zoom-in rounded object-cover"
                    onClick={() => setPreviewUri(img.previewUri)}
                  />
                  {/* 序号与后端 【图N】 标识对齐，方便在输入里引用 */}
                  <span className="absolute left-1.5 bottom-1.5 rounded bg-background/85 px-1 text-[10px] leading-tight font-mono text-primary">
                    {i + 1}
                  </span>
                  {img.uploading ? (
                    // pointer-events-none：上传中也可以点开缩略图查看
                    <span className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-md bg-background/60">
                      <Loader2 className="h-4 w-4 animate-spin text-primary" />
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="absolute -right-1.5 -top-1.5 rounded-full bg-destructive text-destructive-foreground p-0.5 shadow"
                      onClick={() => onRemoveImage(img.id)}
                      title={t("chatInput.removeImage")}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  )}
                </span>
              ))}
            </div>
          )}
        <div className={`flex gap-2 ${expandedInput ? "flex-1 min-h-0" : "items-end"}`}>
          {!isMobile && (
            <Button
              size="icon"
              variant="ghost"
              className="shrink-0 self-end text-muted-foreground hover:text-foreground h-10 w-10"
              onClick={onToggleExpand}
              title={expandedInput ? t("chatInput.collapseInput") : t("chatInput.expandInput")}
            >
              {expandedInput ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
            </Button>
          )}
          <Button
            size="icon"
            variant="ghost"
            className="shrink-0 self-end text-muted-foreground hover:text-foreground h-10 w-10"
            onClick={() => fileInputRef.current?.click()}
            title={t("chatInput.attachImage")}
            disabled={isCompacting}
          >
            <ImagePlus className="h-4 w-4" />
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(e) => {
              const files = Array.from(e.target.files || []).filter((f) => f.type.startsWith("image/"))
              if (files.length) onAddImages(files)
              e.target.value = ""
            }}
          />
          <textarea
            ref={inputRef}
            className={`flex-1 rounded-md border border-input bg-background px-3 py-2 outline-none focus:ring-1 focus:ring-ring ${
              isMobile ? "text-sm placeholder:text-xs" : "text-sm"
            } ${expandedInput
                ? "min-h-0 resize-y"
                : "resize-none min-h-[40px] max-h-[120px]"
              }`}
            rows={1}
            value={isCompacting ? compactingText : input}
            onChange={(e) => onInputChange(e.target.value)}
            onKeyDown={onKeyDown}
            onFocus={onFocus}
            onPaste={handlePaste}
            placeholder={isCompacting ? compactingText : isStreaming ? t("chatInput.placeholderStreaming") : t("chatInput.placeholderNormal")}
            disabled={isCompacting}
          />
          <Button
            size="icon"
            className="shrink-0 self-end h-10 w-10"
            onClick={isStreaming || isCompacting ? onStop : onSend}
            disabled={!(isStreaming || isCompacting) && ((!input.trim() && pastes.length === 0 && images.length === 0) || imagesUploading)}
            variant={isStreaming || isCompacting ? "destructive" : "default"}
            title={isCompacting ? t("chatInput.stopSummarizing") : isStreaming ? t("chatInput.stopGenerating") : t("chatInput.send")}
          >
            {isStreaming || isCompacting ? <Square className="h-4 w-4" /> : <Send className="h-4 w-4" />}
          </Button>
        </div>

        {/* Paste block editor popover — fixed relative to the viewport so the
            large editor never gets clipped when the input sits near screen edges. */}
        {editing && (
          <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 p-4 pt-[10vh] overflow-y-auto"
               onClick={() => setEditingPasteId(null)}>
            <div
              className="w-full max-w-xl rounded-lg border border-border bg-background shadow-xl p-3 space-y-2 my-auto"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium flex items-center gap-1.5">
                  <Paperclip className="h-4 w-4 text-primary" />
                  {t("chatInput.editPaste")}
                </span>
                <button className="text-muted-foreground hover:text-foreground" onClick={() => setEditingPasteId(null)}>
                  <X className="h-4 w-4" />
                </button>
              </div>
              <textarea
                className="w-full h-64 max-h-[55vh] rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring font-mono resize-y"
                value={draftContent}
                onChange={(e) => setDraftContent(e.target.value)}
                autoFocus
              />
              <div className="flex justify-end gap-2">
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => { onRemovePaste(editing.id); setEditingPasteId(null) }}
                >
                  {t("chatInput.deletePaste")}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setEditingPasteId(null)}
                >
                  {t("chatInput.cancelPaste")}
                </Button>
                <Button
                  size="sm"
                  onClick={() => { onUpdatePaste(editing.id, draftContent); setEditingPasteId(null) }}
                >
                  {t("chatInput.savePaste")}
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>
      )}
      {previewUri && (
        <ImageLightbox uri={previewUri} alt={t("chatInput.imageBadge", { n: 1 })} onClose={() => setPreviewUri(null)} />
      )}
    </div>
  )
}
