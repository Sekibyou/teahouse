import { useMemo, useRef } from "react"
import { useTranslation } from "react-i18next"
import {
  ChevronDown, ChevronRight, FileText, Folder, FolderOpen,
  ClipboardCopy, ClipboardPaste, Scissors,
} from "lucide-react"
import {
  ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSeparator,
} from "@/components/ui/context-menu"
import type { FileTreeNode } from "@/lib/types"

// ---- File tree recursive component ----

export function FileTreeView({
  nodes, expanded, selectedFile, onToggle, onSelect,
  onCreateFile, onCreateFolder, onDelete, onRename, onUpload, fileStatuses, depth = 0, isMobile = false,
  isDragging = false, dropTargetPath = null, dragSource = null,
  clipboard = null, cutSource = null, onCopyPath, onCopy, onCut, onPaste,
  dragWasActiveRef, onOpenTreeMenu, menuNodePath,
}: {
  nodes: FileTreeNode[]
  expanded: Set<string>
  selectedFile: string | null
  onToggle: (path: string) => void
  onSelect: (path: string) => void
  onCreateFile: (parentPath: string) => void
  onCreateFolder: (parentPath: string) => void
  onDelete: (path: string) => void
  onRename: (path: string) => void
  onUpload: (parentPath: string) => void
  fileStatuses: Map<string, string>
  depth?: number
  isMobile?: boolean
  isDragging?: boolean
  dropTargetPath?: string | null
  dragSource?: string | null
  clipboard?: { path: string; cut: boolean; type: "file" | "directory"; name: string } | null
  cutSource?: string | null
  onCopyPath?: (path: string) => void
  onCopy?: (path: string, type: "file" | "directory", name: string) => void
  onCut?: (path: string, type: "file" | "directory", name: string) => void
  onPaste?: (targetParent: string) => void
  dragWasActiveRef?: React.MutableRefObject<boolean>
  onOpenTreeMenu?: (node: { path: string; type: "file" | "directory"; name: string }, x: number, y: number) => void
  menuNodePath?: string | null
}) {
  const { t } = useTranslation("workspace")
  // Parent directory of a frontend path ("" = root).
  const dirOf = (p: string) => {
    const i = p.lastIndexOf("/")
    return i >= 0 ? p.slice(0, i) : ""
  }
  const stColor = (st: string | undefined) => {
    if (!st) return "text-muted-foreground"
    const m: Record<string, string> = {
      "M": "text-amber-600 dark:text-amber-400",
      "A": "text-green-600 dark:text-green-400",
      "?": "text-green-600 dark:text-green-400",
      "D": "text-red-600 dark:text-red-400",
      "R": "text-purple-600 dark:text-purple-400",
    }
    return m[st] || "text-muted-foreground"
  }
  // VSCode 惯例：目录自身无改动，仅因内部(任意层级)有新建/修改而被着色时，用
  // 更浅的 "soft" 色，让目录变色弱于真正的文件改动、不再误读成目录本身被改。
  const softColor = (st: string | undefined) => {
    if (!st) return ""
    const m: Record<string, string> = {
      "M": "text-amber-400/80 dark:text-amber-300/70",
      "A": "text-green-400/80 dark:text-green-300/70",
      "?": "text-green-400/80 dark:text-green-300/70",
      "D": "text-red-400/80 dark:text-red-300/70",
      "R": "text-purple-400/80 dark:text-purple-300/70",
    }
    return m[st] || ""
  }
  // "X" 标记"目录本身无改动、仅因内部有变动而被标亮"，区别于真实的新建/删除。
  const stLetter = (st: string | undefined) => {
    if (!st) return ""
    const m: Record<string, string> = { "M": "M", "D": "D", "R": "R", "A": "A", "?": "U" }
    return m[st] || ""
  }
  // 目录内部有改动时右缘的小圆点(实心背景)。用半透明的淡色，与目录"浅色"呼应。
  const dotBg = (st: string | undefined) => {
    if (!st) return ""
    const m: Record<string, string> = {
      "M": "bg-amber-400/60 dark:bg-amber-300/50",
      "A": "bg-green-400/60 dark:bg-green-300/50",
      "?": "bg-green-400/60 dark:bg-green-300/50",
      "D": "bg-red-400/60 dark:bg-red-300/50",
      "R": "bg-purple-400/60 dark:bg-purple-300/50",
    }
    return m[st] || ""
  }
  // 目录汇总：对每个"已改动文件"路径，把它每一个祖先目录标成"内部有改动"。
  // 节点 path 都是前端形态("root/..."），故 dirChanges 的 key 也用 "root/<dir>"，
  // 与树节点 node.path 精确匹配。归类优先级：新建/未跟踪 > 删除 > 修改/重命名，
  // 让文件夹的浅色/圈点反映子树里"最抢眼"的变动。
  const dirChanges = useMemo(() => {
    const rank: Record<string, number> = { "A": 3, "?": 3, "D": 2, "M": 1, "R": 1 }
    const inner = new Map<string, string>()
    for (const p of fileStatuses.keys()) {
      const segs = p.split("/").filter(Boolean) // ["root", "runtime", "floors", "file.md"]
      const rel = segs.slice(1)                 // 去掉 "root"
      if (rel.length < 2) continue              // 顶层文件没有祖先目录可标
      const st = fileStatuses.get(p) ?? ""
      for (let i = 0; i < rel.length - 1; i++) {
        const dir = "root/" + rel.slice(0, i + 1).join("/")
        const prev = inner.get(dir)
        if (!prev || (rank[st] ?? 0) > (rank[prev] ?? 0)) inner.set(dir, st)
      }
    }
    return inner
  }, [fileStatuses])

  // ---- Mobile long-press on a row opens the per-node menu (no ⋯ button).
  // Managed per component instance: a level's rows share one pointer sequence,
  // so the timer/flag live here rather than bubbling to the parent.
  const mobilePressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mobilePressConsumedRef = useRef(false)
  const mobilePressPosRef = useRef<{ x: number; y: number } | null>(null)
  const mobilePressNodeRef = useRef<{ path: string; type: "file" | "directory"; name: string } | null>(null)
  const cancelMobilePress = () => {
    if (mobilePressTimerRef.current) { clearTimeout(mobilePressTimerRef.current); mobilePressTimerRef.current = null }
    mobilePressPosRef.current = null
    mobilePressNodeRef.current = null
  }
  // Long-press only applies on mobile; desktop rows go through the ContextMenu.
  // `node` is bound per row at render time (this level renders many rows).
  const onMobileRowPointerDown = isMobile
    ? (e: React.PointerEvent<HTMLDivElement>, onNode: { path: string; type: "file" | "directory"; name: string }) => {
        // Let the user scroll/tap normally without fighting the app for the gesture.
        mobilePressConsumedRef.current = false
        mobilePressPosRef.current = { x: e.clientX, y: e.clientY }
        mobilePressNodeRef.current = onNode
        if (mobilePressTimerRef.current) clearTimeout(mobilePressTimerRef.current)
        mobilePressTimerRef.current = setTimeout(() => {
          mobilePressTimerRef.current = null
          const pos = mobilePressPosRef.current
          const held = mobilePressNodeRef.current
          if (!pos || !held) return
          // A long-press is complete → open the menu and swallow the click the
          // browser will synthesize on release, so the row doesn't also toggle/select.
          mobilePressConsumedRef.current = true
          onOpenTreeMenu?.(held, pos.x, pos.y)
        }, 450)
      }
    : undefined

  return (
    <>
      {nodes
        .filter(n => n.name !== ".git")
        .map((node) => {
          // 节点自身 git 状态(仅文件命中；目录只有当后端恰好报该目录路径才可能命中)。
          const selfSt = fileStatuses.get(node.path)
          // 目录"内部(任意层级)有改动"的归类；文件节点无此概念。
          const dirInner = node.type === "directory" ? dirChanges.get(node.path) : undefined
          // 节点着色主状态：目录优先用自身状态(真改动)；否则若仅内部有改动则用浅色。
          const isDirInnerOnly = node.type === "directory" && !selfSt && !!dirInner
          const colored = isDirInnerOnly ? softColor(dirInner) : stColor(selfSt)
        return (
        <div
          key={node.path}
          className={
            isDragging && node.type === "directory" && dropTargetPath === node.path
              ? "relative rounded-md bg-accent/30 ring-2 ring-inset ring-accent mx-1 my-0.5"
              : ""
          }
        >
          {isMobile ? (
            /* 移动端：无 ⋯ 按钮，长按 item 弹 treeMenu（onMobileRowPointerDown）。 */
            <div
              data-path={node.path}
              data-type={node.type}
              className={`flex items-center gap-1 px-2 cursor-pointer transition-colors group select-none py-3 ${
                menuNodePath === node.path ? "bg-accent" : selectedFile === node.path ? "bg-accent" : ""
              } ${
                isDragging ? "" : ""
              } ${
                isDragging && dragSource === node.path ? "opacity-40" : ""
              } ${
                cutSource === node.path ? "opacity-40" : ""
              }`}
              style={{ paddingLeft: `${8 + depth * 16}px` }}
              onPointerDown={(e) => onMobileRowPointerDown?.(e, { path: node.path, type: node.type, name: node.name })}
              onPointerUp={cancelMobilePress}
              onPointerLeave={cancelMobilePress}
              onPointerCancel={cancelMobilePress}
              onContextMenu={(e) => e.preventDefault()}
              onClick={() => {
                // Consume a completed drag's once-set flag so its release can't
                // toggle/select the node under the release point.  (Cleared by the
                // click that follows a completed drag; clearDrag is the fallback.)
                if (dragWasActiveRef?.current) { dragWasActiveRef.current = false; return }
                // Swallow the click a long-press synthesizes on release — the
                // menu is already open, don't also toggle/select the row.
                if (mobilePressConsumedRef.current) { mobilePressConsumedRef.current = false; return }
                if (node.type === "directory") {
                  onToggle(node.path)
                } else {
                  onSelect(node.path)
                }
              }}
            >
              {node.type === "directory" ? (
                <>
                  <span className="shrink-0">
                    {expanded.has(node.path) ? (
                      <ChevronDown className="h-3 w-3" />
                    ) : (
                      <ChevronRight className="h-3 w-3" />
                    )}
                  </span>
                  {(() => {
                    const Icon = expanded.has(node.path) ? FolderOpen : Folder
                    return <Icon className={`h-4 w-4 shrink-0 ${colored}`} />
                  })()}
                </>
              ) : (
                <>
                  <span className="w-3 shrink-0" />
                  <FileText className={`h-4 w-4 shrink-0 ${colored}`} />
                </>
              )}
              <span className={`flex-1 truncate text-sm ${colored}`}>{node.name}</span>
              {/* 行末指示：文件 -> 修改类型字母；目录(仅内部有改动) -> 小圈点 */}
              {node.type === "file" ? (
                stLetter(selfSt) ? (
                  <span className={`shrink-0 pl-1 text-[10px] font-semibold leading-none ${stColor(selfSt)}`}>
                    {stLetter(selfSt)}
                  </span>
                ) : null
              ) : isDirInnerOnly ? (
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dotBg(dirInner)}`} />
              ) : null}
            </div>
          ) : (
            /* 桌面端：右键菜单替代 hover 按钮。ContextMenuTrigger 经 render 注入
               data-path/data-type（桌面拖拽依赖），行 click 选中/折叠不变。 */
            <ContextMenu disabled={isDragging}>
              <ContextMenuTrigger
                render={
                  <div
                    data-path={node.path}
                    data-type={node.type}
                    className={`flex items-center gap-1 px-2 cursor-pointer transition-colors group select-none py-1 ${
                      selectedFile === node.path ? "bg-accent" : ""
                    } ${
                      isDragging ? "" : "hover:bg-muted/50"
                    } ${
                      isDragging && dragSource === node.path ? "opacity-40" : ""
                    } ${
                      cutSource === node.path ? "opacity-40" : ""
                    }`}
                    style={{ paddingLeft: `${8 + depth * 16}px` }}
                    onClick={() => {
                      if (node.type === "directory") {
                        onToggle(node.path)
                      } else {
                        onSelect(node.path)
                      }
                    }}
                  />
                }
              >
                {node.type === "directory" ? (
                  <>
                    <span className="shrink-0">
                      {expanded.has(node.path) ? (
                        <ChevronDown className="h-3 w-3" />
                      ) : (
                        <ChevronRight className="h-3 w-3" />
                      )}
                    </span>
                    {(() => {
                      const Icon = expanded.has(node.path) ? FolderOpen : Folder
                      return <Icon className={`h-4 w-4 shrink-0 ${colored}`} />
                    })()}
                  </>
                ) : (
                  <>
                    <span className="w-3 shrink-0" />
                    <FileText className={`h-4 w-4 shrink-0 ${colored}`} />
                  </>
                )}
                <span className={`flex-1 truncate text-sm ${colored}`}>{node.name}</span>
                {/* 行末指示：文件 -> 修改类型字母；目录(仅内部有改动) -> 小圈点 */}
                {node.type === "file" ? (
                  stLetter(selfSt) ? (
                    <span className={`shrink-0 pl-1 text-[10px] font-semibold leading-none ${stColor(selfSt)}`}>
                      {stLetter(selfSt)}
                    </span>
                  ) : null
                ) : isDirInnerOnly ? (
                  <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dotBg(dirInner)}`} />
                ) : null}
              </ContextMenuTrigger>

              <ContextMenuContent side="right" align="start" alignOffset={4}>
                {/* 新建/上传作用于：目录→目录内，文件→同级目录 */}
                {(() => {
                  const opTarget = node.type === "directory" ? node.path : dirOf(node.path)
                  return <>
                    <ContextMenuItem onClick={() => onCreateFile(opTarget)}>
                      {t("create.fileTitle")}
                    </ContextMenuItem>
                    <ContextMenuItem onClick={() => onCreateFolder(opTarget)}>
                      {t("create.folderTitle")}
                    </ContextMenuItem>
                    <ContextMenuItem onClick={() => onUpload(opTarget)}>
                      {t("uploadToHere")}
                    </ContextMenuItem>
                    <ContextMenuSeparator />
                    <ContextMenuItem onClick={() => onCopyPath?.(node.path)}>
                      <ClipboardCopy className="h-3.5 w-3.5" />
                      {t("clipboard.copyPath")}
                    </ContextMenuItem>
                    <ContextMenuItem onClick={() => onCopy?.(node.path, node.type, node.name)}>
                      <ClipboardCopy className="h-3.5 w-3.5" />
                      {t("clipboard.copy")}
                    </ContextMenuItem>
                    <ContextMenuItem onClick={() => onCut?.(node.path, node.type, node.name)}>
                      <Scissors className="h-3.5 w-3.5" />
                      {t("clipboard.cut")}
                    </ContextMenuItem>
                    <ContextMenuItem disabled={!clipboard} onClick={() => onPaste?.(opTarget)}>
                      <ClipboardPaste className="h-3.5 w-3.5" />
                      {t("clipboard.paste")}
                    </ContextMenuItem>
                    <ContextMenuSeparator />
                    <ContextMenuItem onClick={() => onRename(node.path)}>
                      {t("rename.title")}
                    </ContextMenuItem>
                    <ContextMenuItem variant="destructive" onClick={() => onDelete(node.path)}>
                      {t("common:delete")}
                    </ContextMenuItem>
                  </>
                })()}
              </ContextMenuContent>
            </ContextMenu>
          )}

          {/* Children */}
          {node.type === "directory" && expanded.has(node.path) && node.children && (
            <FileTreeView
              nodes={node.children}
              expanded={expanded}
              selectedFile={selectedFile}
              onToggle={onToggle}
              onSelect={onSelect}
              onCreateFile={onCreateFile}
              onCreateFolder={onCreateFolder}
              onDelete={onDelete}
              onRename={onRename}
              onUpload={onUpload}
              fileStatuses={fileStatuses}
              depth={depth + 1}
              isMobile={isMobile}
              isDragging={isDragging}
              dropTargetPath={dropTargetPath}
              dragSource={dragSource}
              clipboard={clipboard}
              cutSource={cutSource}
              onCopyPath={onCopyPath}
              onCopy={onCopy}
              onCut={onCut}
              onPaste={onPaste}
              dragWasActiveRef={dragWasActiveRef}
              onOpenTreeMenu={onOpenTreeMenu}
              menuNodePath={menuNodePath}
            />
            )}
          </div>
          )
        })}
    </>
  )
}
