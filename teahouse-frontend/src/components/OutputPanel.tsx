import { useState, useEffect, useCallback } from "react"
import { FileText } from "lucide-react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { useOutputSSE, type OutputBlock } from "@/hooks/useOutputSSE"

interface OutputPanelProps {
  instanceId: string | undefined
}

export function OutputPanel({ instanceId }: OutputPanelProps) {
  const [blocks, setBlocks] = useState<OutputBlock[]>([])

  const handleAppend = useCallback((block: OutputBlock) => {
    setBlocks((prev) => [...prev, block])
  }, [])

  const handleReplace = useCallback((block: OutputBlock) => {
    setBlocks((prev) =>
      prev.map((b) => (b.uuid === block.uuid ? block : b))
    )
  }, [])

  const handleDelete = useCallback((uuid: string) => {
    setBlocks((prev) => prev.filter((b) => b.uuid !== uuid))
  }, [])

  useOutputSSE({
    instanceId,
    onAppend: handleAppend,
    onReplace: handleReplace,
    onDelete: handleDelete,
  })

  if (blocks.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground">
        <div className="text-center">
          <FileText className="h-12 w-12 mx-auto mb-3 opacity-20" />
          <p className="text-sm">等待 AI 生成内容...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-auto py-4 px-6 space-y-6">
      {blocks.map((block) => (
        <OutputBlockView key={block.uuid} block={block} />
      ))}
    </div>
  )
}

function OutputBlockView({ block }: { block: OutputBlock }) {
  const [collapsed, setCollapsed] = useState(false)

  return (
    <div className="rounded-lg border border-border bg-muted/10 overflow-hidden">
      <button
        className="flex items-center gap-2 w-full px-4 py-2 text-xs text-muted-foreground hover:bg-muted/30 transition-colors"
        onClick={() => setCollapsed(!collapsed)}
      >
        <span className="font-medium text-foreground">{block.label}</span>
        <span className="opacity-60">{block.note}</span>
        <span className="ml-auto text-[10px] opacity-40">
          {collapsed ? "展开" : "折叠"}
        </span>
      </button>
      {!collapsed && (
        <div className="px-4 pb-4 prose prose-sm dark:prose-invert prose-chat max-w-none">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>
            {block.rendered}
          </ReactMarkdown>
        </div>
      )}
    </div>
  )
}
