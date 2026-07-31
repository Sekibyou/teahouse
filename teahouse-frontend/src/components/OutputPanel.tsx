import { useState, useEffect, useCallback, useMemo } from "react"
import { FileText } from "lucide-react"
import { useOutputSSE, type OutputBlock } from "@/hooks/useOutputSSE"
import { useSSERefresh } from "@/hooks/useSSERefresh"
import { outputBlocksApi } from "@/lib/api"
import { SandboxManager } from "@/components/SandboxManager"
import type { ContentType } from "@/lib/types"

interface OutputPanelProps {
  instanceId: string | undefined
  instanceName: string | undefined
  onSend?: (message: string) => void
}

/**
 * OutputPanel — 统一沙盒面板，展示导演推送到前端的输出内容。
 *
 * 核心组件：
 * - SandboxManager：统一沙盒 iframe + TeahouseBridge postMessage API
 * - 底部输出块列表：查看/选择活跃的块
 */
export function OutputPanel({ instanceId, instanceName, onSend }: OutputPanelProps) {
  const [blocks, setBlocks] = useState<OutputBlock[]>([])
  const [initialLoading, setInitialLoading] = useState(true)
  const [rulesVersion, setRulesVersion] = useState(0)

  // ---- SSE 实时更新（输出块） ----

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

  // ---- SSE 监听文件变更（text-style-rules.yaml 被导演编辑时实时生效） ----

  useSSERefresh({
    instanceId,
    instanceName,
    onFileChanged: useCallback((path: string) => {
      if (path === ".teahouse/text-style-rules.yaml") {
        setRulesVersion((v) => v + 1)
      }
    }, []),
    onWorkspaceChanged: useCallback(() => {}, []),
  })

  // ---- 首次加载：获取全部输出块摘要 ----

  useEffect(() => {
    if (!instanceId) return
    ;(async () => {
      setInitialLoading(true)
      const res = await outputBlocksApi.list(instanceId)
      if (res.ok && res.data?.blocks) {
        const initial: OutputBlock[] = res.data.blocks.map((b) => ({
          uuid: b.uuid,
          label: b.label,
          note: b.note,
          content: b.content,
          content_type: (b.content_type ?? "rich_text") as ContentType,
        }))
        setBlocks(initial)
      }
      setInitialLoading(false)
    })()
  }, [instanceId])

  // ---- 解析 ep 块 ----

  const epBlocks = useMemo(() => {
    return blocks
      .filter((b) => /^ep\d+$/i.test(b.label))
      .map((b) => {
        const num = parseInt(b.label.replace(/^ep/i, ""), 10)
        return { ...b, epNum: num }
      })
      .sort((a, b) => b.epNum - a.epNum)
  }, [blocks])

  const activeEpBlock = useMemo(() => {
    return epBlocks.length > 0 ? epBlocks[0] : null
  }, [epBlocks])

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

  const isEmpty = blocks.length === 0

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* 沙盒主要内容区域 */}
      <div className="flex-1 overflow-hidden">
        {!isEmpty && (
          <SandboxManager
            instanceId={instanceId}
            instanceName={instanceName}
            blocks={blocks}
            onSend={onSend}
            isEmpty={false}
            rulesVersion={rulesVersion}
          />
        )}
        {isEmpty && (
          <div className="flex items-center justify-center h-full text-muted-foreground">
            <div className="text-center">
              <FileText className="h-12 w-12 mx-auto mb-3 opacity-20" />
              <p className="text-sm">等待 AI 生成内容...</p>
            </div>
          </div>
        )}
      </div>

      {/* 底部 — 输出块列表（调试用，可折叠） */}
      {blocks.length > 0 && (
        <details className="border-t border-border shrink-0 max-h-[30%] overflow-auto group">
          <summary className="px-4 py-2 text-[10px] text-muted-foreground font-mono cursor-pointer hover:text-foreground select-none">
            输出块 ({blocks.length}) | ep 块 ({epBlocks.length})
            {activeEpBlock && (
              <span className="ml-2">
                | 当前: {activeEpBlock.label} ({activeEpBlock.note})
              </span>
            )}
          </summary>
          <div className="space-y-1 px-2 pb-2">
            {blocks.map((block) => (
              <OutputBlockRow
                key={block.uuid}
                block={block}
                isActive={block.uuid === activeEpBlock?.uuid}
              />
            ))}
          </div>
        </details>
      )}
    </div>
  )
}

// ---- Content type display label ----

function contentTypeLabel(ct: string): string {
  switch (ct) {
    case "bootstrap_js": return "BS"
    case "ui_js": return "UI"
    case "css": return "CSS"
    case "rich_text": return "RT"
    case "text": return "TXT"
    default: return ct.slice(0, 3).toUpperCase()
  }
}

// ---- Block list row ----

function OutputBlockRow({
  block,
  isActive,
}: {
  block: OutputBlock
  isActive: boolean
}) {
  const isEp = /^ep\d+$/i.test(block.label)
  const ct = block.content_type ?? "rich_text"
  const ctLabel = contentTypeLabel(ct)

  return (
    <div
      className={`flex items-center gap-2 w-full px-3 py-1.5 rounded text-xs transition-colors ${
        isActive
          ? "bg-accent text-accent-foreground"
          : "text-muted-foreground"
      }`}
    >
      <span
        className={`font-mono font-medium shrink-0 ${
          isEp ? "text-primary" : "text-foreground"
        }`}
      >
        {block.label}
      </span>
      <span className="truncate opacity-60">{block.note}</span>
      <span className="ml-auto text-[10px] opacity-40 shrink-0 flex items-center gap-1">
        <span>{ctLabel}</span>
        <span>{block.content ? `${block.content.length}c` : "..."}</span>
      </span>
    </div>
  )
}
