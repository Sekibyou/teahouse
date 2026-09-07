import { FileText, Image, X } from "lucide-react"
import type { TabEntry } from "@/pages/WorkspacePage"

interface EditorTabsProps {
  /** 打开顺序的文件 path（root/...）列表 */
  tabs: string[]
  /** 当前激活 path */
  activePath: string
  /** 每个 path 的条目（读 dirty / isImage 用于标点与图标） */
  entries: Record<string, TabEntry>
  onActivate: (index: number) => void
  onClose: (index: number) => void
}

// 桌面后台模式的文件标签栏。激活高亮、脏文件橙点、图片图标区分、× 关闭（脏时上层弹确认）。
export function EditorTabs({ tabs, activePath, entries, onActivate, onClose }: EditorTabsProps) {
  if (!tabs.length) return null
  return (
    <div className="h-9 shrink-0 flex items-stretch overflow-x-auto border-b border-border bg-muted/20">
      {tabs.map((path, i) => {
        const entry = entries[path]
        const active = path === activePath
        const name = path.split("/").pop() || path
        return (
          <div
            key={path}
            role="tab"
            aria-selected={active}
            onClick={() => onActivate(i)}
            className={`group flex items-center gap-1.5 px-3 text-sm cursor-pointer select-none whitespace-nowrap border-r border-border shrink-0 ${
              active ? "bg-background text-foreground font-medium" : "text-muted-foreground hover:bg-muted/40"
            }`}
            title={path}
          >
            {entry?.isImage ? <Image className="h-3.5 w-3.5 shrink-0 opacity-70" /> : <FileText className="h-3.5 w-3.5 shrink-0 opacity-70" />}
            <span className="max-w-[200px] truncate">{name}</span>
            {entry?.dirty && <span className="h-1.5 w-1.5 rounded-full bg-orange-500 shrink-0" />}
            <button
              onClick={(e) => { e.stopPropagation(); onClose(i) }}
              className="ml-0.5 rounded p-0.5 shrink-0 text-muted-foreground/50 hover:bg-muted hover:text-foreground"
              aria-label="Close"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        )
      })}
    </div>
  )
}
