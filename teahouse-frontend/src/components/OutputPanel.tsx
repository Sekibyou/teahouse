import { useState, useEffect, useCallback, useMemo } from "react"
import { FileText } from "lucide-react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { useOutputSSE, type OutputBlock } from "@/hooks/useOutputSSE"
import { outputBlocksApi } from "@/lib/api"

interface OutputPanelProps {
  instanceId: string | undefined
  instanceName: string | undefined
}

/**
 * OutputPanel — 独立沙盒，用于展示导演推送到前端的输出内容。
 *
 * 通信机制：
 * 1. 挂载时主动 GET /api/instances/{id}/output-blocks 获取全部输出块摘要
 * 2. 对于 label 以 "ep" 开头的块，按数字后缀排序，找出最高 ep
 * 3. 自动 GET 最高 ep 块的全文（rendered）进行展示
 * 4. SSE 实时监听 output.append / output.replace / output.delete 增量更新
 *
 * 未来可作为第三方前端的参考实现——开发者只需：
 *   - GET /api/instances/{id}/output-blocks → 获取摘要
 *   - GET /api/instances/{id}/output-blocks/{uuid} → 获取全文
 *   - SSE /events → 实时更新
 */
export function OutputPanel({ instanceId, instanceName }: OutputPanelProps) {
  const [blocks, setBlocks] = useState<OutputBlock[]>([])
  const [initialLoading, setInitialLoading] = useState(true)

  // ---- SSE 实时更新 ----
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
    instanceName,
    onAppend: handleAppend,
    onReplace: handleReplace,
    onDelete: handleDelete,
  })

  // ---- 首次加载：获取全部输出块摘要 ----
  useEffect(() => {
    if (!instanceId) return

    ;(async () => {
      setInitialLoading(true)
      const res = await outputBlocksApi.list(instanceId)
      if (res.ok && res.data?.blocks) {
        // 为每个摘要生成一个占位渲染字段（SSE 事件到来时会被真正的 rendered 填充）
        const initial = res.data.blocks.map((b) => ({
          uuid: b.uuid,
          label: b.label,
          note: b.note,
          rendered: "",
        }))
        setBlocks(initial)
      }
      setInitialLoading(false)
    })()
  }, [instanceId])

  // ---- 解析 ep 块 ----
  const epBlocks = useMemo(() => {
    const eps = blocks
      .filter((b) => /^ep\d+$/i.test(b.label))
      .map((b) => {
        const num = parseInt(b.label.replace(/^ep/i, ""), 10)
        return { ...b, epNum: num }
      })
      .sort((a, b) => b.epNum - a.epNum) // 降序
    return eps
  }, [blocks])

  // ---- 当前活跃 ep（最高编号） ----
  const activeEpBlock = useMemo(() => {
    return epBlocks.length > 0 ? epBlocks[0] : null
  }, [epBlocks])

  // ---- 首次加载时获取最高 ep 块的正文 ----
  const [activeRendered, setActiveRendered] = useState<string | null>(null)
  const [activeEpLoading, setActiveEpLoading] = useState(false)

  useEffect(() => {
    if (!instanceId || !activeEpBlock) return
    // 如果 SSE 已经推送了 rendered，直接用
    if (activeEpBlock.rendered) {
      setActiveRendered(activeEpBlock.rendered)
      return
    }
    // 否则主动获取
    ;(async () => {
      setActiveEpLoading(true)
      const res = await outputBlocksApi.get(instanceId, activeEpBlock.uuid)
      if (res.ok && res.data) {
        setActiveRendered(res.data.rendered)
      }
      setActiveEpLoading(false)
    })()
  }, [instanceId, activeEpBlock?.uuid])

  // SSE replace 更新时同步刷新 activeRendered
  useEffect(() => {
    if (activeEpBlock?.rendered) {
      setActiveRendered(activeEpBlock.rendered)
    }
  }, [activeEpBlock?.rendered])

  // SSE append 更新：如果新块是 ep 块且是最高的，自动展示
  useEffect(() => {
    if (epBlocks.length > 0 && !activeRendered) {
      const latest = epBlocks[0]
      if (latest.rendered) {
        setActiveRendered(latest.rendered)
      }
    }
  }, [epBlocks, activeRendered])

  // ---- UI ----

  if (initialLoading) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground">
        <div className="text-center">
          <FileText className="h-12 w-12 mx-auto mb-3 opacity-20 animate-pulse" />
          <p className="text-sm">加载中...</p>
        </div>
      </div>
    )
  }

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
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* 当前章节正文 — 占主要区域 */}
      <div className="flex-1 overflow-auto py-4 px-6">
        {activeEpLoading && !activeRendered ? (
          <div className="flex items-center justify-center h-full text-muted-foreground">
            <p className="text-sm">加载正文...</p>
          </div>
        ) : activeRendered ? (
          <div className="prose prose-sm dark:prose-invert prose-chat max-w-none">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {activeRendered}
            </ReactMarkdown>
          </div>
        ) : (
          <div className="flex items-center justify-center h-full text-muted-foreground">
            <p className="text-sm">暂无正文内容</p>
          </div>
        )}
      </div>

      {/* 底部 — 输出块列表（调试用） */}
      <div className="border-t border-border shrink-0 max-h-[30%] overflow-auto">
        <div className="px-4 py-2 text-[10px] text-muted-foreground font-mono">
          输出块 ({blocks.length}) | ep 块 ({epBlocks.length})
          {activeEpBlock && (
            <span className="ml-2">
              | 当前: {activeEpBlock.label} ({activeEpBlock.note})
            </span>
          )}
        </div>
        <div className="space-y-1 px-2 pb-2">
          {blocks.map((block) => (
            <OutputBlockRow
              key={block.uuid}
              block={block}
              isActive={block.uuid === activeEpBlock?.uuid}
              onSelect={(b) => {
                if (b.rendered) {
                  setActiveRendered(b.rendered)
                } else if (instanceId) {
                  outputBlocksApi.get(instanceId, b.uuid).then((res) => {
                    if (res.ok && res.data) {
                      setActiveRendered(res.data.rendered)
                    }
                  })
                }
              }}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

function OutputBlockRow({
  block,
  isActive,
  onSelect,
}: {
  block: OutputBlock
  isActive: boolean
  onSelect: (block: OutputBlock) => void
}) {
  const isEp = /^ep\d+$/i.test(block.label)

  return (
    <button
      className={`flex items-center gap-2 w-full px-3 py-1.5 rounded text-xs transition-colors text-left ${
        isActive
          ? "bg-accent text-accent-foreground"
          : "hover:bg-muted/50 text-muted-foreground"
      }`}
      onClick={() => onSelect(block)}
    >
      <span
        className={`font-mono font-medium shrink-0 ${
          isEp ? "text-primary" : "text-foreground"
        }`}
      >
        {block.label}
      </span>
      <span className="truncate opacity-60">{block.note}</span>
      <span className="ml-auto text-[10px] opacity-40 shrink-0">
        {block.rendered ? `${block.rendered.length}c` : "..."}
      </span>
    </button>
  )
}
