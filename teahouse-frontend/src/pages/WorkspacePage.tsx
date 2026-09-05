import { useEffect, useLayoutEffect, useState, useCallback, useRef, useMemo } from "react"
import { useTranslation } from "react-i18next"
import { useNavigate, useOutletContext } from "react-router-dom"
import { MonacoEditor } from "@/components/MonacoEditor"
import { MarkdownRenderer } from "@/components/MarkdownRenderer"
import {
  File, Folder, Loader2,
  Save, FileText,
  PanelLeftOpen, GripVertical, Archive,
  FolderTree, Menu, X, Gamepad2, Wrench,
  Eye, Code2,
} from "lucide-react"
import { useCurrentLang, useLangStore } from "@/i18n/config"
import { Button } from "@/components/ui/button"
import { instancesApi, gitApi, toFrontendPath, toBackendPath, ROOT } from "@/lib/api"
import { useSessionStore } from "@/stores/sessionStore"
import { useViewModeStore } from "@/stores/viewModeStore"
import { useGitStore } from "@/stores/gitStore"
import { useSettingsDialogStore } from "@/stores/settingsDialogStore"
import { useAuth, isAdminRole } from "@/stores/authStore"
import { ChatPanel } from "@/components/ChatPanel"
import { OutputPanel } from "@/components/OutputPanel"
import { SandboxFileList } from "@/components/SandboxFileList"
import { ConfirmDialog } from "@/components/ConfirmDialog"
import { GitDialog } from "@/components/GitDialog"
import { toast } from "sonner"
import { useWorkspaceRefresh } from "@/hooks/useWorkspaceRefresh"
import { useSSERefresh } from "@/hooks/useSSERefresh"
import { useIsMobile } from "@/hooks/useMediaQuery"
import { useDialogBackClose } from "@/hooks/useDialogBackClose"
import type { FileTreeNode, TreeNodeRef, TreeClipboard, UndoableOp, TrashItem } from "@/lib/types"
import { applyFileChange } from "@/lib/fileTreeReducer"
import { collectAllEntries, pruneNestedItems, isEditableTarget } from "@/lib/fileTreeOps"
import { FileTreeView } from "./WorkspacePageComps/FileTreeView"
import { CreateDialog } from "./WorkspacePageComps/CreateDialog"
import { RenameDialog } from "./WorkspacePageComps/RenameDialog"
import { RootContextMenu } from "./WorkspacePageComps/RootContextMenu"
import { MobileMenuDropdown } from "./WorkspacePageComps/MobileMenuDropdown"
import { TreeMenu } from "./WorkspacePageComps/TreeMenu"
import { ExportDialog, type ExportDialogHandle } from "./WorkspacePageComps/ExportDialog"

// Monaco Editor theme follows system dark mode — handled by MonacoEditor component

export function WorkspacePage() {
  const { t } = useTranslation("workspace")
  const currentLang = useCurrentLang()
  const setLang = useLangStore((s) => s.setLang)
  const navigate = useNavigate()
  const activeInstance = useSessionStore((s) => s.activeInstance)
  const setActiveInstance = useSessionStore((s) => s.setActiveInstance)
  const mode = useViewModeStore((s) => s.mode)
  const chatWidth = useViewModeStore((s) => s.chatWidth)
  const chatCollapsed = useViewModeStore((s) => s.chatCollapsed)
  const setChatCollapsed = useViewModeStore((s) => s.setChatCollapsed)
  const setChatWidth = useViewModeStore((s) => s.setChatWidth)
  const isMobile = useIsMobile()
  const { toggleTheme } = useOutletContext<{ isMobile: boolean; toggleTheme: () => void }>()
  const openSettings = useSettingsDialogStore((s) => s.openSettings)
  const { user: currentUser } = useAuth()

  // Mobile state
  const [showFileTree, setShowFileTree] = useState(false)
  const [showMobileMenu, setShowMobileMenu] = useState(false)
  const [fullscreenPanel, setFullscreenPanel] = useState<"director" | "git" | "files" | null>(null)
  useDialogBackClose(fullscreenPanel === "director", () => setFullscreenPanel(null))
  const [isDark, setIsDark] = useState(() => {
    const saved = localStorage.getItem("theme")
    return saved ? saved === "dark" : true
  })

  const handleToggleTheme = () => {
    setIsDark(!isDark)
    document.documentElement.classList.toggle("dark", !isDark)
    localStorage.setItem("theme", isDark ? "light" : "dark")
    if (toggleTheme) toggleTheme()
  }

  const [fileTree, setFileTree] = useState<FileTreeNode[]>([])
  // Current tree mirrored into a ref so SSE event handlers (which close over the
  // value at effect-setup time) can read the latest tree synchronously for
  // reducer-driven partial updates. loadFileTree / applyFileChange both keep it
  // in sync.
  const fileTreeRef = useRef<FileTreeNode[]>([])
  const syncFileTree = useCallback((next: FileTreeNode[]) => {
    fileTreeRef.current = next
    setFileTree(next)
  }, [])
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [isImageOpen, setIsImageOpen] = useState(false)
  const [imageDataUri, setImageDataUri] = useState<string | null>(null)
  const [imageMeta, setImageMeta] = useState<{ w: number; h: number } | null>(null)
  const [fileContent, setFileContent] = useState("")
  const [editedContent, setEditedContent] = useState("")
  const [isDirty, setIsDirty] = useState(false)
  // 外部刷新当前文件时自增，触发 Monaco 按 key 重挂载（defaultValue 仅在 mount 读取）
  const [editorEpoch, setEditorEpoch] = useState(0)
  // .md 文件可在代码编辑器与 Markdown 预览间切换
  const [editorView, setEditorView] = useState<"code" | "preview">("code")
  const [isLoading, setIsLoading] = useState(true)
  const initialLoadRef = useRef(true)
  // 文件加载/重载请求序号，丢弃过期响应（快速连点不同文件防串号）
  const loadSeqRef = useRef(0)
  const [isSaving, setIsSaving] = useState(false)
  const [saveToast, setSaveToast] = useState<boolean>(false)
  const saveToastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const saveToastRef = useRef<HTMLSpanElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const uploadPathRef = useRef<string>("")

  // ---- File-tree drag & drop (desktop only, pointer-events driven) ----
  const [dragInfo, setDragInfo] = useState<{ srcPath: string; srcType: "file" | "directory"; name: string } | null>(null)
  const [dropTargetPath, setDropTargetPath] = useState<string | null>(null)
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const dragArmedRef = useRef(false)
  const dragSrcRef = useRef<{ path: string; type: "file" | "directory"; name: string } | null>(null)
  const dragPosRef = useRef<{ x: number; y: number } | null>(null)
  const dragBadgeRef = useRef<HTMLDivElement | null>(null)
  const dropTargetRef = useRef<string | null>(null)
  const moveInFlightRef = useRef(false)
  // "Current active tree container" — desktop sidebar or mobile overlay, whichever
  // is mounted right now (isMobile is session-locked, so only one holds it).
  const dragContainerEl = useRef<HTMLDivElement | null>(null)
  // Set once a long-press arms a move; consumed (cleared) once by the row onClick
  // so a pointer release can't synthesize a toggle/select after a real drag.
  const dragWasActiveRef = useRef(false)

  // ---- Clipboard for copy / cut / paste (ContextMenu on the file tree) ----
  // Multi-entry: `items` may hold several copied/cut paths (multi-select).
  // Paths are the frontend root/... form; the backend-relative path is derived
  // via toBackendPath() at use time.
  const [clipboard, setClipboard] = useState<TreeClipboard>(null)
  // 树选中集：独立于 selectedFile(正在打开编辑的文件)，可单可多，目录/文件皆可选。
  const [selection, setSelection] = useState<TreeNodeRef[]>([])
  const selectionPaths = useMemo(() => new Set(selection.map(s => s.path)), [selection])
  const selectionRef = useRef(selection)
  selectionRef.current = selection
  // Blank-area right-click menu (root operations). Positioned at the cursor.
  const [rootMenu, setRootMenu] = useState<{ x: number; y: number } | null>(null)
  // Mobile per-node "⋯" menu (fixed-position, rootMenu-style). Positioned at the icon.
  const [treeMenu, setTreeMenu] = useState<{ node: { path: string; type: "file" | "directory"; name: string }; x: number; y: number } | null>(null)
  // System-file drag-in (from OS file manager) in progress. target = dir it
  // will land in (a directory path, or ROOT for the empty area). Only desktop.
  const [externalDrop, setExternalDrop] = useState<{ target: string } | null>(null)
  const clearDrag = useCallback(() => {
    if (longPressTimerRef.current) { clearTimeout(longPressTimerRef.current); longPressTimerRef.current = null }
    dragArmedRef.current = false
    dragWasActiveRef.current = false
    dragSrcRef.current = null
    dragPosRef.current = null
    dragBadgeRef.current = null
    dropTargetRef.current = null
    // Always restore scrollability — even if no drag was armed — so no code path
    // can leave the tree permanently locked to touch-action:none.
    if (dragContainerEl.current) dragContainerEl.current.style.touchAction = ""
    setDragInfo(null)
    setDropTargetPath(null)
  }, [])

  // Convert an instance-relative path to its parent directory path ("" = root).
  const parentOf = useCallback((path: string) => {
    const i = path.lastIndexOf("/")
    return i >= 0 ? path.slice(0, i) : ""
  }, [])

  const showSaveToast = useCallback(() => {
    setSaveToast(true)
    saveToastTimer.current = setTimeout(() => {
      const el = saveToastRef.current
      if (el) {
        el.style.transition = "opacity 500ms ease-out"
        el.style.opacity = "0"
        saveToastTimer.current = setTimeout(() => {
          setSaveToast(false)
        }, 500)
      }
    }, 1500)
  }, [])
  // Track whether the file content has finished loading

  const [showCreate, setShowCreate] = useState<{ parentPath: string; type: "file" | "directory" } | null>(null)
  const [createName, setCreateName] = useState("")

  // Rename / delete
  const [deleteTargets, setDeleteTargets] = useState<TreeNodeRef[]>([])
  const [renameTarget, setRenameTarget] = useState<string | null>(null)
  const [renameName, setRenameName] = useState("")

  // Export prototype / skill / package dialog（自治组件，见 ExportDialog）
  const [showExportDialog, setShowExportDialog] = useState(false)
  const exportDialogRef = useRef<ExportDialogHandle>(null)
  // System back closes the mobile file-tree drawer and the export panel one level
  // at a time (nested with director above), instead of jumping straight home.
  useDialogBackClose(showFileTree, () => setShowFileTree(false))
  useDialogBackClose(showExportDialog, () => setShowExportDialog(false))

  const instId = activeInstance?.id

  // 当前文件是否为 Markdown（决定是否显示预览切换）
  const isMarkdown = !!selectedFile?.endsWith(".md")

  // 图片扩展名判定——此类文件不进入文本编辑器，改为在工作区直接渲染 <img>
  const IMAGE_EXTS = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".avif"]
  const isImageFile = (p: string | null | undefined) => {
    if (!p) return false
    const lower = p.toLowerCase()
    return IMAGE_EXTS.some((ext) => lower.endsWith(ext))
  }

  // 进入 workspace 时按视口设置默认模式：移动端默认游玩，宽屏默认后台。
  // 用 ref 仅在首次挂载（进入）时生效，不随用户后续切换或窗口 resize 覆盖。
  const defaultModeAppliedRef = useRef(false)
  if (!defaultModeAppliedRef.current) {
    defaultModeAppliedRef.current = true
    useViewModeStore.getState().setMode(isMobile ? "play" : "backstage")
  }

  // 沙盒唤起导演栏：移动端切到全屏导演面板，桌面端展开折叠的 ChatPanel。
  const openDirector = useCallback(() => {
    if (isMobile) setFullscreenPanel("director")
    else setChatCollapsed(false)
  }, [isMobile])

  // Git state — file statuses for tree coloring from unified store. The store
  // keys ARE bare backend paths; map them to "root/..." so they match tree nodes.
  const fileStatuses = useGitStore((s) => s.fileStatuses)
  const fileStatusesRoot = useMemo(() => {
    const m = new Map<string, string>()
    for (const [k, v] of fileStatuses) m.set(toFrontendPath(k), v)
    return m
  }, [fileStatuses])

  // Redirect if no active instance
  useEffect(() => {
    if (!activeInstance) {
      navigate("/", { replace: true })
    }
  }, [activeInstance, navigate])

  // Load file tree
  const loadFileTree = useCallback(async (showSpinner = false) => {
    if (!instId) return
    if (showSpinner) setIsLoading(true)
    const res = await instancesApi.listFiles(instId)
    if (res.ok) {
      syncFileTree(res.data || [])
    }
    if (showSpinner) setIsLoading(false)
  }, [instId, syncFileTree])

  useEffect(() => {
    loadFileTree(initialLoadRef.current)
    if (initialLoadRef.current) initialLoadRef.current = false
    if (instId) {
      useGitStore.getState().fetchGitStatus(instId)
    }
  }, [loadFileTree])

  // Diff content from git HEAD (null = new file → treat as empty for diff)
  const [gitHeadContent, setGitHeadContent] = useState<string | null>(null)

  // File content is loaded by `openFile` (load-first + key remount). Reset the
  // editor state whenever the instance changes. Entering an instance also clears
  // its recycle bin (backend) + the undo/redo stacks (frontend) — undo lives
  // only for the current active session (single frontend link).
  useEffect(() => {
    setSelectedFile(null)
    setIsImageOpen(false)
    setImageDataUri(null)
    setImageMeta(null)
    setFileContent("")
    setEditedContent("")
    setGitHeadContent("")
    setIsDirty(false)
    setEditorView("code")
    setRootMenu(null)
    setClipboard(null)
    setExternalDrop(null)
    setSelection([])
    setDeleteTargets([])
    if (instId) {
      clearUndoStacks()
      instancesApi.clearTrash(instId) // fire-and-forget; 失败静默
    }
  }, [instId])

  // Esc closes the blank-area root context menu / mobile per-node menu.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && rootMenu) setRootMenu(null)
      if (e.key === "Escape" && treeMenu) setTreeMenu(null)
    }
    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [rootMenu, treeMenu])

  // Ctrl+S to save
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault()
        if (isDirty && selectedFile !== null) {
          handleSave()
        }
      }
    }
    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [isDirty, selectedFile, editedContent, instId])

  // Apply a structural change from a local operation optimistically to the tree.
  // Falls back to a full reload when the reducer can't reconcile (missing parent
  // — e.g. creating under a dir not yet in the tree). The backend echoes a
  // file_changed back for the same op; because the tree is already converged,
  // that echo becomes an idempotent no-op in applyFileChange, so we don't double
  // refresh. Git status is refetched here (one source of truth for the op).
  const handleSave = async () => {
    if (!instId || selectedFile === null) return
    setIsSaving(true)
    const res = await instancesApi.writeFile(instId, selectedFile, editedContent)
    if (res.ok) {
      setFileContent(editedContent)
      setIsDirty(false)
      if (instId) useGitStore.getState().fetchGitStatus(instId)
      showSaveToast()
    }
    setIsSaving(false)
  }

  const handleCreateEntry = async () => {
    if (!instId || !showCreate || !createName.trim()) return
    const fullPath = showCreate.parentPath
      ? `${showCreate.parentPath}/${createName.trim()}`
      : createName.trim()
    const nodeType = showCreate.type
    const res = await instancesApi.createEntry(instId, fullPath, nodeType)
    if (!res.ok) return
    setShowCreate(null)
    setCreateName("")
    applyLocalStructural({ type: "created", path: fullPath, nodeType })
    pushUndo({
      undo: async () => {
        const rr = await instancesApi.deleteEntry(instId!, fullPath)
        if (!rr.ok) return
        closeEditorFor(fullPath)
        await refresh()
      },
      redo: async () => {
        const rr = await instancesApi.createEntry(instId!, fullPath, nodeType)
        if (!rr.ok) return
        await refresh()
      },
    })
  }

  // 右键单节点删除：若该节点已在 selection 内则作用整个 selection，否则收敛单选。
  const handleDeleteEntry = (node: TreeNodeRef) => {
    const inSel = selectionRef.current.some(s => s.path === node.path)
    const targets = inSel ? pruneNestedItems(selectionRef.current) : [node]
    if (!inSel) setSelection([node])
    beginDelete(targets)
  }

  // 打开多选删除确认。targets 传前会先收敛 selection 为这些项。
  const beginDelete = (targets: TreeNodeRef[]) => {
    const pruned = pruneNestedItems(targets)
    if (!pruned.length) return
    setDeleteTargets(pruned)
  }

  const confirmDelete = async () => {
    if (!instId || !deleteTargets.length) return
    const targets = pruneNestedItems(deleteTargets)
    setDeleteTargets([])

    // 把整批删除收成一个 undoable op：逐个 trash（记录 ref），undo=顺序 restore。
    // delete op 跨 undo/redo 时后端引用会变（每次 trash 生成新 ref），故用可变容器
    // liveRefs 保存"当前代"的引用，undo 消费后清、redo 重新 trash 后更新。
    const liveRefs: { items: TrashItem[] } = { items: [] }
    for (const it of targets) {
      const path = it.path
      const res = await instancesApi.trashEntry(instId, path)
      if (!res.ok) continue
      liveRefs.items.push({ trash_ref: res.data!.trash_ref, original_path: res.data!.original_path })
      closeEditorFor(path)
      applyLocalStructural({ type: "deleted", path })
    }
    if (liveRefs.items.length) {
      dropFromSelection(targets.map(t => t.path))
      pushUndo({
        undo: async () => {
          for (const r of [...liveRefs.items].reverse()) {
            const rr = await instancesApi.restoreEntry(instId!, r.trash_ref)
            if (!rr.ok) continue
            closeEditorFor(r.original_path)
          }
          liveRefs.items = []
          await refresh()
        },
        redo: async () => {
          const fresh: TrashItem[] = []
          for (const it of targets) {
            const res = await instancesApi.trashEntry(instId!, it.path)
            if (!res.ok) continue
            fresh.push({ trash_ref: res.data!.trash_ref, original_path: res.data!.original_path })
            closeEditorFor(it.path)
          }
          liveRefs.items = fresh
          await refresh()
        },
      })
    }
  }

  const handleRenameEntry = (path: string) => {
    setRenameTarget(path)
    setRenameName(path.split("/").pop() || "")
  }

  const confirmRename = async () => {
    if (!instId || !renameTarget) return
    const oldPath = renameTarget
    const newName = renameName.trim()
    setRenameTarget(null)
    setRenameName("")
    if (!newName || newName === oldPath.split("/").pop()) return
    const res = await instancesApi.renameEntry(instId, oldPath, newName)
    if (!res.ok) return
    const parent = oldPath.includes("/") ? oldPath.slice(0, oldPath.lastIndexOf("/")) : ""
    const newPath = parent ? `${parent}/${newName}` : newName
    // Remap the open file if it is the renamed entry or lives under a renamed directory
    if (selectedFile === oldPath || selectedFile?.startsWith(oldPath + "/")) {
      setSelectedFile(
        selectedFile === oldPath ? newPath : newPath + selectedFile!.slice(oldPath.length),
      )
    }
    applyLocalStructural({ type: "moved", path: newPath, prevPath: oldPath })
    pushUndo({
      undo: async () => {
        const rr = await instancesApi.renameEntry(instId!, newPath, oldPath.split("/").pop()!)
        if (!rr.ok) return
        if (selectedFileRef.current === newPath || selectedFileRef.current?.startsWith(newPath + "/")) {
          const cur = selectedFileRef.current
          setSelectedFile(cur === newPath ? oldPath : oldPath + cur.slice(newPath.length))
        }
        await refresh()
      },
      redo: async () => {
        const rr = await instancesApi.renameEntry(instId!, oldPath, newName)
        if (!rr.ok) return
        if (selectedFileRef.current === oldPath || selectedFileRef.current?.startsWith(oldPath + "/")) {
          const cur = selectedFileRef.current
          setSelectedFile(cur === oldPath ? newPath : newPath + cur.slice(oldPath.length))
        }
        await refresh()
      },
    })
  }

  // 共享顶层 input 的上传路径（FileTreeView 内部点位仍走这里）：记下目标目录并 .click()。
  // 此路径的 input 在文档流顶层、点击时不移除 trigger，安卓可正常弹 picker。
  const handleUploadClick = (parentPath: string) => {
    uploadPathRef.current = parentPath
    fileInputRef.current?.click()
  }

  // 真正发文件。被共享顶层 input（走 uploadPathRef）与各菜单点位的原生 input 调用。
  const doUpload = async (dir: string, file: File) => {
    if (!instId) return
    const fullPath = dir ? `${dir}/${file.name}` : file.name
    const res = await instancesApi.uploadFile(instId, fullPath, file)
    if (!res.ok) return // 由 API 返回错误文案；此处静默（错误可在网络面板查看）
    applyLocalStructural({ type: "created", path: fullPath, nodeType: "file" })
    pushUndo(uploadOp(fullPath, file))
  }

  // 菜单点位的上传（label→原生 input，直接参与用户手势，不经 .click() 转跳：
  // 安卓在 fixed 浮层里 .click() 会被系统静默拦截，label 原生关联可正常弹 picker）。
  const handleMenuUpload = (parentPath: string, file: File) => {
    setTreeMenu(null)
    setRootMenu(null)
    doUpload(parentPath, file)
  }

  const handleUploadChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = "" // 允许重复选择同一文件
    // 选完文件（无论是否上传成功）才关浮层菜单 —— 点击时不能卸载，否则安卓中断 picker
    setTreeMenu(null)
    setRootMenu(null)
    if (!instId || !file) return
    doUpload(uploadPathRef.current, file)
  }

  // OS file-manager drop → upload each file into `dir` ("" = root).
  const handleFileDrop = async (files: File[], dir: string) => {
    if (!instId) return
    let okCount = 0
    const failNames: string[] = []
    const uploaded: { fullPath: string; file: File }[] = []
    for (const f of files) {
      const fullPath = dir ? `${dir}/${f.name}` : f.name
      const res = await instancesApi.uploadFile(instId, fullPath, f)
      if (res.ok) { okCount++; uploaded.push({ fullPath, file: f }) }
      else failNames.push(f.name)
    }
    await refresh()
    for (const { fullPath, file } of uploaded) {
      pushUndo(uploadOp(fullPath, file))
    }
    if (okCount > 0) toast.success(t("dropUpload.done", { count: okCount }))
    if (failNames.length) toast.error(t("dropUpload.fail", { names: failNames.join(", ") }))
  }


  // Keep a ref for latest selectedFile so callbacks always have current value
  const selectedFileRef = useRef(selectedFile)
  selectedFileRef.current = selectedFile

  // Keep a ref for isDirty so SSE callback can check without depending on state
  const isDirtyRef = useRef(isDirty)
  isDirtyRef.current = isDirty

  // Keep refs for the loaded baseline + git HEAD so async reloads can compare
  // against current state without taking a dependency on them.
  const fileContentRef = useRef(fileContent)
  fileContentRef.current = fileContent
  const gitHeadContentRef = useRef(gitHeadContent)
  gitHeadContentRef.current = gitHeadContent
  const imageDataUriRef = useRef(imageDataUri)
  imageDataUriRef.current = imageDataUri

  // Load a file (content + git HEAD) then open it. Loads first so Monaco mounts
  // once with the correct defaultValue and a clean undo stack.
  const openFile = useCallback(async (path: string) => {
    if (!instId || path === selectedFileRef.current) return
    const seq = ++loadSeqRef.current

    // 图片文件走 readAsset 渲染，不经历文本加载/脏标记/编辑器挂载
    if (isImageFile(path)) {
      const [assetRes] = await Promise.all([
        instancesApi.readAsset(instId, path),
        gitApi.showFile(instId, path).catch(() => ({ ok: false as const })),
      ])
      if (seq !== loadSeqRef.current) return // stale response
      if (!assetRes.ok) return // file gone; keep current selection
      setIsImageOpen(true)
      setImageDataUri(`data:${assetRes.data!.mime};base64,${assetRes.data!.data}`)
      setImageMeta(assetRes.data!.size ? { w: assetRes.data!.size[0], h: assetRes.data!.size[1] } : null)
      setFileContent("")
      setEditedContent("")
      setGitHeadContent("")
      setIsDirty(false)
      setEditorView("code")
      setSelectedFile(path)
      setSelection([{ path, type: "file", name: path.split("/").pop() || path }])
      return
    }

    const [fileRes, headRes] = await Promise.all([
      instancesApi.readText(instId, path),
      gitApi.showFile(instId, path),
    ])
    if (seq !== loadSeqRef.current) return // stale response
    if (!fileRes.ok) return // file gone; keep current selection
    setIsImageOpen(false)
    setFileContent(fileRes.data!.content)
    setEditedContent(fileRes.data!.content)
    setGitHeadContent(headRes.ok && headRes.data?.content != null ? headRes.data.content : "")
    setIsDirty(false)
    setEditorView("code")
    setSelectedFile(path)
    setSelection([{ path, type: "file", name: path.split("/").pop() || path }])
  }, [instId])

  // Reload the open file from disk (external change). Remounts only when content
  // or git HEAD actually changed, so unrelated git commits don't reset the editor.
  const reloadOpenFile = useCallback(async () => {
    if (!instId) return
    const path = selectedFileRef.current
    if (!path) return
    const seq = ++loadSeqRef.current

    // 图片：外部变更时重拉资产刷新显示
    if (isImageFile(path)) {
      const res = await instancesApi.readAsset(instId, path)
      if (seq !== loadSeqRef.current) return
      if (!res.ok) {
        setSelectedFile(null)
        setIsImageOpen(false)
        setImageDataUri(null)
        setImageMeta(null)
        return
      }
      const nextUri = `data:${res.data!.mime};base64,${res.data!.data}`
      if (nextUri === imageDataUriRef.current) return
      setImageDataUri(nextUri)
      setImageMeta(res.data!.size ? { w: res.data!.size[0], h: res.data!.size[1] } : null)
      return
    }

    const [fileRes, headRes] = await Promise.all([
      instancesApi.readText(instId, path),
      gitApi.showFile(instId, path),
    ])
    if (seq !== loadSeqRef.current) return
    if (!fileRes.ok) {
      setSelectedFile(null)
      setFileContent("")
      setEditedContent("")
      setGitHeadContent("")
      setIsDirty(false)
      return
    }
    const content = fileRes.data!.content
    const head = headRes.ok && headRes.data?.content != null ? headRes.data.content : ""
    if (content === fileContentRef.current && head === gitHeadContentRef.current) return
    setIsImageOpen(false)
    setFileContent(content)
    setEditedContent(content)
    setGitHeadContent(head)
    setIsDirty(false)
    setEditorEpoch((e) => e + 1)
  }, [instId])

  // Unified refresh hook
  const refresh = useWorkspaceRefresh({ instId, loadFileTree })

  // Apply a structural change from a local operation optimistically to the tree.
  // Falls back to a full reload when the reducer can't reconcile (missing parent
  // — e.g. creating under a dir not yet in the tree). The backend echoes a
  // file_changed back for the same op; because the tree is already converged,
  // that echo becomes an idempotent no-op in applyFileChange, so we don't double
  // refresh. Git status is refetched here (one source of truth for the op).
  const applyLocalStructural = useCallback((change: {
    type: "created" | "deleted" | "moved"
    path: string
    prevPath?: string
    nodeType?: "file" | "directory"
  }) => {
    const next = applyFileChange(fileTreeRef.current, change)
    if (next === null) {
      refresh()
      return
    }
    if (next !== fileTreeRef.current) syncFileTree(next)
    if (instId) useGitStore.getState().fetchGitStatus(instId)
  }, [instId, refresh, syncFileTree])

  // ---- File-operation undo/redo stacks (VSCode Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y) ----
  // 命令式：每个 op 携带 undo/redo 闭包，覆盖新建/删除/重命名/移动/复制/上传。
  // 文本内容编辑的撤销不在此——由 Monaco/textarea 内置，焦点在编辑器时让位。
  // 栈只存 ref（键盘 handler 同步读，无 UI 需渲染），未来加 undo 按钮再上 state。
  const undoStackRef = useRef<UndoableOp[]>([])
  const redoStackRef = useRef<UndoableOp[]>([])
  const MAX_UNDO = 100

  const clearUndoStacks = useCallback(() => {
    undoStackRef.current = []
    redoStackRef.current = []
  }, [])

  // 压栈：清空 redo（新正向操作使重做失效），超限丢最旧。
  const pushUndo = useCallback((op: UndoableOp) => {
    undoStackRef.current = [...undoStackRef.current, op].slice(-MAX_UNDO)
    redoStackRef.current = []
  }, [])

  // 撤销/重做都只在 api 成功后弹栈（失败保留栈顶可重试），每次经 applyLocalStructural
  // 收敛树。runUndo 弹 undoStackRef 顶，执行 undo，成功后挪到 redoStackRef。
  const runUndo = useCallback(async () => {
    const stack = undoStackRef.current
    if (!instId || !stack.length) return
    const op = stack[stack.length - 1]
    try {
      await op.undo()
    } catch {
      return // 保留栈顶，允许重试
    }
    undoStackRef.current = stack.slice(0, -1)
    redoStackRef.current = [...redoStackRef.current, op]
  }, [instId])

  const runRedo = useCallback(async () => {
    const stack = redoStackRef.current
    if (!instId || !stack.length) return
    const op = stack[stack.length - 1]
    try {
      await op.redo()
    } catch {
      return
    }
    redoStackRef.current = stack.slice(0, -1)
    undoStackRef.current = [...undoStackRef.current, op]
  }, [instId])

  // 若 path 是被删除/撤销移除的文件（或含其目录），则清空编辑器。
  const closeEditorFor = useCallback((path: string) => {
    const open = selectedFileRef.current
    if (open && (open === path || open.startsWith(path + "/"))) {
      setSelectedFile(null)
      setIsImageOpen(false)
      setImageDataUri(null)
      setImageMeta(null)
      setFileContent("")
      setEditedContent("")
      setIsDirty(false)
    }
  }, [])

  // 从 selection 剔除 path（撤销后该路径可能已不存在）。
  const dropFromSelection = useCallback((paths: string[]) => {
    setSelection(prev => prev.filter(s => !paths.some(p => s.path === p || s.path.startsWith(p + "/"))))
  }, [])

  // 上传的撤销/重做：undo=删产物；redo=闭包捕获原 File 重传。
  const uploadOp = useCallback((fullPath: string, file: File): UndoableOp => ({
    undo: async () => {
      const rr = await instancesApi.deleteEntry(instId!, fullPath)
      if (!rr.ok) return
      closeEditorFor(fullPath)
      await refresh()
    },
    redo: async () => {
      const rr = await instancesApi.uploadFile(instId!, fullPath, file)
      if (!rr.ok) return
      await refresh()
    },
  }), [instId, closeEditorFor, refresh])

  // ---- File-tree drag & drop: commit + event handlers (desktop only) ----
  const commitMove = useCallback(async (srcPath: string, destParent: string) => {
    if (!instId || moveInFlightRef.current) return
    moveInFlightRef.current = true
    try {
      const res = await instancesApi.moveEntry(instId, srcPath, destParent)
      if (!res.ok) return
      // Remap the open file if it is the moved entry or lives under the moved entry.
      if (selectedFile === srcPath || selectedFile?.startsWith(srcPath + "/")) {
        const base = srcPath.split("/").pop() ?? srcPath
        setSelectedFile(destParent ? `${destParent}/${base}` : base)
      }
      await refresh()
      // drag&drop 移动可撤销：undo 移回原父目录。
      const fromParent = parentOf(srcPath)
      pushUndo({
        undo: async () => {
          const rr = await instancesApi.moveEntry(instId!, srcPath, fromParent)
          if (!rr.ok) return
          await refresh()
        },
        redo: async () => {
          const rr = await instancesApi.moveEntry(instId!, srcPath, destParent)
          if (!rr.ok) return
          await refresh()
        },
      })
    } finally {
      moveInFlightRef.current = false
    }
  }, [instId, selectedFile, refresh, parentOf, pushUndo])

  // ---- Clipboard operations: copy path / copy / cut / paste ----
  const copyPathEntry = useCallback(async (path: string) => {
    try {
      await navigator.clipboard.writeText(toBackendPath(path))
      toast.success(t("clipboard.copiedPath"))
    } catch {
      toast.error(t("common:failed"))
    }
  }, [t])

  const copyEntry = useCallback((items: TreeNodeRef[]) => {
    const pruned = pruneNestedItems(items)
    if (!pruned.length) return
    setClipboard({ items: pruned, cut: false })
    if (pruned.length === 1) toast.success(t("clipboard.copied", { name: pruned[0].name }))
    else toast.success(t("clipboard.copiedMany", { count: pruned.length }))
  }, [t])

  const cutEntry = useCallback((items: TreeNodeRef[]) => {
    const pruned = pruneNestedItems(items)
    if (!pruned.length) return
    setClipboard({ items: pruned, cut: true })
    if (pruned.length === 1) toast.success(t("clipboard.cutActive", { name: pruned[0].name }))
    else toast.success(t("clipboard.cutActiveMany", { count: pruned.length }))
  }, [t])

  // 右键单节点复制/剪切：若该节点已在 selection 内则作用整个 selection，
  // 否则收敛为单选再作用于该节点（VSCode 右键语义）。
  const copyFromNode = useCallback((node: TreeNodeRef) => {
    const inSel = selectionRef.current.some(s => s.path === node.path)
    const items = inSel ? pruneNestedItems(selectionRef.current) : [node]
    if (!inSel) setSelection([node])
    copyEntry(items)
  }, [copyEntry])

  const cutFromNode = useCallback((node: TreeNodeRef) => {
    const inSel = selectionRef.current.some(s => s.path === node.path)
    const items = inSel ? pruneNestedItems(selectionRef.current) : [node]
    if (!inSel) setSelection([node])
    cutEntry(items)
  }, [cutEntry])

  // Check whether a frontend path already exists anywhere in the tree.
  const pathExists = useCallback((nodes: FileTreeNode[], path: string): boolean => {
    for (const n of nodes) {
      if (n.path === path) return true
      if (n.children && pathExists(n.children, path)) return true
    }
    return false
  }, [])

  // Return a unique path under `targetParent` for a wanted `name`, appending
  // " (copy)", " (copy 2)" … on collision, so pasting never overwrites.
  const uniquePath = useCallback((targetParent: string, name: string): string => {
    const raw = targetParent ? `${targetParent}/${name}` : name
    if (!pathExists(fileTree, raw)) return raw
    const suffix = t("clipboard.copySuffix")
    let i = 1
    for (;;) {
      const base = name.replace(/(\.[^.]+)$/, "")
      const ext = name.match(/(\.[^.]+)$/)?.[1] ?? ""
      const tryName = i === 1 ? `${base}${suffix}${ext}` : `${base}${suffix} ${i}${ext}`
      const tryPath = targetParent ? `${targetParent}/${tryName}` : tryName
      if (!pathExists(fileTree, tryPath)) return tryPath
      i++
    }
  }, [fileTree, pathExists, t])

  // 把一个条目复制进 `targetParent` 父目录；目标名按 uniquePath 去重防覆盖。
  // 若 targetParent 落在源目录自身内（原地复制自己的目录 → 想产出同级 copy），
  // 回退到源所在的父目录做 sibling 复制，对齐 VSCode"在自身位置复制"语义。
  // 返回后端实际生成的路径（copyEntry 响应权威），供 undo 精确删产物。
  const copyOneInto = useCallback(async (src: TreeNodeRef, targetParent: string): Promise<{ ok: boolean; path: string }> => {
    if (!instId) return { ok: false, path: "" }
    const inSelf = targetParent === src.path || targetParent.startsWith(src.path + "/")
    const realTarget = inSelf ? parentOf(src.path) : targetParent
    const dest = uniquePath(realTarget, src.name)
    const res = await instancesApi.copyEntry(instId, src.path, realTarget, dest.split("/").pop())
    return { ok: res.ok, path: res.ok ? res.data!.path : "" }
  }, [instId, uniquePath, parentOf])

  // Paste the clipboard into `targetParent` ("" = root). cut → move each item
  // in; copy → duplicate each into the target. Multi-item via iterate.
  const pasteEntry = useCallback(async (targetParent: string) => {
    if (!clipboard || !instId) return
    const clip = clipboard
    const target = targetParent
    const items = pruneNestedItems(clip.items)
    if (!items.length) return

    if (clip.cut) {
      // Refuse to move a folder into its own subtree (same rule as drag & drop).
      for (const it of items) {
        if (target === it.path || target.startsWith(it.path + "/")) {
          toast.error(t("common:failed"))
          return
        }
      }
      for (const it of items) {
        if (parentOf(it.path) === target) continue // already there
        const srcPath = it.path
        const fromParent = parentOf(srcPath)
        const res = await instancesApi.moveEntry(instId, srcPath, target)
        if (!res.ok) { toast.error(res.error || t("common:failed")); continue }
        // Remap the open file if it is the moved entry or lives under it.
        if (selectedFile === srcPath || selectedFile?.startsWith(srcPath + "/")) {
          const base = srcPath.split("/").pop() ?? srcPath
          setSelectedFile(target ? `${target}/${base}` : base)
        }
        // cut-move undo：移回原父目录。
        pushUndo({
          undo: async () => {
            const rr = await instancesApi.moveEntry(instId!, srcPath, fromParent)
            if (!rr.ok) return
            await refresh()
          },
          redo: async () => {
            const rr = await instancesApi.moveEntry(instId!, srcPath, target)
            if (!rr.ok) return
            await refresh()
          },
        })
      }
      setClipboard(null)
      setSelection(prev => prev.filter(s => !items.some(it => it.path === s.path)))
      await refresh()
      toast.success(t("clipboard.pasted", { name: items.map(i => i.name).join(", ") }))
      return
    }

    // copy (non-destructive) — dedupe each destination name; undo removes the copy.
    for (const it of items) {
      const r = await copyOneInto(it, target)
      if (!r.ok || !r.path) continue
      const destPath = r.path
      pushUndo({
        undo: async () => {
          const rr = await instancesApi.deleteEntry(instId!, destPath)
          if (!rr.ok) return
          closeEditorFor(destPath)
          await refresh()
        },
        redo: async () => {
          const rr = await copyOneInto(it, target)
          if (!rr.ok) return
          await refresh()
        },
      })
    }
    await refresh()
    toast.success(t("clipboard.pasted", { name: items.map(i => i.name).join(", ") }))
  }, [clipboard, instId, parentOf, selectedFile, copyOneInto, pruneNestedItems, refresh, t, pushUndo, closeEditorFor])

  // Given a screen point, resolve the drop target directory ("" = root).
  // A file acts as a proxy for its parent directory (landing beside it).
  const resolveDropTarget = useCallback((x: number, y: number): string | null => {
    const hit = document.elementFromPoint(x, y)?.closest?.("[data-path]") as HTMLElement | null
    if (!hit) return null
    const p = hit.dataset.path
    if (!p) return null
    return hit.dataset.type === "directory" ? p : parentOf(p)
  }, [parentOf])

  // Snap a miss back onto the nearest row. Tree rows are block-level and sit
  // flush, but there can be a 1px seam between adjacent rows; a pointer on that
  // seam would otherwise resolve to the shared parent (or root). Probe a few px
  // around the point and fall back to whichever row is closest.
  const snapDropTarget = useCallback((x: number, y: number): string | null => {
    for (let dy = 2; dy <= 8; dy += 2) {
      for (const probeY of [y - dy, y + dy]) {
        const hit = document.elementFromPoint(x, probeY)?.closest?.("[data-path]") as HTMLElement | null
        if (!hit) continue
        const p = hit.dataset.path
        if (!p) continue
        return hit.dataset.type === "directory" ? p : parentOf(p)
      }
    }
    return null
  }, [parentOf])

  const isInvalidTarget = useCallback((dest: string, src: string) =>
    dest === src || dest.startsWith(src + "/"),
  [],)

  const onFileTreePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    // Tree drag & drop is desktop-only. Mobile moves via the ⋯ menu (cut → paste).
    if (isMobile) return
    // Mouse responds to left button only.
    if (e.button !== 0) return
    const el = (e.target as HTMLElement).closest("[data-path]") as HTMLElement | null
    if (!el) return
    const path = el.dataset.path
    const type = el.dataset.type as "file" | "directory"
    if (!path || !type) return
    // NOTE: no setPointerCapture here — it would redirect the pointer sequence's
    // synthesized click to the container and break node on-click interactions.
    dragArmedRef.current = false
    dragWasActiveRef.current = false
    dragSrcRef.current = { path, type, name: path.split("/").pop() || path }
    dragPosRef.current = { x: e.clientX, y: e.clientY }
    dropTargetRef.current = null
    if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current)
    longPressTimerRef.current = setTimeout(() => {
      longPressTimerRef.current = null
      // Long-press complete → enter dragging, even before any movement.
      dragArmedRef.current = true
      dragWasActiveRef.current = true
      const src = dragSrcRef.current!
      const pos = dragPosRef.current!
      if (pos) {
        setDragInfo({ srcPath: src.path, srcType: src.type, name: src.name })
      }
    }, 250)
  }, [isMobile])

  const onFileTreePointerMove = useCallback((e: PointerEvent) => {
    // While the long-press is still pending, moving past ~6px cancels it
    // (a normal click or fast slide should not start a drag).
    if (!dragArmedRef.current) {
      if (longPressTimerRef.current && dragPosRef.current) {
        const dx = e.clientX - dragPosRef.current.x
        const dy = e.clientY - dragPosRef.current.y
        if (dx * dx + dy * dy > 36) {
          if (longPressTimerRef.current) { clearTimeout(longPressTimerRef.current); longPressTimerRef.current = null }
          dragSrcRef.current = null
        }
      }
      return
    }
    dragPosRef.current = { x: e.clientX, y: e.clientY }
    // Move the follow badge purely through the DOM (no React re-render).
    if (dragBadgeRef.current) {
      dragBadgeRef.current.style.transform = `translate(${e.clientX + 12}px, ${e.clientY + 14}px)`
    }
    // Prevent the click the browser would otherwise synthesize after the drag
    // release (would toggle/select a node under the release point).
    if (e.cancelable) e.preventDefault()
    // Resolve the drop target. A file means "its parent directory". If the
    // pointer lands in the thin seam between adjacent rows, snap it onto the
    // nearest row; only a genuinely empty area falls through to the root.
    const hitEl = document.elementFromPoint(e.clientX, e.clientY)
    let dest = resolveDropTarget(e.clientX, e.clientY)
    if (!dest) dest = snapDropTarget(e.clientX, e.clientY)
    const container = dragContainerEl.current
    const inContainer = !!hitEl && (container === hitEl || container?.contains(hitEl))
    if (!dest && inContainer) {
      dest = ROOT
    }
    const src = dragSrcRef.current
    const final = dest && src && !isInvalidTarget(dest, src.path)
      ? dest : null
    if (final !== dropTargetRef.current) {
      dropTargetRef.current = final
      setDropTargetPath(final)
    }
  }, [resolveDropTarget, snapDropTarget, isInvalidTarget])

  const onFileTreePointerUp = useCallback(() => {
    const src = dragSrcRef.current
    const dest = dropTargetRef.current
    if (longPressTimerRef.current) { clearTimeout(longPressTimerRef.current); longPressTimerRef.current = null }
    if (dragArmedRef.current && dest && src && !isInvalidTarget(dest, src.path)) {
      commitMove(src.path, dest)
    }
    clearDrag()
  }, [isInvalidTarget, commitMove, clearDrag])

  const onFileTreePointerCancel = useCallback(() => {
    clearDrag()
  }, [clearDrag])

  // Watch pointer move/up/cancel at window scope so a drag that leaves the tree
  // container still resolves (and never corrupts the browser's click synthesis,
  // which is why we avoid setPointerCapture).
  useEffect(() => {
    window.addEventListener("pointermove", onFileTreePointerMove)
    window.addEventListener("pointerup", onFileTreePointerUp)
    window.addEventListener("pointercancel", onFileTreePointerCancel)
    return () => {
      window.removeEventListener("pointermove", onFileTreePointerMove)
      window.removeEventListener("pointerup", onFileTreePointerUp)
      window.removeEventListener("pointercancel", onFileTreePointerCancel)
    }
  }, [onFileTreePointerMove, onFileTreePointerUp, onFileTreePointerCancel])

  // When the follow badge mounts (drag starts), place it at the current pointer
  // before it would otherwise sit at left:0/top:0. Subsequent movement is driven
  // straight through the DOM in onFileTreePointerMove.
  useLayoutEffect(() => {
    if (dragInfo && dragBadgeRef.current && dragPosRef.current) {
      dragBadgeRef.current.style.transform =
        `translate(${dragPosRef.current.x + 12}px, ${dragPosRef.current.y + 14}px)`
    }
  }, [dragInfo])

  // SSE-driven refresh — backend broadcasts file_changed / workspace_changed events.
  // file_changed carries a change `type`: content edits (modified) never change
  // tree shape, so we skip the tree entirely; only structural events
  // (created/deleted/moved) update the tree — locally via the reducer when it
  // reconciles, else by a full reload as the convergence backstop.
  useSSERefresh({
    instanceId: instId,
    instanceName: activeInstance?.name,
    onFileChanged: (path: string, evt?: Record<string, unknown>) => {
      // Backend broadcasts bare relative paths; the tree/editor work in
      // "root/..." form, so normalize before comparing.
      const frontendPath = path ? toFrontendPath(path) : ""
      const currentFile = selectedFileRef.current
      const isOpen = currentFile !== null && frontendPath === currentFile

      // Apply structural changes to the tree first. modified / unknown / empty
      // path leave the tree untouched (content edits don't change shape).
      const type = evt?.type ? String(evt.type) : "modified"
      if (type === "__full_reload") {
        // Burst mixed structural + content events in a way a single event can't
        // reconstruct (e.g. mkdir + write) — reload the whole tree as the safe
        // convergence path. Editor handling below still applies to this path.
        refresh()
      } else if (type !== "modified" && frontendPath) {
        const next = applyFileChange(fileTreeRef.current, {
          type,
          path: frontendPath,
          prevPath: evt?.prev_path ? toFrontendPath(String(evt.prev_path)) : undefined,
        })
        if (next === null) {
          // Couldn't reconcile (missing parent / already gone) → reload as backstop.
          refresh()
        } else if (next !== fileTreeRef.current) {
          syncFileTree(next)
        }
      }

      // Editor handling is orthogonal to tree shape (which was already updated
      // above for structural events):
      if (!frontendPath) {
        // empty path = the changed file is the currently open one and it's dirty —
        // refresh tree + git, skip the editor so unsaved edits are preserved.
        refresh()
        return
      }
      if (isOpen && isDirtyRef.current) {
        // Open file modified externally while dirty — preserve unsaved edits.
        refresh()
        return
      }
      if (isOpen && !isDirtyRef.current) {
        // Open file (clean) changed on disk — reload content; if it was deleted
        // this clears the editor. Structural moves/deletes of a clean open file
        // land here too and are handled the same way.
        reloadOpenFile()
      }
    },
    onWorkspaceChanged: () => {
      // Full refresh: tree + git status, then reload the open file if it isn't
      // dirty (external commit / branch switch). Dirty edits are preserved.
      refresh()
      if (selectedFileRef.current && !isDirtyRef.current) {
        reloadOpenFile()
      }
    },

    // Periodic backstop: broadcasts that never fire file_changed (e.g. external
    // writes / a second tab) are caught by polling the tree structure and only
    // applying when its SHAPE changed (content edits don't alter the shape key,
    // so idle content writes no longer spray refreshes). The dirty-check lives
    // in the hook; onPollTick receives the already-fetched tree.
    pollIntervalMs: 8000,
    onPollFetch: async () => {
      const res = await instancesApi.listFiles(instId!)
      return res.ok ? (res.data ?? []) : []
    },
    onPollTick: (tree: FileTreeNode[]) => {
      syncFileTree(tree)
      if (instId) useGitStore.getState().fetchGitStatus(instId)
    },
  })

  const toggleExpand = (path: string) => {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  // ---- Tree row click (VSCode-like). Single-click selects; Ctrl toggles multi. ----
  // 单击：单选选中该节点；文件另 openFile 切编辑器。目录保留展开/折叠。
  // Ctrl+单击：把节点加/减进多选集，不进 openFile/toggle。
  const toggleSelection = useCallback((node: TreeNodeRef) => {
    setSelection(prev => {
      if (prev.some(s => s.path === node.path)) return prev.filter(s => s.path !== node.path)
      return [...prev, node]
    })
  }, [])

  const handleNodeClick = useCallback((node: TreeNodeRef, opts: { ctrl: boolean }) => {
    if (opts.ctrl) {
      toggleSelection(node)
      return
    }
    setSelection([node])
    if (node.type === "file") openFile(node.path)
    else toggleExpand(node.path)
  }, [toggleSelection, openFile, toggleExpand])

  // 焦点在编辑器时，把树选中集收敛为"编辑器当前打开的文件"单选（VSCode 语义）。
  const syncSelectionToOpenFile = useCallback(() => {
    const openPath = selectedFileRef.current
    if (!openPath) return
    setSelection([{ path: openPath, type: "file", name: openPath.split("/").pop() || openPath }])
  }, [])

  // 键盘粘贴目标锚点：selection 最后一项 → 目录则其内、文件则其父目录；空则 root。
  const pasteAnchor = useCallback((): string => {
    const sel = selectionRef.current
    if (!sel.length) return ROOT
    const last = sel[sel.length - 1]
    return last.type === "directory" ? last.path : parentOf(last.path)
  }, [parentOf])

  // 文件树键盘快捷键（VSCode 式）：Ctrl+A/C/X/V 与 Del/Backspace。
  // 焦点在编辑器/输入框时让位文本剪贴板，并把树选中集收敛为打开的文件。
  useEffect(() => {
    if (!instId) return
    const handler = (e: KeyboardEvent) => {
      // 命中那一瞬读 activeElement；可编辑区 → 让位文本剪贴板 + 同步选中。
      if (isEditableTarget(document.activeElement)) {
        syncSelectionToOpenFile()
        return
      }
      const mod = e.ctrlKey || e.metaKey
      const key = e.key.toLowerCase()
      if (e.key === "Escape") return
      // Ctrl+S 由上方 effect / Monaco action 处理，这里不抢占。
      if (mod && key === "s") return
      if (e.key === "Delete" || e.key === "Backspace") {
        const sel = selectionRef.current
        if (sel.length) { e.preventDefault(); beginDelete(sel) }
        return
      }
      if (!mod) return
      // 先判 redo（Ctrl+Shift+Z / Ctrl+Y）再判 undo（Ctrl+Z）。
      if ((key === "z" && e.shiftKey) || key === "y") {
        e.preventDefault()
        runRedo()
      } else if (key === "z") {
        e.preventDefault()
        runUndo()
      } else if (key === "a") {
        e.preventDefault()
        setSelection(collectAllEntries(fileTreeRef.current))
      } else if (key === "c") {
        const sel = pruneNestedItems(selectionRef.current)
        if (sel.length) { e.preventDefault(); copyEntry(sel) }
      } else if (key === "x") {
        const sel = pruneNestedItems(selectionRef.current)
        if (sel.length) { e.preventDefault(); cutEntry(sel) }
      } else if (key === "v") {
        e.preventDefault()
        pasteEntry(pasteAnchor())
      }
    }
    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [instId, pasteAnchor, copyEntry, cutEntry, pasteEntry, syncSelectionToOpenFile, beginDelete, runUndo, runRedo])

  // Chat panel resize via drag
  const [isDragging, setIsDragging] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  // Drag-follow badge (shared by desktop + mobile return trees). pointer-events:none
  // so it never intercepts elementFromPoint probes. Positioned via translate()
  // written straight to the DOM (dragBadgeRef) in onFileTreePointerMove.
  const dragBadgeEl = dragInfo && (
    <div
      ref={dragBadgeRef}
      className="pointer-events-none fixed left-0 top-0 z-[9999] flex items-center gap-2 rounded-md bg-blue-600/60 px-3 py-1.5 text-xs font-medium text-white shadow-lg will-change-transform"
    >
      {dragInfo.srcType === "directory"
        ? <Folder className="h-3.5 w-3.5 shrink-0" />
        : <FileText className="h-3.5 w-3.5 shrink-0" />}
      <span className="max-w-64 truncate">{dragInfo.name}</span>
    </div>
  )

  // Mobile per-node "⋯" menu — fixed-position (treeMenu-style), anchored at the
  // clicked icon. Items mirror the desktop ContextMenu on the same node.
  // Shared by desktop + mobile return trees.
  const treeMenuEl = treeMenu && (
    <TreeMenu
      treeMenu={treeMenu}
      clipboard={clipboard}
      onNewFile={(parentPath) => { setShowCreate({ parentPath, type: "file" }); setCreateName(""); setTreeMenu(null) }}
      onNewFolder={(parentPath) => { setShowCreate({ parentPath, type: "directory" }); setCreateName(""); setTreeMenu(null) }}
      onUpload={handleMenuUpload}
      onCopyPath={(path) => { copyPathEntry(path); setTreeMenu(null) }}
      onCopy={(node) => { copyFromNode(node); setTreeMenu(null) }}
      onCut={(node) => { cutFromNode(node); setTreeMenu(null) }}
      onPaste={(target) => { pasteEntry(target); setTreeMenu(null) }}
      onRename={(path) => { handleRenameEntry(path); setTreeMenu(null) }}
      onDelete={(node) => { handleDeleteEntry(node); setTreeMenu(null) }}
      onClose={() => setTreeMenu(null)}
    />
  )

  const handleDragStart = useCallback((e: React.PointerEvent) => {
    e.preventDefault()
    setIsDragging(true)
  }, [])

  useEffect(() => {
    if (!isDragging) return
    const handlePointerMove = (e: PointerEvent) => {
      if (!containerRef.current) return
      const rect = containerRef.current.getBoundingClientRect()
      const newWidthPx = rect.right - e.clientX
      const newWidthPct = (newWidthPx / rect.width) * 100
      setChatWidth(Math.min(Math.max(newWidthPct, 20), 60))
    }
    const handlePointerUp = () => setIsDragging(false)
    window.addEventListener("pointermove", handlePointerMove)
    window.addEventListener("pointerup", handlePointerUp)
    return () => {
      window.removeEventListener("pointermove", handlePointerMove)
      window.removeEventListener("pointerup", handlePointerUp)
    }
  }, [isDragging, setChatWidth])

  if (!activeInstance) return null

  // ============================================================================
  // Mobile layout
  // ============================================================================
  if (isMobile) {
    // 移动端主菜单下拉面板（游玩模式悬浮球 / 后台模式顶部栏最右共用同一份）
    const mobileMenuDropdown = (
      <MobileMenuDropdown
        mode={mode}
        isDark={isDark}
        currentLang={currentLang}
        isAdmin={isAdminRole(currentUser?.role)}
        onChangeLang={setLang}
        onToggleTheme={handleToggleTheme}
        onOpenDirector={() => { setFullscreenPanel("director"); setShowMobileMenu(false) }}
        onOpenGit={() => { setFullscreenPanel("git"); setShowMobileMenu(false) }}
        onOpenFiles={() => { setFullscreenPanel("files"); setShowMobileMenu(false) }}
        onOpenUsers={() => { openSettings("users"); setShowMobileMenu(false) }}
        onOpenSettings={() => { openSettings(); setShowMobileMenu(false) }}
        onExit={() => { setActiveInstance(null); navigate("/", { replace: true }) }}
        onClose={() => setShowMobileMenu(false)}
      />
    )
    return (
      <div className="h-full flex flex-col overflow-hidden bg-background">
        {/* Fullscreen panels */}
        {fullscreenPanel === "director" && (
          <div className="absolute inset-0 z-50 bg-background flex flex-col">
            <div className="flex-1 flex flex-col min-h-0">
              <ChatPanel
                onGitRefresh={() => refresh()}
                onClosePanel={() => setFullscreenPanel(null)}
              />
            </div>
          </div>
        )}

        {fullscreenPanel === "git" && (
          <GitDialog
            instanceId={instId!}
            open={true}
            onClose={() => setFullscreenPanel(null)}
            onRefresh={() => { refresh(); setFullscreenPanel(null) }}
          />
        )}

        {fullscreenPanel === "files" && (
          <SandboxFileList
            instanceId={instId}
            instanceName={activeInstance?.name}
            variant="fullscreen"
            onClose={() => setFullscreenPanel(null)}
          />
        )}

        {/* Main content area */}
        <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
          {mode === "play" ? (
            <OutputPanel instanceId={instId} instanceName={activeInstance?.name} onSend={(msg) => useSessionStore.getState().setPendingMessage(msg)} onOpenDirector={openDirector} />
          ) : (
            /* Backstage mode — textarea editor */
            <div className="flex-1 flex flex-col min-h-0">
              {/* 顶部栏始终显示：文件树按钮 + 文件名 + 保存 */}
              <div className="flex items-center gap-2 px-2 h-14 border-b border-border shrink-0">
                <button
                  className="p-1 rounded hover:bg-muted shrink-0"
                  onClick={() => setShowFileTree(true)}
                  title={t("fileTreeTitle")}
                >
                  <FolderTree className="h-5 w-5" />
                </button>
                <span className="flex-1 text-sm text-muted-foreground truncate">
                  {selectedFile ?? t("noFileSelected")}
                </span>
                {selectedFile && !isImageOpen && (
                  <div className="flex items-center gap-2 shrink-0">
                    {isDirty && <span className="text-xs text-orange-500">{t("unsaved")}</span>}
                    {isMarkdown && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setEditorView((v) => (v === "code" ? "preview" : "code"))}
                        className="gap-1"
                        title={editorView === "code" ? t("previewMarkdown") : t("backToCodeEdit")}
                      >
                        {editorView === "code" ? <Eye className="h-3 w-3" /> : <Code2 className="h-3 w-3" />}
                        {editorView === "code" ? t("preview") : t("code")}
                      </Button>
                    )}
                    <Button size="sm" variant="outline" onClick={handleSave} disabled={!isDirty || isSaving} className="gap-1">
                      {isSaving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
                      {t("common:save")}
                    </Button>
                  </div>
                )}
                {/* 后台模式：主菜单并入顶部栏最右侧（悬浮球仅游玩模式显示） */}
                <div className="relative shrink-0">
                  <button
                    className="px-2 py-1 rounded-full bg-primary text-primary-foreground shadow-lg flex items-center gap-1.5 text-xs font-medium active:scale-95 transition-transform"
                    onClick={() => setShowMobileMenu(!showMobileMenu)}
                    title={t("menuTitle")}
                  >
                    <Wrench className="h-3.5 w-3.5" />
                    <Menu className="h-3.5 w-3.5" />
                  </button>
                  {showMobileMenu && mobileMenuDropdown}
                </div>
              </div>
              {selectedFile ? (
                isImageOpen ? (
                  <div className="flex-1 overflow-auto flex items-start justify-center p-4">
                    <img src={imageDataUri ?? undefined} alt={selectedFile} className="max-w-full max-h-full object-contain rounded shadow-sm" />
                  </div>
                ) : isMarkdown && editorView === "preview" ? (
                  <div className="flex-1 overflow-auto">
                    <MarkdownRenderer content={editedContent} />
                  </div>
                ) : (
                  <textarea
                    className="flex-1 w-full resize-none bg-background text-foreground p-4 font-mono text-sm outline-none border-0"
                    value={editedContent}
                    onChange={(e) => { setEditedContent(e.target.value); setIsDirty(e.target.value !== fileContent) }}
                    spellCheck={false}
                  />
                )
              ) : (
                <div className="flex-1 flex items-center justify-center text-muted-foreground">
                  <div className="text-center">
                    <File className="h-12 w-12 mx-auto mb-3 opacity-20" />
                    <p className="text-sm">{t("selectFileMobileHint")}</p>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* File tree overlay (half-screen) — only in backstage mode */}
        {showFileTree && (
          <>
            <div className="fixed inset-0 bg-black/40 z-40" onClick={() => setShowFileTree(false)} />
            <div className="fixed left-0 top-0 bottom-0 w-[75%] max-w-[320px] z-50 bg-background border-r border-border flex flex-col shadow-lg">
              <div className="p-3 border-b border-border flex items-center justify-between shrink-0">
                <span className="text-sm font-semibold truncate" title={activeInstance.name}>
                  {activeInstance.name}
                </span>
                <div className="flex items-center gap-1 shrink-0">
                  <button className="p-1.5 rounded hover:bg-muted" onClick={() => exportDialogRef.current?.open("prototype")} title={t("export.titleBar")}>
                    <Archive className="h-4 w-4" />
                  </button>
                  <button className="p-1.5 rounded hover:bg-muted" onClick={() => setShowFileTree(false)}>
                    <X className="h-4 w-4" />
                  </button>
                </div>
              </div>
              <div
                className="flex-1 overflow-auto py-1 select-none"
                onContextMenu={(e) => e.preventDefault()}
              >
                {isLoading ? (
                  <div className="flex items-center justify-center py-8">
                    <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                  </div>
                ) : (
                  <FileTreeView
                    nodes={fileTree}
                    expanded={expanded}
                    selectedFile={selectedFile}
                    selectionPaths={selectionPaths}
                    onToggle={toggleExpand}
                    onRowClick={handleNodeClick}
                    onSelect={(path) => {
                      setShowFileTree(false)
                      openFile(path)
                    }}
                    onCreateFile={(parentPath) => { setShowCreate({ parentPath, type: "file" }); setCreateName("") }}
                    onCreateFolder={(parentPath) => { setShowCreate({ parentPath, type: "directory" }); setCreateName("") }}
                    onDelete={handleDeleteEntry}
                    onRename={handleRenameEntry}
                    onUpload={handleUploadClick}
                    fileStatuses={fileStatusesRoot}
                    isMobile
                    isDragging={dragInfo !== null || externalDrop !== null}
                    dropTargetPath={externalDrop ? externalDrop.target : dropTargetPath}
                    dragSource={dragInfo?.srcPath ?? null}
                    clipboard={clipboard}
                    cutSourcePaths={clipboard?.cut ? new Set(clipboard.items.map(i => i.path)) : null}
                    onCopyPath={copyPathEntry}
                    onCopy={copyFromNode}
                    onCut={cutFromNode}
                    onPaste={pasteEntry}
                    dragWasActiveRef={dragWasActiveRef}
                    onOpenTreeMenu={(node, x, y) => setTreeMenu({ node, x, y })}
                    menuNodePath={treeMenu?.node.path}
                  />
                )}
              </div>
            </div>
          </>
        )}

        {/* 右上悬浮球 — 仅游玩模式（后台模式菜单已并入顶部栏） */}
        {!fullscreenPanel && mode === "play" && (
          <div className="fixed top-3 right-3 z-30">
            <button
              className="px-3 py-2 rounded-full bg-primary text-primary-foreground shadow-lg flex items-center gap-1.5 text-xs font-medium active:scale-95 transition-transform"
              onClick={() => setShowMobileMenu(!showMobileMenu)}
            >
              <Gamepad2 className="h-3.5 w-3.5" />
              <Menu className="h-3.5 w-3.5" />
            </button>

            {showMobileMenu && mobileMenuDropdown}
          </div>
        )}

        {/* Create Dialog */}
        {showCreate && (
          <CreateDialog
            type={showCreate.type}
            parentPath={showCreate.parentPath}
            name={createName}
            onNameChange={setCreateName}
            onSubmit={handleCreateEntry}
            onCancel={() => setShowCreate(null)}
          />
        )}

        {/* Rename dialog */}
        {renameTarget && (
          <RenameDialog
            target={renameTarget}
            name={renameName}
            onNameChange={setRenameName}
            onSubmit={confirmRename}
            onCancel={() => { setRenameTarget(null); setRenameName("") }}
          />
        )}

        {/* Confirm delete dialog */}
        <ConfirmDialog
          open={deleteTargets.length > 0}
          title={t("deleteConfirm.title")}
          message={deleteTargets.length > 1
            ? t("deleteConfirm.messageMany", { count: deleteTargets.length })
            : t("deleteConfirm.message", { path: deleteTargets[0]?.path ?? "" })}
          variant="destructive"
          confirmText={t("common:delete")}
          confirmOnEnter
          onConfirm={confirmDelete}
          onCancel={() => setDeleteTargets([])}
        />

        {/* Export 对话框（移动全屏/桌面弹窗统一由 ExportDialog 自治组件渲染） */}
        <ExportDialog
          ref={exportDialogRef}
          open={showExportDialog}
          onOpenChange={setShowExportDialog}
          instId={instId}
          isMobile={isMobile}
          onSaved={showSaveToast}
        />

        {dragBadgeEl}
        {treeMenuEl}
      </div>
    )
  }

  // ============================================================================
  // Desktop layout
  // ============================================================================
  return (
    <div ref={containerRef} className="h-full flex overflow-hidden">
      {/* 顶层 file input：display:none 形式在安卓已验证可弹（供 FileTreeView 点位经
          handleUploadClick 触发）；浮层菜单点位不走这里，改用 label→原生 input。 */}
      <input
        id="instance-file-upload"
        ref={fileInputRef}
        type="file"
        className="hidden"
        tabIndex={-1}
        onChange={handleUploadChange}
      />
      {dragBadgeEl}

      {/* Left/center area — file tree + editor (backstage) OR output panel (play).
          Both are always mounted to keep SSE connections alive; hidden via CSS. */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Backstage — file tree + editor */}
        <div className={`flex-1 flex overflow-hidden ${mode === "backstage" ? "" : "hidden"}`}>
          {/* File tree sidebar */}
          <aside className="w-64 border-r border-border shrink-0 flex flex-col bg-muted/20">
            <div className="p-3 border-b border-border flex items-center justify-between">
              <span className="text-sm font-semibold truncate" title={activeInstance.name}>
                {activeInstance.name}
              </span>
              <div className="flex items-center gap-0.5 shrink-0">
                <button
                  className="p-0.5 rounded hover:bg-muted cursor-pointer"
                  onClick={() => exportDialogRef.current?.open("prototype")}
                  title={t("export.titleBar")}
                >
                  <Archive className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>

            <div
              ref={(el) => { if (!isMobile) dragContainerEl.current = el }}
              className={`flex-1 overflow-auto py-1 select-none relative ${
                ((externalDrop !== null) || dragInfo !== null) && (externalDrop ? externalDrop.target : dropTargetPath) === ROOT
                  ? "ring-2 ring-inset ring-accent" : ""
              }`}
              onPointerDown={onFileTreePointerDown}
              onContextMenu={(e) => { e.preventDefault(); setRootMenu({ x: e.clientX, y: e.clientY }) }}
              onDragEnter={(e) => { if (isMobile) return; e.preventDefault() }}
              onDragOver={(e) => {
                if (isMobile) return
                e.preventDefault()
                e.dataTransfer.dropEffect = "copy"
                let t = resolveDropTarget(e.clientX, e.clientY)
                if (!t) t = snapDropTarget(e.clientX, e.clientY)
                if (t == null && dragContainerEl.current?.contains(e.target as Node)) t = ROOT
                setExternalDrop(prev => (prev?.target === t ? prev : { target: t ?? ROOT }))
              }}
              onDragLeave={(e) => {
                if (isMobile) return
                if (!dragContainerEl.current?.contains(e.relatedTarget as Node)) setExternalDrop(null)
              }}
              onDrop={(e) => {
                if (isMobile) return
                e.preventDefault()
                const t0 = externalDrop?.target ?? ROOT
                const files = Array.from(e.dataTransfer?.files ?? [])
                setExternalDrop(null)
                if (!files.length || !instId) return
                handleFileDrop(files, t0 === ROOT ? "" : t0)
              }}
            >
              {/* Drop-to-root indicator: a border box around the whole tree, with
                  a floating caption pinned to the bottom (does not affect layout). */}
              {((externalDrop !== null) || dragInfo !== null) && (externalDrop ? externalDrop.target : dropTargetPath) === ROOT && (
                <div className="pointer-events-none absolute inset-x-0 bottom-0 z-30 flex items-center justify-center gap-2 py-1.5 text-xs font-semibold text-accent-foreground">
                  <Archive className="h-3.5 w-3.5 shrink-0" />
                  {externalDrop !== null ? t("uploadToRoot") : t("moveToRoot")}
                </div>
              )}
              {isLoading ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                </div>
              ) : (
                <FileTreeView
                  nodes={fileTree}
                  expanded={expanded}
                  selectedFile={selectedFile}
                  selectionPaths={selectionPaths}
                  onToggle={toggleExpand}
                  onRowClick={handleNodeClick}
                  onSelect={(path) => {
                    openFile(path)
                  }}
                  onCreateFile={(parentPath) => { setShowCreate({ parentPath, type: "file" }); setCreateName("") }}
                  onCreateFolder={(parentPath) => { setShowCreate({ parentPath, type: "directory" }); setCreateName("") }}
                  onDelete={handleDeleteEntry}
                  onRename={handleRenameEntry}
                  onUpload={handleUploadClick}
                  fileStatuses={fileStatusesRoot}
                  isDragging={dragInfo !== null || externalDrop !== null}
                  dropTargetPath={externalDrop ? externalDrop.target : dropTargetPath}
                  dragSource={dragInfo?.srcPath ?? null}
                  clipboard={clipboard}
                  cutSourcePaths={clipboard?.cut ? new Set(clipboard.items.map(i => i.path)) : null}
                  onCopyPath={copyPathEntry}
                  onCopy={copyFromNode}
                  onCut={cutFromNode}
                  onPaste={pasteEntry}
                />
              )}
            </div>

          </aside>

          {/* Middle panel — Editor */}
          <div className="flex-1 flex flex-col bg-background min-w-0">
            {selectedFile ? (
              <>
                <div className="flex items-center justify-between px-3 py-2 border-b border-border shrink-0">
                  <span className="text-sm text-muted-foreground truncate">{selectedFile}</span>
                  <div className="flex items-center gap-2 shrink-0">
                    {isImageOpen ? (
                      <span className="text-xs text-muted-foreground">
                        {imageMeta ? `${imageMeta.w} × ${imageMeta.h}` : t("image")}
                      </span>
                    ) : (
                      <>
                        {isDirty && !saveToast && <span className="text-xs text-orange-500">{t("unsaved")}</span>}
                        {saveToast && <span ref={saveToastRef} className="text-xs text-green-500">{t("savedToDisk")}</span>}
                        {isMarkdown && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setEditorView((v) => (v === "code" ? "preview" : "code"))}
                            className="gap-1"
                            title={editorView === "code" ? t("previewMarkdown") : t("backToCodeEdit")}
                          >
                            {editorView === "code" ? <Eye className="h-3 w-3" /> : <Code2 className="h-3 w-3" />}
                            {editorView === "code" ? t("preview") : t("code")}
                          </Button>
                        )}
                        <Button size="sm" variant="outline" onClick={handleSave} disabled={!isDirty || isSaving} className="gap-1">
                          {isSaving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
                          {t("common:save")}
                        </Button>
                      </>
                    )}
                  </div>
                </div>
                <div className="flex-1 w-full overflow-hidden">
                  {/* 图片预览 */}
                  {isImageOpen && (
                    <div className="h-full overflow-auto flex items-start justify-center p-4">
                      <img
                        src={imageDataUri ?? undefined}
                        alt={selectedFile}
                        className="max-w-full max-h-full object-contain rounded shadow-sm"
                      />
                    </div>
                  )}
                  {/* 代码编辑器常驻挂载，预览时用 CSS 隐藏以保留撤销栈与光标 */}
                  <div className={isImageOpen ? "hidden" : editorView === "code" ? "h-full" : "hidden"}>
                    <MonacoEditor
                      key={`${selectedFile}#${editorEpoch}`}
                      path={selectedFile}
                      defaultValue={fileContent}
                      original={gitHeadContent ?? ""}
                      onSave={handleSave}
                      onChange={(val) => { setEditedContent(val); setIsDirty(val !== fileContent) }}
                      language={
                        selectedFile?.endsWith(".ts") || selectedFile?.endsWith(".tsx") ? "typescript" :
                        selectedFile?.endsWith(".js") ? "javascript" :
                        selectedFile?.endsWith(".py") ? "python" :
                        selectedFile?.endsWith(".json") ? "json" :
                        selectedFile?.endsWith(".css") ? "css" :
                        selectedFile?.endsWith(".html") ? "html" :
                        selectedFile?.endsWith(".sh") || selectedFile?.endsWith(".bash") ? "shell" :
                        "teahouse"
                      }
                    />
                  </div>
                  {isMarkdown && (
                    <div className={`h-full overflow-auto ${editorView === "preview" ? "" : "hidden"}`}>
                      <MarkdownRenderer content={editedContent} />
                    </div>
                  )}
                </div>
              </>
            ) : (
              <div className="flex-1 flex items-center justify-center text-muted-foreground">
                <div className="text-center">
                  <File className="h-12 w-12 mx-auto mb-3 opacity-20" />
                  <p className="text-sm">{t("selectFileDesktopHint")}</p>
                  <p className="text-xs mt-1 opacity-60">{t("ctrlSHint")}</p>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Play mode — Output panel (always mounted, hidden when backstage) */}
        <div className={`flex-1 flex-col min-w-0 ${mode === "play" ? "flex" : "hidden"}`}>
          <OutputPanel instanceId={instId} instanceName={activeInstance?.name} onSend={(msg) => useSessionStore.getState().setPendingMessage(msg)} onOpenDirector={openDirector} />
        </div>
      </div>

      {/* Drag handle + Chat panel (resizable, collapsible) */}
      {!chatCollapsed && (
        <>
          {/* Drag handle */}
          <div
            className={`w-1.5 border-l border-border shrink-0 cursor-col-resize hover:bg-primary/30 transition-colors relative group ${
              isDragging ? "bg-primary/50" : ""
            }`}
            onPointerDown={handleDragStart}
            style={{ touchAction: "none" }}
          >
            <GripVertical className="h-4 w-4 absolute top-1/2 -translate-y-1/2 -left-[7px] text-muted-foreground/40 group-hover:text-muted-foreground pointer-events-none" />
          </div>
          {/* Chat panel */}
          <aside
            className="border-l border-border flex flex-col bg-muted/10 min-w-0 shrink-0"
            style={{ width: `${chatWidth}%` }}
          >
            <div className="flex-1 flex flex-col min-h-0">
              <ChatPanel
                onGitRefresh={() => refresh()}
                onClosePanel={() => setChatCollapsed(true)}
              />
            </div>
          </aside>
        </>
      )}

      {/* Expand button when collapsed */}
      {chatCollapsed && (
        <div className="border-l border-border shrink-0 flex flex-col items-center pt-2 bg-muted/5">
          <button
            className="p-1 rounded hover:bg-muted text-muted-foreground"
            onClick={() => setChatCollapsed(false)}
            title={t("expandDirector")}
          >
            <PanelLeftOpen className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* Blank-area (root) context menu — right-click on tree background */}
      {rootMenu && (
        <RootContextMenu
          x={rootMenu.x}
          y={rootMenu.y}
          clipboard={clipboard}
          onNewFile={() => { setShowCreate({ parentPath: "", type: "file" }); setCreateName(""); setRootMenu(null) }}
          onNewFolder={() => { setShowCreate({ parentPath: "", type: "directory" }); setCreateName(""); setRootMenu(null) }}
          onUpload={handleMenuUpload}
          onPaste={() => { pasteEntry(""); setRootMenu(null) }}
          onClose={() => setRootMenu(null)}
        />
      )}

      {treeMenuEl}

      {/* Create Dialog */}
      {showCreate && (
        <CreateDialog
          type={showCreate.type}
          parentPath={showCreate.parentPath}
          name={createName}
          onNameChange={setCreateName}
          onSubmit={handleCreateEntry}
          onCancel={() => setShowCreate(null)}
        />
      )}

      {/* Rename dialog */}
      {renameTarget && (
        <RenameDialog
          target={renameTarget}
          name={renameName}
          onNameChange={setRenameName}
          onSubmit={confirmRename}
          onCancel={() => { setRenameTarget(null); setRenameName("") }}
        />
      )}

      {/* Confirm delete dialog */}
      <ConfirmDialog
        open={deleteTargets.length > 0}
        title={t("deleteConfirm.title")}
        message={deleteTargets.length > 1
          ? t("deleteConfirm.messageMany", { count: deleteTargets.length })
          : t("deleteConfirm.message", { path: deleteTargets[0]?.path ?? "" })}
        variant="destructive"
        confirmText={t("common:delete")}
        confirmOnEnter
        onConfirm={confirmDelete}
        onCancel={() => setDeleteTargets([])}
      />

      <ExportDialog
        ref={exportDialogRef}
        open={showExportDialog}
        onOpenChange={setShowExportDialog}
        instId={instId}
        isMobile={isMobile}
        onSaved={showSaveToast}
      />

      {/* Drag overlay — prevents iframe from capturing mouse during panel resize */}
      {isDragging && (
        <div
          className="fixed inset-0 z-50 cursor-col-resize"
          style={{ userSelect: "none" } as React.CSSProperties}
        />
      )}
    </div>
  )
}
