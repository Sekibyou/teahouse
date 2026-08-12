import { Send, Square, Minimize2, Maximize2, CheckCircle2 } from "lucide-react"
import { Button } from "@/components/ui/button"

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

interface ChatInputProps {
  // Input state
  input: string
  onInputChange: (value: string) => void
  onKeyDown: (e: React.KeyboardEvent) => void
  inputRef: React.RefObject<HTMLTextAreaElement | null>
  isStreaming: boolean
  isCompacting?: boolean

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
}: ChatInputProps) {
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
              确认 Git 提交
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
              拒绝
            </Button>
            <Button
              variant="default"
              size="sm"
              disabled={approving}
              onClick={onApprove}
            >
              {approving ? "提交中..." : "确认提交"}
            </Button>
          </div>
        </div>
      ) : (
        <div className={`flex gap-2 ${expandedInput ? "flex-1 min-h-0" : "items-end"}`}>
          <Button
            size="icon"
            variant="ghost"
            className="shrink-0 self-end text-muted-foreground hover:text-foreground h-10 w-10"
            onClick={onToggleExpand}
            title={expandedInput ? "收起小输入框" : "展开大输入框（占高度 80%）"}
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
            value={isCompacting ? "正在总结中…" : input}
            onChange={(e) => onInputChange(e.target.value)}
            onKeyDown={onKeyDown}
            onFocus={onFocus}
            placeholder={isCompacting ? "正在总结中…" : isStreaming ? "输入消息回车插入（不中断生成）..." : "输入消息... / 查看命令 (Enter 发送)"}
            disabled={isCompacting}
          />
          <Button
            size="icon"
            className="shrink-0 self-end h-10 w-10"
            onClick={isStreaming || isCompacting ? onStop : onSend}
            disabled={!(isStreaming || isCompacting) && !input.trim()}
            variant={isStreaming || isCompacting ? "destructive" : "default"}
            title={isCompacting ? "停止总结 (Esc)" : isStreaming ? "停止生成 (Esc)" : "发送 (Enter)"}
          >
            {isStreaming || isCompacting ? <Square className="h-4 w-4" /> : <Send className="h-4 w-4" />}
          </Button>
        </div>
      )}
    </div>
  )
}
