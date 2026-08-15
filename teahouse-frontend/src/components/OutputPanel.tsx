import { SandboxManager } from "@/components/SandboxManager"
import { SandboxFileList } from "@/components/SandboxFileList"
import { useIsMobile } from "@/hooks/useMediaQuery"

interface OutputPanelProps {
  instanceId: string | undefined
  instanceName: string | undefined
  onSend?: (message: string) => void
  /** 沙盒唤起导演栏（折叠时打开），透传给 SandboxManager。 */
  onOpenDirector?: () => void
}

/**
 * OutputPanel — 文件系统驱动的统一沙盒面板。
 *
 * - 沙盒 iframe 由 SandboxManager 从 .teahouse/output/sandbox/ 构建，
 *   正文由沙盒运行时经 listFloors/readFile 读取。
 * - 宽屏底部提供一个稳定调试栏（文件清单）；窄屏底部折叠栏意义不大，
 *   改由右上角菜单以全屏面板触发，此处不再渲染。
 */
export function OutputPanel({ instanceId, instanceName, onSend, onOpenDirector }: OutputPanelProps) {
  const isMobile = useIsMobile()

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="flex-1 overflow-hidden">
        <SandboxManager
          instanceId={instanceId}
          instanceName={instanceName}
          onSend={onSend}
          onOpenDirector={onOpenDirector}
        />
      </div>

      {!isMobile && (
        <SandboxFileList
          instanceId={instanceId}
          instanceName={instanceName}
          variant="details"
        />
      )}
    </div>
  )
}
