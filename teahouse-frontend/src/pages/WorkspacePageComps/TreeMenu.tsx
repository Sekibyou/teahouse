import { useLayoutEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import {
  ClipboardCopy, ClipboardPaste, FileText, Folder, FolderOpen,
  Pencil, Plus, Scissors, Trash2, Upload,
} from "lucide-react"
import { UploadMenuItem } from "./UploadMenuItem"

// Parent directory of a frontend path ("" = root).
function parentOf(path: string) {
  const i = path.lastIndexOf("/")
  return i >= 0 ? path.slice(0, i) : ""
}

export type TreeMenuNode = { path: string; type: "file" | "directory"; name: string }

export function TreeMenu({
  treeMenu,
  clipboard,
  onNewFile,
  onNewFolder,
  onUpload,
  onCopyPath,
  onCopy,
  onCut,
  onPaste,
  onRename,
  onDelete,
  onClose,
}: {
  treeMenu: { node: TreeMenuNode; x: number; y: number }
  clipboard: { path: string; cut: boolean; type: "file" | "directory"; name: string } | null
  onNewFile: (parentPath: string) => void
  onNewFolder: (parentPath: string) => void
  onUpload: (parentPath: string, file: File) => void
  onCopyPath: (path: string) => void
  onCopy: (path: string, type: "file" | "directory", name: string) => void
  onCut: (path: string, type: "file" | "directory", name: string) => void
  onPaste: (targetParent: string) => void
  onRename: (path: string) => void
  onDelete: (path: string) => void
  onClose: () => void
}) {
  const { t } = useTranslation("workspace")
  // Real, post-layout menu height (measured once it opens). The menu content is
  // fixed per node, so the height is stable. Measuring the real box lets us pick
  // the side that shows the most buttons and cap the box to exactly the viewport.
  const [treeMenuH, setTreeMenuH] = useState(0)
  const treeMenuRef = useRef<HTMLDivElement | null>(null)
  useLayoutEffect(() => {
    setTreeMenuH(treeMenuRef.current?.getBoundingClientRect().height ?? 0)
    // Menu is fixed-position; the tree keeps scrolling underneath while it's open.
  }, [treeMenu])

  const node = treeMenu.node
  // Directory → operations land inside it; file → its parent dir.
  const opTarget = node.type === "directory" ? node.path : parentOf(node.path)
  const itemCls = "relative flex w-full cursor-default items-center gap-1.5 rounded-md px-1.5 py-2.5 text-sm outline-hidden select-none hover:bg-accent hover:text-accent-foreground"
  const disabledCls = "pointer-events-none opacity-50"

  return (
    <>
      <div className="fixed inset-0 z-[70]" onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose() }} />
      <div
        ref={treeMenuRef}
        className="fixed z-[71] min-w-48 max-w-56 rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 overflow-y-auto"
        style={
          (() => {
            // Edge-avoidance for the fixed menu. The menu is taller than the
            // viewport can show on small screens, so this measures the *real*
            // box (treeMenuH, set in a layout effect above) and both flips and
            // clamps to the side that exposes the most action items.
            const M = 8 // screen edge margin
            const M_W = 224 // ≈ max-w-56
            const x = treeMenu.x
            const y = treeMenu.y
            // Horizontal: prefer right of the finger, else flip left.
            const left = x + M_W + M <= window.innerWidth
              ? x
              : Math.max(M, x - M_W - M)
            // How tall the menu can actually be within the viewport.
            const maxH = Math.max(120, window.innerHeight - 2 * M)
            const H = Math.min(treeMenuH || 0, maxH)
            // Vertical — pick the flip that keeps the most menu visible, with
            // below-follow (menu top ~finger) preferred because action buttons
            // sit below the header title.
            const belowTop = y
            const belowVisible = Math.max(0, window.innerHeight - M - belowTop)
            const aboveTop = Math.max(M, y - H - M)
            const aboveVisible = Math.max(0, aboveTop + H - M)
            const useBelow = belowTop + H <= window.innerHeight - M
              || belowVisible > aboveVisible
            const top = useBelow ? belowTop : aboveTop
            return { top, left, maxHeight: maxH }
          })()
        }
        onContextMenu={(e) => e.preventDefault()}
      >
        <div className="pointer-events-none flex items-center gap-1.5 px-1.5 py-2 text-xs font-medium text-muted-foreground select-none">
          {node.type === "directory" ? (
            <FolderOpen className="h-3.5 w-3.5 shrink-0" />
          ) : (
            <FileText className="h-3.5 w-3.5 shrink-0" />
          )}
          <span className="truncate" title={node.path}>{node.name}</span>
        </div>
        <div className="-mx-1 mb-1 h-px bg-border" />
        <button className={itemCls} onClick={() => onNewFile(opTarget)}>
          <Plus className="h-4 w-4 shrink-0" />
          {t("create.fileTitle")}
        </button>
        <button className={itemCls} onClick={() => onNewFolder(opTarget)}>
          <Folder className="h-4 w-4 shrink-0" />
          {t("create.folderTitle")}
        </button>
        <UploadMenuItem parentPath={opTarget} className={itemCls} onUpload={onUpload}>
          <Upload className="h-4 w-4 shrink-0" />
          {t("uploadToHere")}
        </UploadMenuItem>
        <div className="-mx-1 my-1 h-px bg-border" />
        <button className={itemCls} onClick={() => onCopyPath(node.path)}>
          <ClipboardCopy className="h-4 w-4 shrink-0" />
          {t("clipboard.copyPath")}
        </button>
        <button className={itemCls} onClick={() => onCopy(node.path, node.type, node.name)}>
          <ClipboardCopy className="h-4 w-4 shrink-0" />
          {t("clipboard.copy")}
        </button>
        <button className={itemCls} onClick={() => onCut(node.path, node.type, node.name)}>
          <Scissors className="h-4 w-4 shrink-0" />
          {t("clipboard.cut")}
        </button>
        <button
          className={`${itemCls} ${!clipboard ? disabledCls : ""}`}
          disabled={!clipboard}
          onClick={() => onPaste(opTarget)}
        >
          <ClipboardPaste className="h-4 w-4 shrink-0" />
          {t("clipboard.paste")}
        </button>
        <div className="-mx-1 my-1 h-px bg-border" />
        <button className={itemCls} onClick={() => onRename(node.path)}>
          <Pencil className="h-4 w-4 shrink-0" />
          {t("rename.title")}
        </button>
        <button className={`${itemCls} text-destructive hover:bg-destructive/10 hover:text-destructive`} onClick={() => onDelete(node.path)}>
          <Trash2 className="h-4 w-4 shrink-0" />
          {t("common:delete")}
        </button>
      </div>
    </>
  )
}
