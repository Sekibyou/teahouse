import { useEffect, useState, useCallback } from "react"
import { ChevronLeft } from "lucide-react"
import { sandboxSrcApi, floorsApi, type FloorEntry } from "@/lib/api"
import { useSSERefresh } from "@/hooks/useSSERefresh"

interface SandboxFileListProps {
  instanceId: string | undefined
  instanceName: string | undefined
  /** details — 宽屏沙盒底部的折叠清单；fullscreen — 窄屏全屏面板（带返回导航栏）。 */
  variant: "details" | "fullscreen"
  onClose?: () => void
}

/**
 * SandboxFileList — 列出 .teahouse/output/ 下的沙盒代码文件与楼层文件。
 *
 * 宽屏作为沙盒底部折叠调试栏；窄屏底部折叠栏意义不大，改由右上角菜单
 * 触发，以全屏面板展示。
 */
export function SandboxFileList({ instanceId, instanceName, variant, onClose }: SandboxFileListProps) {
  const [sandboxFiles, setSandboxFiles] = useState<Record<string, string>>({})
  const [floors, setFloors] = useState<FloorEntry[]>([])
  const [refresh, setRefresh] = useState(0)

  useSSERefresh({
    instanceId,
    instanceName,
    onFileChanged: useCallback(() => setRefresh((v) => v + 1), []),
    onWorkspaceChanged: useCallback(() => setRefresh((v) => v + 1), []),
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

  if (variant === "fullscreen") {
    return (
      <div className="absolute inset-0 z-50 bg-background flex flex-col">
        <div className="relative h-10 border-b border-border flex items-center justify-center shrink-0">
          <button
            className="absolute left-2 p-2 rounded hover:bg-muted flex items-center justify-center"
            onClick={onClose}
            aria-label="返回"
          >
            <ChevronLeft className="h-5 w-5" />
          </button>
          <span className="font-semibold text-sm">文件清单</span>
          <span className="absolute right-3 text-[10px] text-muted-foreground font-mono">
            sandbox ({Object.keys(sandboxFiles).length}) | floors ({floors.length})
          </span>
        </div>
        <div className="flex-1 overflow-auto px-4 py-3 space-y-1 text-sm font-mono">
          <FileListContent sandboxFiles={sandboxFiles} floors={floors} />
        </div>
      </div>
    )
  }

  return (
    <details className="border-t border-border shrink-0 max-h-[32%] overflow-auto group">
      <summary className="px-4 py-2 text-[10px] text-muted-foreground font-mono cursor-pointer hover:text-foreground select-none">
        文件清单 | sandbox ({Object.keys(sandboxFiles).length}) | floors ({floors.length})
      </summary>
      <div className="space-y-1 px-2 pb-2 text-xs font-mono">
        <FileListContent sandboxFiles={sandboxFiles} floors={floors} />
      </div>
    </details>
  )
}

function FileListContent({
  sandboxFiles,
  floors,
}: {
  sandboxFiles: Record<string, string>
  floors: FloorEntry[]
}) {
  return (
    <>
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
    </>
  )
}
