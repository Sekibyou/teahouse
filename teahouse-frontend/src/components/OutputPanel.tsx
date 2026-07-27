import { useState, useEffect, useCallback, useMemo, useRef } from "react"
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
 * 根据 content_type 走不同渲染路径：
 * - text/markdown（默认）→ ReactMarkdown 渲染
 * - text/plain → <pre> 保留换行
 * - text/html → 沙盒 iframe dangerouslySetInnerHTML
 * - application/javascript → 沙盒 iframe <script> 执行
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
        const initial = res.data.blocks.map((b) => ({
          uuid: b.uuid,
          label: b.label,
          note: b.note,
          rendered: "",
          content_type: "text/markdown" as const,
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
      .sort((a, b) => b.epNum - a.epNum)
    return eps
  }, [blocks])

  // ---- 当前活跃 ep（最高编号） ----
  const activeEpBlock = useMemo(() => {
    return epBlocks.length > 0 ? epBlocks[0] : null
  }, [epBlocks])

  // ---- 首次加载时获取最高 ep 块的正文 ----
  const [activeRendered, setActiveRendered] = useState<string | null>(null)
  const [activeContentType, setActiveContentType] = useState<string>("text/markdown")
  const [activeEpLoading, setActiveEpLoading] = useState(false)

  useEffect(() => {
    if (!instanceId || !activeEpBlock) return
    if (activeEpBlock.rendered) {
      setActiveRendered(activeEpBlock.rendered)
      setActiveContentType(activeEpBlock.content_type || "text/markdown")
      return
    }
    ;(async () => {
      setActiveEpLoading(true)
      const res = await outputBlocksApi.get(instanceId, activeEpBlock.uuid)
      if (res.ok && res.data) {
        setActiveRendered(res.data.rendered)
        setActiveContentType(res.data.content_type || "text/markdown")
      }
      setActiveEpLoading(false)
    })()
  }, [instanceId, activeEpBlock?.uuid])

  // SSE replace 更新时同步刷新
  useEffect(() => {
    if (activeEpBlock?.rendered) {
      setActiveRendered(activeEpBlock.rendered)
      setActiveContentType(activeEpBlock.content_type || "text/markdown")
    }
  }, [activeEpBlock?.rendered])

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
          <ContentRenderer content={activeRendered} contentType={activeContentType} />
        ) : (
          <div className="flex items-center justify-center h-full text-muted-foreground">
            <p className="text-sm">暂无正文内容</p>
          </div>
        )}
      </div>

      {/* 底部 — 输出块列表 */}
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
                  setActiveContentType(b.content_type || "text/markdown")
                } else if (instanceId) {
                  outputBlocksApi.get(instanceId, b.uuid).then((res) => {
                    if (res.ok && res.data) {
                      setActiveRendered(res.data.rendered)
                      setActiveContentType(res.data.content_type || "text/markdown")
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

// ---- Content renderer — dispatches on content_type ----

function ContentRenderer({ content, contentType }: { content: string; contentType: string }) {
  if (contentType === "text/html") {
    return <HtmlSandbox html={content} />
  }
  if (contentType === "application/javascript") {
    return <JsSandbox script={content} />
  }
  if (contentType === "text/plain") {
    return <pre className="text-sm whitespace-pre-wrap font-sans">{content}</pre>
  }
  // default: text/markdown
  return (
    <div className="prose prose-sm dark:prose-invert prose-chat max-w-none">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>
        {content}
      </ReactMarkdown>
    </div>
  )
}

// ---- Sandbox renderers ----

function HtmlSandbox({ html }: { html: string }) {
  return (
    <iframe
      className="w-full min-h-[200px] border-0 rounded bg-white dark:bg-neutral-900"
      sandbox="allow-scripts"
      srcDoc={html}
      title="HTML sandbox"
    />
  )
}

function JsSandbox({ script }: { script: string }) {
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    container.innerHTML = ""
    const iframe = document.createElement("iframe")
    iframe.style.cssText = "width:100%;min-height:200px;border:none;border-radius:0;background:transparent;"
    iframe.sandbox.add("allow-scripts")
    iframe.srcdoc = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><script>${script}</script></body></html>`
    container.appendChild(iframe)
  }, [script])

  return <div ref={containerRef} />
}

// ---- Block list row ----

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
  const ct = block.content_type || "text/markdown"
  const ctLabel =
    ct === "text/html" ? "HTML" :
    ct === "application/javascript" ? "JS" :
    ct === "text/plain" ? "TXT" : "MD"

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
      <span className="ml-auto text-[10px] opacity-40 shrink-0 flex items-center gap-1">
        <span>{ctLabel}</span>
        <span>{block.rendered ? `${block.rendered.length}c` : "..."}</span>
      </span>
    </button>
  )
}
