import { useEffect, useState, useCallback } from "react"
import { ChevronRight } from "lucide-react"
import { sandboxSrcApi, floorsApi, type FloorEntry } from "@/lib/api"
import { useSSERefresh } from "@/hooks/useSSERefresh"
import { useDialogBackClose } from "@/hooks/useDialogBackClose"
import { useIsMobile } from "@/hooks/useMediaQuery"
import { useTranslation } from "react-i18next"

interface SandboxFileListProps {
  instanceId: string | undefined
  instanceName: string | undefined
  /** details — 宽屏沙盒底部的折叠清单；fullscreen — 窄屏全屏面板（带返回导航栏）。 */
  variant: "details" | "fullscreen"
  /** fullscreen 由父层常驻渲染、以此控制显隐，支持进出动画（仅移动端生效）。 */
  open?: boolean
  onClose?: () => void
}

/**
 * SandboxFileList — 列出 runtime/sandbox/ 下的沙盒代码文件与 runtime/floors/ 下的楼层文件。
 *
 * 宽屏作为沙盒底部折叠调试栏；窄屏底部折叠栏意义不大，改由右上角菜单
 * 触发，以全屏面板展示。
 */
export function SandboxFileList({ instanceId, instanceName, variant, open = true, onClose }: SandboxFileListProps) {
  const { t } = useTranslation("misc")
  const isMobile = useIsMobile()
  // fullscreen 两阶段进出：open 切 false 时先保留 DOM 播从右滑出再真正关闭
  const [closing, setClosing] = useState(false)
  const FILE_LIST_ANIM_MS = 220
  const requestClose = useCallback(() => {
    if (!onClose) return
    if (isMobile && variant === "fullscreen") {
      setClosing((wasClosing) => {
        if (wasClosing) return true
        window.setTimeout(() => {
          setClosing(false)
          onClose()
        }, FILE_LIST_ANIM_MS)
        return true
      })
    } else {
      onClose()
    }
  }, [isMobile, variant, onClose])
  useDialogBackClose(open && variant === "fullscreen", requestClose)
  const [sandboxFiles, setSandboxFiles] = useState<Record<string, string>>({})
  const [floors, setFloors] = useState<FloorEntry[]>([])
  const [refresh, setRefresh] = useState(0)

  useSSERefresh({
    instanceId,
    instanceName,
    // Only reload when a change lands in the two dirs this list shows
    // (runtime/sandbox/ or runtime/floors/). Changes elsewhere (teahouse.md,
    // settings/, a vars write, …) don't affect what this panel renders. The
    // path arrives backend-bare; the list's file keys are bare too.
    onFileChanged: useCallback((path: string) => {
      const isRelevant =
        path !== undefined && path !== null && path !== "" &&
        (path.startsWith("runtime/sandbox/") || path.startsWith("runtime/floors/") ||
         path === "runtime/sandbox" || path === "runtime/floors")
      // Only a change under the two dirs this panel shows reloads it; anything
      // else (teahouse.md, settings/, a vars write, …) doesn't affect the list.
      if (isRelevant) setRefresh((v) => v + 1)
    }, []),
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
    // 父层常驻渲染 fullscreen 面板；!open 且非离场动画中才真正不渲染
    if (!open && !closing) return null
    const statSub = `sandbox (${Object.keys(sandboxFiles).length}) · floors (${floors.length})`
    return (
      <div
        className={`absolute inset-0 z-50 bg-background flex flex-col ${
          closing
            ? "animate-out slide-out-to-right duration-[220ms] fill-mode-forwards"
            : "animate-in slide-in-from-right duration-[220ms]"
        }`}
      >
        <div className="flex items-center gap-2 px-3 h-11 border-b border-border shrink-0">
          {/* 左：标题 + 统计副标题 同一行 */}
          <span className="font-semibold text-base shrink-0">{t("sandboxFileList.fileList")}</span>
          <span className="text-[10px] text-muted-foreground font-mono truncate min-w-0">{statSub}</span>
          {/* 右上：折叠（右箭头）关闭 */}
          <button
            className="ml-auto p-2 rounded hover:bg-muted text-muted-foreground flex items-center justify-center shrink-0"
            onClick={requestClose}
            aria-label={t("common:back")}
          >
            <ChevronRight className="h-5 w-5" />
          </button>
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
        {t("sandboxFileList.fileListSummary", { sandbox: Object.keys(sandboxFiles).length, floors: floors.length })}
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
  const { t } = useTranslation("misc")
  return (
    <>
      <div className="opacity-60">runtime/sandbox/</div>
      {Object.keys(sandboxFiles).length === 0 && (
        <div className="pl-3 opacity-40">{t("sandboxFileList.noSandboxCode")}</div>
      )}
      {Object.keys(sandboxFiles).map((k) => (
        <div key={k} className="pl-3">{k}</div>
      ))}
      <div className="opacity-60 pt-1">runtime/floors/</div>
      {floors.length === 0 && (
        <div className="pl-3 opacity-40">{t("sandboxFileList.noFloors")}</div>
      )}
      {floors.map((f) => (
        <div key={f.num} className="pl-3">
          {f.path} <span className="opacity-50">({f.draft ? t("sandboxFileList.draft") : t("sandboxFileList.official")})</span>
        </div>
      ))}
    </>
  )
}
