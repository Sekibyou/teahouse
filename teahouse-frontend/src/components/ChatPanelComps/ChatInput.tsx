import { useState } from "react"
import { Send, Square, Minimize2, Maximize2, CheckCircle2, Paperclip, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useTranslation } from "react-i18next"

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
}: ChatInputProps) {
  const { t } = useTranslation("misc")
  const compactingText = t("chatInput.summarizing")
  // Id of the paste block being edited in the popover, or null.
  const [editingPasteId, setEditingPasteId] = useState<number | null>(null)
  const [draftContent, setDraftContent] = useState("")
  const editing = pastes.find((p) => p.id === editingPasteId) || null

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
    <div className={`border-t border-border relative ${expandedInput ? "flex-[0.8] min-h-0 flex flex-col p-3" : "shrink-0 p-3"}`}>
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
          {pastes.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
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
            </div>
          )}
        <div className={`flex gap-2 ${expandedInput ? "flex-1 min-h-0" : "items-end"}`}>
          <Button
            size="icon"
            variant="ghost"
            className="shrink-0 self-end text-muted-foreground hover:text-foreground h-10 w-10"
            onClick={onToggleExpand}
            title={expandedInput ? t("chatInput.collapseInput") : t("chatInput.expandInput")}
          >
            {expandedInput ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
          </Button>
          <textarea
            ref={inputRef}
            className={`flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring ${
              expandedInput
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
            disabled={!(isStreaming || isCompacting) && !input.trim() && pastes.length === 0}
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
    </div>
  )
}
