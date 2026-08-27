import { useEffect, useLayoutEffect, useState, useCallback, useRef, useMemo } from "react"
import { useTranslation } from "react-i18next"
import { useNavigate, useOutletContext } from "react-router-dom"
import { MonacoEditor } from "@/components/MonacoEditor"
import { MarkdownRenderer } from "@/components/MarkdownRenderer"
import {
  File, Folder, FolderOpen, Plus, Trash2, Loader2,
  ChevronLeft, ChevronRight, ChevronDown, Save, FileText,
  PanelLeftOpen, GripVertical, Archive,
  MessageCircle, FolderTree, Menu, X, Gamepad2, Wrench,
  GitBranch, Sun, Moon, Settings, ArrowLeft, Upload, Pencil,
  Eye, Code2, Users, Languages,
  ClipboardCopy, ClipboardPaste, Scissors,
} from "lucide-react"
import { useCurrentLang, useLangStore, SUPPORTED_LANGS, LANG_LABELS, type Lang } from "@/i18n/config"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select"
import { instancesApi, gitApi, prototypesApi, skillsApi, packagesApi, toFrontendPath, toBackendPath, ROOT, type InstanceSkill, type InstancePackage } from "@/lib/api"
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
import {
  ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSeparator,
} from "@/components/ui/context-menu"
import { useWorkspaceRefresh } from "@/hooks/useWorkspaceRefresh"
import { useSSERefresh } from "@/hooks/useSSERefresh"
import { useIsMobile } from "@/hooks/useMediaQuery"
import { useDialogBackClose } from "@/hooks/useDialogBackClose"
import type { FileTreeNode } from "@/lib/types"

// Monaco Editor theme follows system dark mode — handled by MonacoEditor component

// 上传菜单项：label → 内联原生 input。安卓在 fixed 浮层里对共享 input 的 .click() 转跳
// 会被系统静默拦截，而 label 原生关联让 input 直接参与用户手势、不经 .click()，最稳。
// input 用 opacity-0 而非 hidden。
function UploadMenuItem({
  parentPath,
  className,
  children,
  onUpload,
}: {
  parentPath: string
  className?: string
  children: React.ReactNode
  onUpload: (parentPath: string, file: File) => void
}) {
  const onChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    e.target.value = "" // 允许重复选同一文件
    if (f) onUpload(parentPath, f)
  }
  return (
    <label className={className}>
      {children}
      <input
        type="file"
        aria-label="上传文件"
        className="fixed left-0 top-0 h-px w-px opacity-0 pointer-events-none"
        tabIndex={-1}
        onChange={onChange}
      />
    </label>
  )
}

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
  // Stores the copied/cut entry. `path` is the frontend root/... form; the
  // backend-relative path is derived via toBackendPath() at use time.
  const [clipboard, setClipboard] = useState<{ path: string; cut: boolean; type: "file" | "directory"; name: string } | null>(null)
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
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)
  const [renameTarget, setRenameTarget] = useState<string | null>(null)
  const [renameName, setRenameName] = useState("")

  // Export prototype state
  const [showExportDialog, setShowExportDialog] = useState(false)
  // System back closes the mobile file-tree drawer and the export panel one level
  // at a time (nested with director above), instead of jumping straight home.
  useDialogBackClose(showFileTree, () => setShowFileTree(false))
  useDialogBackClose(showExportDialog, () => setShowExportDialog(false))
  const [exportType, setExportType] = useState<"prototype" | "skill" | "package">("prototype")
  const [exportName, setExportName] = useState("")
  const [exportDescription, setExportDescription] = useState("")
  const [exportAuthor, setExportAuthor] = useState("")
  const [exportVersion, setExportVersion] = useState("1.0.0")
  const [exportLoading, setExportLoading] = useState(false)
  const [exportError, setExportError] = useState("")
  // Export-skill plane: list instance skills, pick one, export to user library
  const [instSkills, setInstSkills] = useState<InstanceSkill[]>([])
  const [instSkillsLoading, setInstSkillsLoading] = useState(false)
  const [exportSelectedSkill, setExportSelectedSkill] = useState("")
  const [exportSkillError, setExportSkillError] = useState("")
  const [exportSkillLoading, setExportSkillLoading] = useState(false)
  // Export-package plane: list instance packages, pick one, export to user library
  const [instPackages, setInstPackages] = useState<InstancePackage[]>([])
  const [instPackagesLoading, setInstPackagesLoading] = useState(false)
  const [exportSelectedPackage, setExportSelectedPackage] = useState("")
  const [exportPackageError, setExportPackageError] = useState("")
  const [exportPackageLoading, setExportPackageLoading] = useState(false)
  // Overwrite confirmation: a same-named target already exists in the library.
  const [pendingOverwrite, setPendingOverwrite] = useState<{ kind: "skill" | "package"; name: string } | null>(null)

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
      setFileTree(res.data || [])
    }
    if (showSpinner) setIsLoading(false)
  }, [instId])

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
  // editor state whenever the instance changes.
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
    await instancesApi.createEntry(instId, fullPath, showCreate.type)
    setShowCreate(null)
    setCreateName("")
    await refresh()
  }

  const handleDeleteEntry = async (path: string) => {
    setDeleteTarget(path)
  }

  const confirmDelete = async () => {
    if (!instId || !deleteTarget) return
    const path = deleteTarget
    setDeleteTarget(null)
    await instancesApi.deleteEntry(instId, path)
    if (selectedFile === path || selectedFile?.startsWith(path + "/")) {
      setSelectedFile(null)
      setIsImageOpen(false)
      setImageDataUri(null)
      setImageMeta(null)
      setFileContent("")
      setEditedContent("")
      setIsDirty(false)
    }
    await refresh()
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
    // Remap the open file if it is the renamed entry or lives under a renamed directory
    if (selectedFile === oldPath || selectedFile?.startsWith(oldPath + "/")) {
      const parent = oldPath.includes("/") ? oldPath.slice(0, oldPath.lastIndexOf("/")) : ""
      const newPath = parent ? `${parent}/${newName}` : newName
      setSelectedFile(
        selectedFile === oldPath ? newPath : newPath + selectedFile!.slice(oldPath.length),
      )
    }
    await refresh()
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
    await refresh()
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
    for (const f of files) {
      const fullPath = dir ? `${dir}/${f.name}` : f.name
      const res = await instancesApi.uploadFile(instId, fullPath, f)
      if (res.ok) okCount++
      else failNames.push(f.name)
    }
    await refresh()
    if (okCount > 0) toast.success(t("dropUpload.done", { count: okCount }))
    if (failNames.length) toast.error(t("dropUpload.fail", { names: failNames.join(", ") }))
  }

  const openExportDialog = async (type: "prototype" | "skill" | "package") => {
    setExportType(type)
    setExportError("")
    setExportSkillError("")
    setExportPackageError("")
    if (type === "skill") {
      setExportSelectedSkill("")
      if (!instId) return
      setInstSkillsLoading(true)
      const res = await skillsApi.listForInstance(instId)
      if (res.ok) {
        const instanceOnly = res.data!.filter(s => s.source === "instance" && s.has_skill)
        setInstSkills(instanceOnly)
      } else {
        setExportSkillError(res.error || t("skillLoadFail"))
      }
      setInstSkillsLoading(false)
    } else if (type === "package") {
      setExportSelectedPackage("")
      if (!instId) return
      setInstPackagesLoading(true)
      const res = await packagesApi.listInInstance(instId)
      if (res.ok) {
        setInstPackages(res.data!.packages)
      } else {
        setExportPackageError(res.error || t("packageLoadFail"))
      }
      setInstPackagesLoading(false)
    }
    setShowExportDialog(true)
  }

  // Shared "export a library item into the user's library" with overwrite confirm.
  const doExportToLibrary = async (kind: "skill" | "package", name: string, overwrite: boolean, setLoading: (v: boolean) => void, setErr: (v: string) => void) => {
    if (!instId) return
    setLoading(true)
    setErr("")
    let res: { ok: boolean; error?: string; status?: number }
    if (kind === "skill") {
      res = await skillsApi.exportToLibrary(instId, name, overwrite)
    } else {
      res = await packagesApi.exportToLibrary(instId, name, overwrite)
    }
    setLoading(false)
    if (res.ok) {
      setShowExportDialog(false)
      if (kind === "skill") setExportSelectedSkill("")
      else setExportSelectedPackage("")
      showSaveToast()
    } else if (!overwrite && res.status === 409) {
      // Same-named target already exists in the library → ask before overwriting.
      setPendingOverwrite({ kind, name })
    } else {
      setErr(res.error || t("exportFail"))
    }
  }

  const handleExport = async () => {
    if (!instId) return
    if (exportType === "prototype") {
      if (!exportName.trim()) return
      setExportLoading(true)
      setExportError("")
      const res = await prototypesApi.create(
        instId, exportName.trim(), exportDescription.trim(),
        exportAuthor.trim(), exportVersion.trim() || "1.0.0",
      )
      if (res.ok) {
        setShowExportDialog(false)
        setExportName("")
        setExportDescription("")
        setExportAuthor("")
        setExportVersion("1.0.0")
        showSaveToast()
      } else {
        setExportError(res.error || t("exportFail"))
      }
      setExportLoading(false)
    } else if (exportType === "package") {
      if (!exportSelectedPackage) return
      await doExportToLibrary("package", exportSelectedPackage, false, setExportPackageLoading, setExportPackageError)
    } else {
      if (!exportSelectedSkill) return
      await doExportToLibrary("skill", exportSelectedSkill, false, setExportSkillLoading, setExportSkillError)
    }
  }

  const handleConfirmOverwrite = async () => {
    if (!pendingOverwrite) return
    const { kind, name } = pendingOverwrite
    setPendingOverwrite(null)
    if (!instId) return
    if (kind === "skill") {
      const setL = setExportSkillLoading
      const setE = setExportSkillError
      setL(true); setE("")
      const res = await skillsApi.exportToLibrary(instId, name, true)
      setL(false)
      if (res.ok) {
        setShowExportDialog(false)
        setExportSelectedSkill("")
        showSaveToast()
      } else setE(res.error || t("exportFail"))
    } else {
      setExportPackageLoading(true); setExportPackageError("")
      const res = await packagesApi.exportToLibrary(instId, name, true)
      setExportPackageLoading(false)
      if (res.ok) {
        setShowExportDialog(false)
        setExportSelectedPackage("")
        showSaveToast()
      } else setExportPackageError(res.error || t("exportFail"))
    }
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
    } finally {
      moveInFlightRef.current = false
    }
  }, [instId, selectedFile, refresh])

  // ---- Clipboard operations: copy path / copy / cut / paste ----
  const copyPathEntry = useCallback(async (path: string) => {
    try {
      await navigator.clipboard.writeText(toBackendPath(path))
      toast.success(t("clipboard.copiedPath"))
    } catch {
      toast.error(t("common:failed"))
    }
  }, [t])

  const copyEntry = useCallback((path: string, type: "file" | "directory", name: string) => {
    setClipboard({ path, cut: false, type, name })
    toast.success(t("clipboard.copied", { name }))
  }, [t])

  const cutEntry = useCallback((path: string, type: "file" | "directory", name: string) => {
    setClipboard({ path, cut: true, type, name })
    toast.success(t("clipboard.cutActive", { name }))
  }, [t])

  // Find a node in the tree by its frontend path, returning its children.
  const findNodeChildren = useCallback((nodes: FileTreeNode[], path: string): FileTreeNode[] | null => {
    for (const n of nodes) {
      if (n.path === path) return n.children ?? []
      if (n.children) {
        const r = findNodeChildren(n.children, path)
        if (r) return r
      }
    }
    return null
  }, [])

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

  // Recursively copy a file/dir entry (frontend paths). Used by the non-cut paste.
  const duplicateEntry = useCallback(async (srcPath: string, destPath: string, type: "file" | "directory"): Promise<boolean> => {
    if (!instId) return false
    if (type === "file") {
      const contentRes = await instancesApi.readText(instId, srcPath)
      if (!contentRes.ok) return false
      await instancesApi.createEntry(instId, destPath, "file")
      await instancesApi.writeFile(instId, destPath, contentRes.data!.content)
      return true
    }
    // directory
    await instancesApi.createEntry(instId, destPath, "directory")
    const kids = findNodeChildren(fileTree, srcPath) ?? []
    for (const child of kids) {
      const ok = await duplicateEntry(
        child.path,
        `${destPath}/${child.path.split("/").pop()}`,
        child.type,
      )
      if (!ok) return false
    }
    return true
  }, [instId, findNodeChildren, fileTree])

  // Paste the clipboard item into `targetParent` ("" = root). For a file paste
  // target it lands in the file's parent dir; a directory paste goes inside.
  const pasteEntry = useCallback(async (targetParent: string) => {
    if (!clipboard || !instId) return
    const clip = clipboard
    const target = targetParent

    if (clip.cut) {
      if (parentOf(clip.path) === target) return // already there
      // Refuse to move a folder into its own subtree (same rule as drag & drop).
      if (target === clip.path || target.startsWith(clip.path + "/")) {
        toast.error(t("common:failed"))
        return
      }
      const res = await instancesApi.moveEntry(instId, clip.path, target)
      if (!res.ok) { toast.error(res.error || t("common:failed")); return }
      // Remap the open file if it is the moved entry or lives under it.
      if (selectedFile === clip.path || selectedFile?.startsWith(clip.path + "/")) {
        const base = clip.path.split("/").pop() ?? clip.path
        setSelectedFile(target ? `${target}/${base}` : base)
      }
      setClipboard(null)
      await refresh()
      toast.success(t("clipboard.pasted", { name: clip.name }))
      return
    }

    // copy (non-destructive) — dedupe the destination name
    const destPath = uniquePath(target, clip.name)
    const ok = await duplicateEntry(clip.path, destPath, clip.type)
    if (ok) { await refresh(); toast.success(t("clipboard.pasted", { name: clip.name })) }
    else toast.error(t("common:failed"))
  }, [clipboard, instId, parentOf, selectedFile, uniquePath, duplicateEntry, refresh, t])

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

  // SSE-driven refresh — backend broadcasts file_changed / workspace_changed events
  useSSERefresh({
    instanceId: instId,
    instanceName: activeInstance?.name,
    onFileChanged: (path: string) => {
      if (!path) {
        // empty path means the changed file is the currently open one
        // AND it's dirty — just refresh tree + git, skip editor
        refresh()
        return
      }
      // Backend broadcasts bare relative paths; the tree/editor work in
      // "root/..." form, so normalize before comparing.
      path = toFrontendPath(path)
      const currentFile = selectedFileRef.current
      if (currentFile && path === currentFile && isDirtyRef.current) {
        // Dirty file was modified externally — refresh tree + git but
        // preserve user's unsaved edits in the editor.
        refresh()
        return
      }
      refresh()
      if (currentFile && path === currentFile) {
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

    // Periodic backstop: backend broadcasts that don't exist (e.g. Generate
    // dump_payload) never fire file_changed, so poll the tree every 5s and only
    // apply when it actually changed. Keeps the tree fresh without spraying
    // git/editor refreshes on an idle workspace. The dirty-check lives in the
    // hook; onPollTick receives the already-fetched tree, so no double fetch.
    pollIntervalMs: 5000,
    onPollFetch: async () => {
      const res = await instancesApi.listFiles(instId!)
      return res.ok ? (res.data ?? []) : []
    },
    onPollTick: (tree: FileTreeNode[]) => {
      setFileTree(tree)
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

  // Real, post-layout menu height (measured once it opens). The menu content is
  // fixed per node, so the height is stable — the estimate M_H below used to be a
  // hardcoded 360 that badly undershot (~600px actual), so near the bottom of a
  // tall tree the up-flip placed the menu's top almost at the finger and clipped
  // the action buttons. Measuring the real box lets us pick the side that shows
  // the most buttons and cap the box to exactly the viewport.
  const [treeMenuH, setTreeMenuH] = useState(0)
  const treeMenuRef = useRef<HTMLDivElement | null>(null)
  useLayoutEffect(() => {
    if (!treeMenu) return
    setTreeMenuH(treeMenuRef.current?.getBoundingClientRect().height ?? 0)
    // Menu is fixed-position; the tree keeps scrolling underneath while it's open.
  }, [treeMenu])

  // Mobile per-node "⋯" menu — fixed-position (treeMenu-style), anchored at the
  // clicked icon. Items mirror the desktop ContextMenu on the same node.
  // Shared by desktop + mobile return trees.
  const treeMenuEl = treeMenu && (
    <>
      <div className="fixed inset-0 z-[70]" onClick={() => setTreeMenu(null)} onContextMenu={(e) => { e.preventDefault(); setTreeMenu(null) }} />
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
        {(() => {
          const node = treeMenu.node
          // Directory → operations land inside it; file → its parent dir.
          const opTarget = node.type === "directory" ? node.path : parentOf(node.path)
          const itemCls = "relative flex w-full cursor-default items-center gap-1.5 rounded-md px-1.5 py-2.5 text-sm outline-hidden select-none hover:bg-accent hover:text-accent-foreground"
          const disabledCls = "pointer-events-none opacity-50"
          return (
            <>
              <div className="pointer-events-none flex items-center gap-1.5 px-1.5 py-2 text-xs font-medium text-muted-foreground select-none">
                {node.type === "directory" ? (
                  <FolderOpen className="h-3.5 w-3.5 shrink-0" />
                ) : (
                  <FileText className="h-3.5 w-3.5 shrink-0" />
                )}
                <span className="truncate" title={node.path}>{node.name}</span>
              </div>
              <div className="-mx-1 mb-1 h-px bg-border" />
              <button className={itemCls} onClick={() => { setShowCreate({ parentPath: opTarget, type: "file" }); setCreateName(""); setTreeMenu(null) }}>
                <Plus className="h-4 w-4 shrink-0" />
                {t("create.fileTitle")}
              </button>
              <button className={itemCls} onClick={() => { setShowCreate({ parentPath: opTarget, type: "directory" }); setCreateName(""); setTreeMenu(null) }}>
                <Folder className="h-4 w-4 shrink-0" />
                {t("create.folderTitle")}
              </button>
              <UploadMenuItem parentPath={opTarget} className={itemCls} onUpload={handleMenuUpload}>
                <Upload className="h-4 w-4 shrink-0" />
                {t("uploadToHere")}
              </UploadMenuItem>
              <div className="-mx-1 my-1 h-px bg-border" />
              <button className={itemCls} onClick={() => { copyPathEntry(node.path); setTreeMenu(null) }}>
                <ClipboardCopy className="h-4 w-4 shrink-0" />
                {t("clipboard.copyPath")}
              </button>
              <button className={itemCls} onClick={() => { copyEntry(node.path, node.type, node.name); setTreeMenu(null) }}>
                <ClipboardCopy className="h-4 w-4 shrink-0" />
                {t("clipboard.copy")}
              </button>
              <button className={itemCls} onClick={() => { cutEntry(node.path, node.type, node.name); setTreeMenu(null) }}>
                <Scissors className="h-4 w-4 shrink-0" />
                {t("clipboard.cut")}
              </button>
              <button
                className={`${itemCls} ${!clipboard ? disabledCls : ""}`}
                disabled={!clipboard}
                onClick={() => { pasteEntry(opTarget); setTreeMenu(null) }}
              >
                <ClipboardPaste className="h-4 w-4 shrink-0" />
                {t("clipboard.paste")}
              </button>
              <div className="-mx-1 my-1 h-px bg-border" />
              <button className={itemCls} onClick={() => { handleRenameEntry(node.path); setTreeMenu(null) }}>
                <Pencil className="h-4 w-4 shrink-0" />
                {t("rename.title")}
              </button>
              <button className={`${itemCls} text-destructive hover:bg-destructive/10 hover:text-destructive`} onClick={() => { handleDeleteEntry(node.path); setTreeMenu(null) }}>
                <Trash2 className="h-4 w-4 shrink-0" />
                {t("common:delete")}
              </button>
            </>
          )
        })()}
      </div>
    </>
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
      <>
        <div className="fixed inset-0 z-40" onClick={() => setShowMobileMenu(false)} />
        <div className="absolute right-0 top-full mt-1 z-50 bg-background border border-border rounded-md shadow-lg py-1 min-w-[160px]">
          <div className="flex items-center justify-between px-3 py-2">
            <span className="text-sm">{t("mode.play")}</span>
            <Switch
              checked={mode === "backstage"}
              onCheckedChange={(v) => {
                useViewModeStore.getState().setMode(v ? "backstage" : "play")
                setShowMobileMenu(false)
              }}
            />
          </div>
          <div className="border-t border-border" />
          <button
            className="w-full flex items-center gap-2 px-3 py-2.5 text-sm hover:bg-muted"
            onClick={() => { setFullscreenPanel("director"); setShowMobileMenu(false) }}
          >
            <MessageCircle className="h-4 w-4" />
            {t("director")}
          </button>
          <button
            className="w-full flex items-center gap-2 px-3 py-2.5 text-sm hover:bg-muted"
            onClick={() => { setFullscreenPanel("git"); setShowMobileMenu(false) }}
          >
            <GitBranch className="h-4 w-4" />
            {t("versionControl")}
          </button>
          <button
            className="w-full flex items-center gap-2 px-3 py-2.5 text-sm hover:bg-muted"
            onClick={() => { setFullscreenPanel("files"); setShowMobileMenu(false) }}
          >
            <FileText className="h-4 w-4" />
            {t("fileList")}
          </button>
          {isAdminRole(currentUser?.role) && (
            <button
              className="w-full flex items-center gap-2 px-3 py-2.5 text-sm hover:bg-muted"
              onClick={() => { openSettings("users"); setShowMobileMenu(false) }}
            >
              <Users className="h-4 w-4" />
              {t("userManagement")}
            </button>
          )}
          <button
            className="w-full flex items-center gap-2 px-3 py-2.5 text-sm hover:bg-muted"
            onClick={() => { openSettings(); setShowMobileMenu(false) }}
          >
            <Settings className="h-4 w-4" />
            {t("common:settings")}
          </button>
          <div className="border-t border-border" />
          <div className="px-3 py-2 space-y-1">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Languages className="h-4 w-4" />
              {t("language")}
            </div>
            <div className="flex items-center gap-2 flex-wrap pl-6">
              {SUPPORTED_LANGS.map((l) => (
                <button
                  key={l}
                  className={`px-2 py-1 text-xs rounded border ${
                    currentLang === l
                      ? "bg-primary text-primary-foreground border-primary"
                      : "border-border hover:bg-muted"
                  }`}
                  onClick={() => setLang(l as Lang)}
                >
                  {LANG_LABELS[l]}
                </button>
              ))}
            </div>
          </div>
          <div className="border-t border-border" />
          <button
            className="w-full flex items-center gap-2 px-3 py-2.5 text-sm hover:bg-muted"
            onClick={() => { handleToggleTheme(); setShowMobileMenu(false) }}
          >
            {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            {t("themeToggle")}
          </button>
          <div className="border-t border-border" />
          <button
            className="w-full flex items-center gap-2 px-3 py-2.5 text-sm hover:bg-muted"
            onClick={() => {
              setActiveInstance(null)
              navigate("/", { replace: true })
            }}
          >
            <ArrowLeft className="h-4 w-4" />
            {t("exitToHome")}
          </button>
        </div>
      </>
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
                  <button className="p-1.5 rounded hover:bg-muted" onClick={() => openExportDialog("prototype")} title={t("export.titleBar")}>
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
                    onToggle={toggleExpand}
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
                    cutSource={clipboard?.cut ? clipboard.path : null}
                    onCopyPath={copyPathEntry}
                    onCopy={copyEntry}
                    onCut={cutEntry}
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
          <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={() => setShowCreate(null)}>
            <div className="bg-background rounded-lg shadow-lg w-full max-w-sm mx-4 p-6 space-y-4" onClick={e => e.stopPropagation()}>
              <h3 className="font-semibold">{showCreate.type === "directory" ? t("create.titleFolder") : t("create.titleFile")}</h3>
              <div>
                {showCreate.parentPath && (
                  <p className="text-xs text-muted-foreground mb-2">{t("location", { path: showCreate.parentPath || "/" })}</p>
                )}
                <Input
                  value={createName}
                  onChange={e => setCreateName(e.target.value)}
                  placeholder={showCreate.type === "directory" ? t("create.folderPh") : t("create.filePh")}
                  autoFocus
                  onKeyDown={e => { if (e.key === "Enter") handleCreateEntry() }}
                />
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="outline" size="sm" onClick={() => setShowCreate(null)}>{t("common:cancel")}</Button>
                <Button size="sm" onClick={handleCreateEntry} disabled={!createName.trim()}>{t("create.submit")}</Button>
              </div>
            </div>
          </div>
        )}

        {/* Rename dialog */}
        {renameTarget && (
          <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={() => { setRenameTarget(null); setRenameName("") }}>
            <div className="bg-background rounded-lg shadow-lg w-full max-w-sm mx-4 p-6 space-y-4" onClick={e => e.stopPropagation()}>
              <h3 className="font-semibold">{t("rename.title")}</h3>
              <div>
                <p className="text-xs text-muted-foreground mb-2">{t("location", { path: renameTarget.includes("/") ? renameTarget.slice(0, renameTarget.lastIndexOf("/")) || "/" : "/" })}</p>
                <Input
                  value={renameName}
                  onChange={e => setRenameName(e.target.value)}
                  placeholder={t("rename.ph")}
                  autoFocus
                  onKeyDown={e => { if (e.key === "Enter") confirmRename() }}
                />
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="outline" size="sm" onClick={() => { setRenameTarget(null); setRenameName("") }}>{t("common:cancel")}</Button>
                <Button size="sm" onClick={confirmRename} disabled={!renameName.trim()}>{t("common:ok")}</Button>
              </div>
            </div>
          </div>
        )}

        {/* Confirm delete dialog */}
        <ConfirmDialog
          open={deleteTarget !== null}
          title={t("deleteConfirm.title")}
          message={t("deleteConfirm.message", { path: deleteTarget })}
          variant="destructive"
          confirmText={t("common:delete")}
          onConfirm={confirmDelete}
          onCancel={() => setDeleteTarget(null)}
        />

        {/* Export prototype / skill dialog (fullscreen panel on mobile) */}
        {showExportDialog && (
          <div className="fixed inset-0 z-50 bg-background flex flex-col">
            {/* Fullscreen panel nav — ChevronLeft back on mobile */}
            <div className="h-10 border-b border-border flex items-center gap-1 px-1 shrink-0">
              <button
                className="p-2 rounded-md hover:bg-muted shrink-0"
                onClick={() => setShowExportDialog(false)}
                title={t("common:cancel")}
              >
                <ChevronLeft className="h-5 w-5" />
              </button>
              <span className="flex-1 text-sm font-medium text-center truncate">{t("export.titleBar")}</span>
              <span className="w-9 shrink-0" />
            </div>
            <div className="flex-1 overflow-y-auto p-4 space-y-4" onClick={e => e.stopPropagation()}>

              {/* Type toggle */}
              <div className="grid grid-cols-3 gap-1 p-1 rounded-lg bg-muted">
                <button
                  className={`py-1.5 rounded-md text-sm font-medium transition-colors cursor-pointer ${exportType === "prototype" ? "bg-background shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
                  onClick={() => openExportDialog("prototype")}
                >
                  {t("export.type.prototype")}
                </button>
                <button
                  className={`py-1.5 rounded-md text-sm font-medium transition-colors cursor-pointer ${exportType === "skill" ? "bg-background shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
                  onClick={() => openExportDialog("skill")}
                >
                  {t("export.type.skill")}
                </button>
                <button
                  className={`py-1.5 rounded-md text-sm font-medium transition-colors cursor-pointer ${exportType === "package" ? "bg-background shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
                  onClick={() => openExportDialog("package")}
                >
                  {t("export.type.package")}
                </button>
              </div>

              {exportType === "prototype" ? (
                <>
                  <h3 className="font-semibold">{t("export.prototype.title")}</h3>
                  <p className="text-xs text-muted-foreground">{t("export.prototype.desc")}</p>
                  <div className="space-y-1">
                    <label className="text-sm font-medium">{t("export.prototype.name")}</label>
                    <Input
                      value={exportName}
                      onChange={e => { setExportName(e.target.value); setExportError("") }}
                      placeholder={t("export.prototype.namePh")}
                      autoFocus
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-sm font-medium">{t("export.prototype.descLabel")} <span className="text-muted-foreground font-normal">{t("export.prototype.maxChars")}</span></label>
                    <Input
                      value={exportDescription}
                      onChange={e => setExportDescription(e.target.value)}
                      placeholder={t("export.prototype.descPh")}
                      maxLength={50}
                    />
                  </div>
                  <div className="flex gap-3">
                    <div className="space-y-1 flex-1">
                      <label className="text-sm font-medium">{t("export.prototype.author")} <span className="text-muted-foreground font-normal">{t("export.prototype.optional")}</span></label>
                      <Input
                        value={exportAuthor}
                        onChange={e => setExportAuthor(e.target.value)}
                        placeholder={t("export.prototype.authorPh")}
                      />
                    </div>
                    <div className="space-y-1 w-24">
                      <label className="text-sm font-medium">{t("common:version")}</label>
                      <Input
                        value={exportVersion}
                        onChange={e => setExportVersion(e.target.value)}
                        placeholder="1.0.0"
                      />
                    </div>
                  </div>
                  {exportError && <p className="text-sm text-red-500">{exportError}</p>}
                  <div className="flex justify-end gap-2">
                    <Button variant="outline" size="sm" onClick={() => setShowExportDialog(false)}>{t("common:cancel")}</Button>
                    <Button size="sm" onClick={handleExport} disabled={!exportName.trim() || exportLoading}>
                      {exportLoading && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}
                      {t("export.submit")}
                    </Button>
                  </div>
                </>
              ) : exportType === "package" ? (
                <>
                  <h3 className="font-semibold">{t("export.package.title")}</h3>
                  <p className="text-xs text-muted-foreground">{t("export.package.desc")}</p>
                  <div className="space-y-1">
                    <label className="text-sm font-medium">{t("export.package.select")}</label>
                    {instPackagesLoading ? (
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <Loader2 className="h-3 w-3 animate-spin" /> {t("common:loading")}
                      </div>
                    ) : instPackages.length === 0 ? (
                      <p className="text-xs text-muted-foreground">{t("export.package.empty")}</p>
                    ) : (
                      <Select value={exportSelectedPackage || undefined} onValueChange={(v) => { if (v) setExportSelectedPackage(v) }}>
                        <SelectTrigger>
                          <SelectValue placeholder={t("export.package.ph")} />
                        </SelectTrigger>
                        <SelectContent>
                          {instPackages.map(p => (
                            <SelectItem key={p.name} value={p.name}>{p.name}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  </div>
                  {exportPackageError && <p className="text-sm text-red-500">{exportPackageError}</p>}
                  <div className="flex justify-end gap-2">
                    <Button variant="outline" size="sm" onClick={() => setShowExportDialog(false)}>{t("common:cancel")}</Button>
                    <Button size="sm" onClick={handleExport} disabled={!exportSelectedPackage || exportPackageLoading}>
                      {exportPackageLoading && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}
                      {t("export.package.submit")}
                    </Button>
                  </div>
                </>
              ) : (
                <>
                  <h3 className="font-semibold">{t("export.skill.title")}</h3>
                  <p className="text-xs text-muted-foreground">{t("export.skill.desc")}</p>
                  <div className="space-y-1">
                    <label className="text-sm font-medium">{t("export.skill.select")}</label>
                    {instSkillsLoading ? (
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <Loader2 className="h-3 w-3 animate-spin" /> {t("common:loading")}
                      </div>
                    ) : instSkills.length === 0 ? (
                      <p className="text-xs text-muted-foreground">{t("export.skill.empty")}</p>
                    ) : (
                      <Select value={exportSelectedSkill || undefined} onValueChange={(v) => { if (v) setExportSelectedSkill(v) }}>
                        <SelectTrigger>
                          <SelectValue placeholder={t("export.skill.ph")} />
                        </SelectTrigger>
                        <SelectContent>
                          {instSkills.map(s => (
                            <SelectItem key={s.name} value={s.name}>{s.name}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  </div>
                  {exportSkillError && <p className="text-sm text-red-500">{exportSkillError}</p>}
                  <div className="flex justify-end gap-2">
                    <Button variant="outline" size="sm" onClick={() => setShowExportDialog(false)}>{t("common:cancel")}</Button>
                    <Button size="sm" onClick={handleExport} disabled={!exportSelectedSkill || exportSkillLoading}>
                      {exportSkillLoading && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}
                      {t("export.skill.submit")}
                    </Button>
                  </div>
                </>
              )}
            </div>
          </div>
        )}

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
                  onClick={() => openExportDialog("prototype")}
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
                  onToggle={toggleExpand}
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
                  cutSource={clipboard?.cut ? clipboard.path : null}
                  onCopyPath={copyPathEntry}
                  onCopy={copyEntry}
                  onCut={cutEntry}
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
        <>
          <div className="fixed inset-0 z-40" onClick={() => setRootMenu(null)} onContextMenu={(e) => { e.preventDefault(); setRootMenu(null) }} />
          <div
            className="fixed z-50 min-w-40 rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10"
            style={{ left: rootMenu.x, top: rootMenu.y }}
            onContextMenu={(e) => e.preventDefault()}
          >
            <button
              className="relative flex w-full cursor-default items-center gap-1.5 rounded-md px-1.5 py-1 text-sm outline-hidden select-none"
              onClick={() => { setShowCreate({ parentPath: "", type: "file" }); setCreateName(""); setRootMenu(null) }}
            >
              {t("create.fileTitle")}
            </button>
            <button
              className="relative flex w-full cursor-default items-center gap-1.5 rounded-md px-1.5 py-1 text-sm outline-hidden select-none"
              onClick={() => { setShowCreate({ parentPath: "", type: "directory" }); setCreateName(""); setRootMenu(null) }}
            >
              {t("create.folderTitle")}
            </button>
            <UploadMenuItem
              parentPath=""
              className="relative flex w-full cursor-default items-center gap-1.5 rounded-md px-1.5 py-1 text-sm outline-hidden select-none"
              onUpload={handleMenuUpload}
            >
              {t("uploadToRoot")}
            </UploadMenuItem>
            <div className="-mx-1 my-1 h-px bg-border" />
            <button
              className={`relative flex w-full cursor-default items-center gap-1.5 rounded-md px-1.5 py-1 text-sm outline-hidden select-none ${!clipboard ? "pointer-events-none opacity-50" : ""}`}
              disabled={!clipboard}
              onClick={() => { pasteEntry(""); setRootMenu(null) }}
            >
              {t("clipboard.paste")}
            </button>
          </div>
        </>
      )}

      {treeMenuEl}

      {/* Create Dialog */}
      {showCreate && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={() => setShowCreate(null)}>
          <div className="bg-background rounded-lg shadow-lg w-full max-w-sm mx-4 p-6 space-y-4" onClick={e => e.stopPropagation()}>
            <h3 className="font-semibold">{showCreate.type === "directory" ? t("create.titleFolder") : t("create.titleFile")}</h3>
            <div>
              {showCreate.parentPath && (
                <p className="text-xs text-muted-foreground mb-2">{t("location", { path: showCreate.parentPath || "/" })}</p>
              )}
              <Input
                value={createName}
                onChange={e => setCreateName(e.target.value)}
                placeholder={showCreate.type === "directory" ? t("create.folderPh") : t("create.filePh")}
                autoFocus
                onKeyDown={e => { if (e.key === "Enter") handleCreateEntry() }}
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setShowCreate(null)}>{t("common:cancel")}</Button>
              <Button size="sm" onClick={handleCreateEntry} disabled={!createName.trim()}>{t("create.submit")}</Button>
            </div>
          </div>
        </div>
      )}

      {/* Rename dialog */}
      {renameTarget && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={() => { setRenameTarget(null); setRenameName("") }}>
          <div className="bg-background rounded-lg shadow-lg w-full max-w-sm mx-4 p-6 space-y-4" onClick={e => e.stopPropagation()}>
            <h3 className="font-semibold">{t("rename.title")}</h3>
            <div>
              <p className="text-xs text-muted-foreground mb-2">{t("location", { path: renameTarget.includes("/") ? renameTarget.slice(0, renameTarget.lastIndexOf("/")) || "/" : "/" })}</p>
              <Input
                value={renameName}
                onChange={e => setRenameName(e.target.value)}
                placeholder={t("rename.ph")}
                autoFocus
                onKeyDown={e => { if (e.key === "Enter") confirmRename() }}
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => { setRenameTarget(null); setRenameName("") }}>{t("common:cancel")}</Button>
              <Button size="sm" onClick={confirmRename} disabled={!renameName.trim()}>{t("common:ok")}</Button>
            </div>
          </div>
        </div>
      )}

      {/* Confirm delete dialog */}
      <ConfirmDialog
        open={deleteTarget !== null}
        title={t("deleteConfirm.title")}
        message={t("deleteConfirm.message", { path: deleteTarget })}
        variant="destructive"
        confirmText={t("common:delete")}
        onConfirm={confirmDelete}
        onCancel={() => setDeleteTarget(null)}
      />

      {/* Export prototype / skill dialog */}
      {showExportDialog && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={() => setShowExportDialog(false)}>
          <div className="bg-background rounded-lg shadow-lg w-full max-w-sm mx-4 p-6 space-y-4" onClick={e => e.stopPropagation()}>
            {/* Type toggle */}
            <div className="grid grid-cols-3 gap-1 p-1 rounded-lg bg-muted">
              <button
                className={`py-1.5 rounded-md text-sm font-medium transition-colors cursor-pointer ${exportType === "prototype" ? "bg-background shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
                onClick={() => openExportDialog("prototype")}
              >
                {t("export.type.prototype")}
              </button>
              <button
                className={`py-1.5 rounded-md text-sm font-medium transition-colors cursor-pointer ${exportType === "skill" ? "bg-background shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
                onClick={() => openExportDialog("skill")}
              >
                {t("export.type.skill")}
              </button>
              <button
                className={`py-1.5 rounded-md text-sm font-medium transition-colors cursor-pointer ${exportType === "package" ? "bg-background shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
                onClick={() => openExportDialog("package")}
              >
                {t("export.type.package")}
              </button>
            </div>

            {exportType === "prototype" ? (
              <>
                <h3 className="font-semibold">{t("export.prototype.title")}</h3>
                <p className="text-xs text-muted-foreground">{t("export.prototype.desc")}</p>
                <div className="space-y-1">
                  <label className="text-sm font-medium">{t("export.prototype.name")}</label>
                  <Input
                    value={exportName}
                    onChange={e => { setExportName(e.target.value); setExportError("") }}
                    placeholder={t("export.prototype.namePh")}
                    autoFocus
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-sm font-medium">{t("export.prototype.descLabel")} <span className="text-muted-foreground font-normal">{t("export.prototype.maxChars")}</span></label>
                  <Input
                    value={exportDescription}
                    onChange={e => setExportDescription(e.target.value)}
                    placeholder={t("export.prototype.descPh")}
                    maxLength={50}
                  />
                </div>
                <div className="flex gap-3">
                  <div className="space-y-1 flex-1">
                    <label className="text-sm font-medium">{t("export.prototype.author")} <span className="text-muted-foreground font-normal">{t("export.prototype.optional")}</span></label>
                    <Input
                      value={exportAuthor}
                      onChange={e => setExportAuthor(e.target.value)}
                      placeholder={t("export.prototype.authorPh")}
                    />
                  </div>
                  <div className="space-y-1 w-24">
                    <label className="text-sm font-medium">{t("common:version")}</label>
                    <Input
                      value={exportVersion}
                      onChange={e => setExportVersion(e.target.value)}
                      placeholder="1.0.0"
                    />
                  </div>
                </div>
                {exportError && <p className="text-sm text-red-500">{exportError}</p>}
                <div className="flex justify-end gap-2">
                  <Button variant="outline" size="sm" onClick={() => setShowExportDialog(false)}>{t("common:cancel")}</Button>
                  <Button size="sm" onClick={handleExport} disabled={!exportName.trim() || exportLoading}>
                    {exportLoading && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}
                    {t("export.submit")}
                  </Button>
                </div>
              </>
            ) : exportType === "package" ? (
              <>
                <h3 className="font-semibold">{t("export.package.title")}</h3>
                <p className="text-xs text-muted-foreground">{t("export.package.desc")}</p>
                <div className="space-y-1">
                  <label className="text-sm font-medium">{t("export.package.select")}</label>
                  {instPackagesLoading ? (
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Loader2 className="h-3 w-3 animate-spin" /> {t("common:loading")}
                    </div>
                  ) : instPackages.length === 0 ? (
                    <p className="text-xs text-muted-foreground">{t("export.package.empty")}</p>
                  ) : (
                    <Select value={exportSelectedPackage || undefined} onValueChange={(v) => { if (v) setExportSelectedPackage(v) }}>
                      <SelectTrigger>
                        <SelectValue placeholder={t("export.package.ph")} />
                      </SelectTrigger>
                      <SelectContent>
                        {instPackages.map(p => (
                          <SelectItem key={p.name} value={p.name}>{p.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </div>
                {exportPackageError && <p className="text-sm text-red-500">{exportPackageError}</p>}
                <div className="flex justify-end gap-2">
                  <Button variant="outline" size="sm" onClick={() => setShowExportDialog(false)}>{t("common:cancel")}</Button>
                  <Button size="sm" onClick={handleExport} disabled={!exportSelectedPackage || exportPackageLoading}>
                    {exportPackageLoading && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}
                    {t("export.package.submit")}
                  </Button>
                </div>
              </>
            ) : (
              <>
                <h3 className="font-semibold">{t("export.skill.title")}</h3>
                <p className="text-xs text-muted-foreground">{t("export.skill.desc")}</p>
                <div className="space-y-1">
                  <label className="text-sm font-medium">{t("export.skill.select")}</label>
                  {instSkillsLoading ? (
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Loader2 className="h-3 w-3 animate-spin" /> {t("common:loading")}
                    </div>
                  ) : instSkills.length === 0 ? (
                    <p className="text-xs text-muted-foreground">{t("export.skill.empty")}</p>
                  ) : (
                    <Select value={exportSelectedSkill || undefined} onValueChange={(v) => { if (v) setExportSelectedSkill(v) }}>
                      <SelectTrigger>
                        <SelectValue placeholder={t("export.skill.ph")} />
                      </SelectTrigger>
                      <SelectContent>
                        {instSkills.map(s => (
                          <SelectItem key={s.name} value={s.name}>{s.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </div>
                {exportSkillError && <p className="text-sm text-red-500">{exportSkillError}</p>}
                <div className="flex justify-end gap-2">
                  <Button variant="outline" size="sm" onClick={() => setShowExportDialog(false)}>{t("common:cancel")}</Button>
                  <Button size="sm" onClick={handleExport} disabled={!exportSelectedSkill || exportSkillLoading}>
                    {exportSkillLoading && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}
                    {t("export.skill.submit")}
                  </Button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Overwrite confirm — same-named package/skill already exists in library */}
      <ConfirmDialog
        open={pendingOverwrite !== null}
        title={pendingOverwrite?.kind === "package" ? t("overwrite.title.package") : t("overwrite.title.skill")}
        message={t("overwrite.message", {
          lib: pendingOverwrite?.kind === "package" ? t("overwrite.lib.package") : t("overwrite.lib.skill"),
          name: pendingOverwrite?.name,
        })}
        variant="destructive"
        confirmText={t("overwrite.confirm")}
        onConfirm={handleConfirmOverwrite}
        onCancel={() => setPendingOverwrite(null)}
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

// ---- File tree recursive component ----

function FileTreeView({
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
        .map((node) => (
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
                    return <Icon className={`h-4 w-4 shrink-0 ${stColor(fileStatuses.get(node.path))}`} />
                  })()}
                </>
              ) : (
                <>
                  <span className="w-3 shrink-0" />
                  <FileText className={`h-4 w-4 shrink-0 ${stColor(fileStatuses.get(node.path))}`} />
                </>
              )}
              <span className={`flex-1 truncate text-sm ${stColor(fileStatuses.get(node.path))}`}>{node.name}</span>
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
                      return <Icon className={`h-4 w-4 shrink-0 ${stColor(fileStatuses.get(node.path))}`} />
                    })()}
                  </>
                ) : (
                  <>
                    <span className="w-3 shrink-0" />
                    <FileText className={`h-4 w-4 shrink-0 ${stColor(fileStatuses.get(node.path))}`} />
                  </>
                )}
                <span className={`flex-1 truncate text-sm ${stColor(fileStatuses.get(node.path))}`}>{node.name}</span>
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
        ))}
    </>
  )
}

