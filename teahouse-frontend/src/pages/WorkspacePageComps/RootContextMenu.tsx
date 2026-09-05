import { useTranslation } from "react-i18next"
import { UploadMenuItem } from "./UploadMenuItem"

export function RootContextMenu({
  x,
  y,
  clipboard,
  onNewFile,
  onNewFolder,
  onUpload,
  onPaste,
  onClose,
}: {
  x: number
  y: number
  clipboard: { path: string; cut: boolean; type: "file" | "directory"; name: string } | null
  onNewFile: () => void
  onNewFolder: () => void
  onUpload: (parentPath: string, file: File) => void
  onPaste: () => void
  onClose: () => void
}) {
  const { t } = useTranslation("workspace")
  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose() }} />
      <div
        className="fixed z-50 min-w-40 rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10"
        style={{ left: x, top: y }}
        onContextMenu={(e) => e.preventDefault()}
      >
        <button
          className="relative flex w-full cursor-default items-center gap-1.5 rounded-md px-1.5 py-1 text-sm outline-hidden select-none"
          onClick={onNewFile}
        >
          {t("create.fileTitle")}
        </button>
        <button
          className="relative flex w-full cursor-default items-center gap-1.5 rounded-md px-1.5 py-1 text-sm outline-hidden select-none"
          onClick={onNewFolder}
        >
          {t("create.folderTitle")}
        </button>
        <UploadMenuItem
          parentPath=""
          className="relative flex w-full cursor-default items-center gap-1.5 rounded-md px-1.5 py-1 text-sm outline-hidden select-none"
          onUpload={onUpload}
        >
          {t("uploadToRoot")}
        </UploadMenuItem>
        <div className="-mx-1 my-1 h-px bg-border" />
        <button
          className={`relative flex w-full cursor-default items-center gap-1.5 rounded-md px-1.5 py-1 text-sm outline-hidden select-none ${!clipboard ? "pointer-events-none opacity-50" : ""}`}
          disabled={!clipboard}
          onClick={onPaste}
        >
          {t("clipboard.paste")}
        </button>
      </div>
    </>
  )
}
