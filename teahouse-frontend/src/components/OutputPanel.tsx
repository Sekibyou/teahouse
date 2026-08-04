import { useEffect, useState, useCallback } from "react"
import { FileText } from "lucide-react"
import { SandboxManager } from "@/components/SandboxManager"
import { sandboxSrcApi, floorsApi, type FloorEntry } from "@/lib/api"
import { useSSERefresh } from "@/hooks/useSSERefresh"

interface OutputPanelProps {
  instanceId: string | undefined
  instanceName: string | undefined
  onSend?: (message: string) => void
}

/**
 * OutputPanel — 文件系统驱动的统一沙盒面板。
 *
 * - 沙盒 iframe 由 SandboxManager 从 .teahouse/output/sandbox/ 构建，
 *   正文由沙盒运行时经 listFloors/readFile 读取。
 * - 底部提供一个稳定调试栏：无论沙盒内渲染是否成功，都列出当前
 *   沙盒代码文件与楼层文件，便于排查。
 */
export function OutputPanel({ instanceId, instanceName, onSend }: OutputPanelProps) {
  const [sandboxFiles, setSandboxFiles] = useState<Record<string, string>>({})
  const [floors, setFloors] = useState<FloorEntry[]>([])
  const [refresh, setRefresh] = useState(0)

  useSSERefresh({
    instanceId,
    instanceName,
    onFileChanged: useCallback((path: string) => {
      setRefresh((v) => v + 1)
    }, []),
    onWorkspaceChanged: useCallback(() => {
      setRefresh((v) => v + 1)
    }, []),
  })

  useEffect(() => {
    if (!instanceId) return
    let cancelled = false
    ;(async () => {
      const [s, f] = await Promise.all([
        sandboxSrcApi.get(instanceId),
        floorsApi.list(instanceId),
      ])
      if (cancelled) return
      if (s.ok && s.data) setSandboxFiles(s.data.files ?? {})
      if (f.ok && f.data) setFloors(f.data.floors ?? [])
    })()
    return () => { cancelled = true }
  }, [instanceId, refresh])

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="flex-1 overflow-hidden">
        <SandboxManager
          instanceId={instanceId}
          instanceName={instanceName}
          onSend={onSend}
        />
      </div>

      {/* 底部调试栏 — 稳定显示当前沙盒代码文件与楼层文件（与沙盒渲染无关） */}
      <details className="border-t border-border shrink-0 max-h-[32%] overflow-auto group">
        <summary className="px-4 py-2 text-[10px] text-muted-foreground font-mono cursor-pointer hover:text-foreground select-none">
          文件清单 | sandbox ({Object.keys(sandboxFiles).length}) | floors ({floors.length})
        </summary>
        <div className="space-y-1 px-2 pb-2 text-xs font-mono">
          <div className="opacity-60">.teahouse/output/sandbox/</div>
          {Object.keys(sandboxFiles).length === 0 && (
            <div className="pl-3 opacity-40">（无沙盒代码）</div>
          )}
          {Object.keys(sandboxFiles).map((k) => (
            <div key={k} className="pl-3">{k}</div>
          ))}
          <div className="opacity-60 pt-1">.teahouse/output/floors/</div>
          {floors.length === 0 && (
            <div className="pl-3 opacity-40">（无楼层）</div>
          )}
          {floors.map((f) => (
            <div key={f.num} className="pl-3">
              {f.path} <span className="opacity-50">({f.draft ? "草稿" : "正式"})</span>
            </div>
          ))}
        </div>
      </details>
    </div>
  )
}
