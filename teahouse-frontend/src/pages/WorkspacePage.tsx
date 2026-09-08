import { useEffect, useLayoutEffect, useState, useCallback, useRef, useMemo } from "react"
import { useTranslation } from "react-i18next"
import { useBlocker, useNavigate } from "react-router-dom"
import { MonacoEditor } from "@/components/MonacoEditor"
import { MarkdownRenderer } from "@/components/MarkdownRenderer"
import { PayloadViewer } from "@/components/PayloadViewer"
import { tryParsePayload, type PayloadMessage } from "@/utils/payloadView"
import {
  File, Folder, Loader2,
  Save, FileText,
  PanelLeftOpen, GripVertical, Archive,
  FolderTree, Menu, Gamepad2,
  Eye, Code2, BookOpen,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { instancesApi, gitApi, toFrontendPath, toBackendPath, ROOT, skillsApi, packagesApi, pluginsApi } from "@/lib/api"
import { useSessionStore } from "@/stores/sessionStore"
import { useViewModeStore } from "@/stores/viewModeStore"
import { useMobileLayoutStore, type MobileTab } from "@/stores/mobileLayoutStore"
import { useThemeStore } from "@/stores/themeStore"
import { useGitStore } from "@/stores/gitStore"
import { useSettingsDialogStore } from "@/stores/settingsDialogStore"
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
import { dialogStackStore } from "@/stores/dialogStackStore"
import type { FileTreeNode, TreeNodeRef, TreeClipboard, UndoableOp, TrashItem } from "@/lib/types"
import { applyFileChange } from "@/lib/fileTreeReducer"
import { collectAllEntries, pruneNestedItems } from "@/lib/fileTreeOps"
import { FileTreeView } from "./WorkspacePageComps/FileTreeView"
import { EditorTabs } from "./WorkspacePageComps/EditorTabs"
import { SaveDiscardDialog } from "./WorkspacePageComps/SaveDiscardDialog"
import { CreateDialog } from "./WorkspacePageComps/CreateDialog"
import { RenameDialog } from "./WorkspacePageComps/RenameDialog"
import { RootContextMenu } from "./WorkspacePageComps/RootContextMenu"
import { MobileTabBar } from "./WorkspacePageComps/MobileTabBar"
import { MobileHome } from "./WorkspacePageComps/MobileHome"
import { InstanceSkillsDialog } from "./SessionSelectPageComps/InstanceSkillsDialog"
import { InstancePackagesDialog } from "./SessionSelectPageComps/InstancePackagesDialog"
import { MobilePlayMenu } from "./WorkspacePageComps/MobilePlayMenu"
import { FileTreeGitBar } from "./WorkspacePageComps/FileTreeGitBar"
import { TreeMenu } from "./WorkspacePageComps/TreeMenu"
import { ExportDialog, type ExportDialogHandle } from "./WorkspacePageComps/ExportDialog"

// Monaco Editor theme follows system dark mode — handled by MonacoEditor component

// 编辑器标签页中单个已打开文件的 per-path 状态。key = 前端 path(root/...)。
export interface TabEntry {
  content: string                 // 磁盘基线（用于脏判定/保存后刷新）
  edited: string                  // 缓冲（Monaco/textarea 当前内容）
  dirty: boolean                  // 脏标记：edited !== content
  gitHead: string                 // git HEAD（diff 用；图片/新文件为 ""）
  isImage: boolean                // 图片预览文件（不经文本编辑）
  imageUri?: string | null        // 图片 data URI（切走/切回保留预览）
  imageMeta?: { w: number; h: number } | null
  payloadMessages: PayloadMessage[] | null
  payloadMeta: [string, string][]
}

export function WorkspacePage() {
  const { t } = useTranslation("workspace")
  const navigate = useNavigate()
  const activeInstance = useSessionStore((s) => s.activeInstance)
  const setActiveInstance = useSessionStore((s) => s.setActiveInstance)
  const mode = useViewModeStore((s) => s.mode)
  const chatWidth = useViewModeStore((s) => s.chatWidth)
  const chatCollapsed = useViewModeStore((s) => s.chatCollapsed)
  const setChatCollapsed = useViewModeStore((s) => s.setChatCollapsed)
  const setChatWidth = useViewModeStore((s) => s.setChatWidth)
  const isMobile = useIsMobile()
  const { isDark, toggleTheme } = useThemeStore()
  const openSettings = useSettingsDialogStore((s) => s.openSettings)

  // Mobile state
  const [showFileTree, setShowFileTree] = useState(false)
  // 文件树抽屉两阶段：关闭先播离场动画再真正隐藏（对齐导演抽屉）
  const [fileTreeClosing, setFileTreeClosing] = useState(false)
  const FILE_TREE_ANIM_MS = 200
  const [showMobileMenu, setShowMobileMenu] = useState(false)
  // 游玩中唤出的全屏导演浮层（复用外层常驻 ChatPanel，不退出游玩）
  const [playDirectorOpen, setPlayDirectorOpen] = useState(false)
  // 浮窗从右滑出离场动画：关闭先置 closing 保持渲染播完动画再真正隐藏
  const [overlayClosing, setOverlayClosing] = useState(false)
  const DIRECTOR_OVERLAY_ANIM_MS = 220
  // 游玩层退出动画：先播 slide-out-to-right 再真正 exitPlay（inPlay 驱动 SSE/交互，需等动画完）
  const [playClosing, setPlayClosing] = useState(false)
  const PLAY_ANIM_MS = 220
  // 导演不再是全屏弹层——已并入外层 director tab。fullscreenPanel 仅剩 git / files。
  const [fullscreenPanel, setFullscreenPanel] = useState<"git" | "files" | null>(null)
  useDialogBackClose(fullscreenPanel === "files", () => setFullscreenPanel(null), { route: "/workspace", kind: "filelist" })
  const inPlay = useMobileLayoutStore((s) => s.inPlay)
  const mobileTab = useMobileLayoutStore((s) => s.mobileTab)
  const enterPlay = useMobileLayoutStore((s) => s.enterPlay)
  const exitPlay = useMobileLayoutStore((s) => s.exitPlay)
  // 退出游玩：先播离场动画，播完再真正 exitPlay 回外层
  const animateExitPlay = useCallback(() => {
    if (!inPlay) return
    setPlayClosing(true)
    window.setTimeout(() => {
      setPlayClosing(false)
      exitPlay()
    }, PLAY_ANIM_MS)
  }, [inPlay, exitPlay])
  // 进入游玩：立即 inPlay，靠从右 slide-in 入场
  const animateEnterPlay = useCallback(() => {
    setPlayClosing(false)
    enterPlay()
  }, [enterPlay])
  // 关闭游玩导演浮窗：先播从右滑出的离场动画，动画完再真正隐藏（ChatPanel 常驻保 SSE）。
  const closePlayDirector = useCallback(() => {
    if (!playDirectorOpen) return
    // 已在离场动画中则忽略重复触发，避免排队多个 timeout
    setOverlayClosing((wasClosing) => {
      if (wasClosing) return true
      window.setTimeout(() => {
        setOverlayClosing(false)
        setPlayDirectorOpen(false)
      }, DIRECTOR_OVERLAY_ANIM_MS)
      return true
    })
  }, [playDirectorOpen])
  // 游玩中系统返回：导演浮层先收（若开着），否则退出游玩层回外层。由 useDialogBackClose
  // 栈序保证：浮层晚于游玩层压入，返回先弹浮层再弹游玩层。
  useDialogBackClose(playDirectorOpen, closePlayDirector, { route: "/workspace", kind: "play_director" })
  // 移动端系统返回：游玩层→回外层。外层空闲时无弹层压栈，系统返回会天然回退到会话主页
  // （= 退出实例），由 useDialogBackClose 的放行逻辑交给 Router 处理，无需额外压层。
  useDialogBackClose(inPlay, animateExitPlay, { route: "/workspace", kind: "play_stage" })

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
  // 编辑器标签页机制：同一时刻只有一个激活文件（selectedFile），但可打开多个标签
  // （openTabs 记录打开顺序，selectedFile = 当前激活下标对应用户打开中的那个）。每个已打开
  // 文件的内容/脏标记/阅读视图等全部 per-path 存进 tabStore（切走保留、切回不丢）。
  // key 统一用前端 path（root/...）。selectedFile 独立保留为激活 path，读写走 tabStore[selectedFile]。
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [openTabs, setOpenTabs] = useState<string[]>([])
  // 待离开的脏文件守卫（禁止原生 confirm）。打开中的文件带未保存更改时，离开动作
  // （关标签 / 移动端切文件 / 移动端退出 files 面板）都先经三选项确认：
  // 保存并离开 / 丢弃并离开 / 取消。kind 区分离开形态，target 记录切/退的具体目标。
  const [leavePending, setLeavePending] = useState<{
    path: string
    kind: "close" | "switch" | "exit"
    target?: string
  } | null>(null)
  const [tabStore, setTabStore] = useState<Record<string, TabEntry>>({})
  // 外部刷新当前文件时自增，触发 Monaco 按 key 重挂载（defaultValue 仅在 mount 读取）
  const [selectedFileVersion, setSelectedFileVersion] = useState(0)

  // 「阅读模式」持久化为 localStorage 布尔：开→受支持文件进阅读视图；关→进代码编辑。
  // 无独立开关——点「阅读」置 true、点「查看源码」置 false。此为全局渲染权威：
  // 渲染模式(readMode/editorView)统一由它实时派生、不 per-tab 固化——切入标签页时读的是
  // 当前最新值(用户切源码后，其它已开文件切回也显示源码)。state 使切换触发重渲染。
  const [readMode, setReadMode] = useState<boolean>(() => {
    try { return localStorage.getItem("teahouse_editor_read_mode") === "true" } catch { return false }
  })
  const persistReadMode = useCallback((on: boolean) => {
    setReadMode(on)
    try { localStorage.setItem("teahouse_editor_read_mode", String(on)) } catch { /* ignore */ }
  }, [])
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
  // 文件树容器根：可聚焦门控——树快捷键仅当焦点落在这里才生效，
  // 其余文本区域（导演对话等只读区）的 Ctrl+C/V 让位原生文本剪贴板。
  const treeRootRef = useRef<HTMLElement | null>(null)
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
  // 打开/关闭文件树抽屉：关闭先播离场动画再真正隐藏（对齐导演抽屉）
  const openFileTree = useCallback(() => {
    setFileTreeClosing(false)
    setShowFileTree(true)
  }, [])
  const closeFileTree = useCallback(() => {
    if (!showFileTree) return
    setFileTreeClosing((wasClosing) => {
      if (wasClosing) return true
      window.setTimeout(() => {
        setFileTreeClosing(false)
        setShowFileTree(false)
      }, FILE_TREE_ANIM_MS)
      return true
    })
  }, [showFileTree])
  // System back closes the mobile file-tree drawer and the export panel one level
  // at a time (nested with director above), instead of jumping straight home.
  useDialogBackClose(showFileTree, closeFileTree, { route: "/workspace", kind: "filetree" })
  useDialogBackClose(showExportDialog, () => setShowExportDialog(false), { route: "/workspace", kind: "export" })

  // 系统返回：当游玩层 / 文件树抽屉 / Export / Git / 导演栏抽屉开着时，均由托管(managed)层消费返回——
  // 这些层经 useDialogBackClose(route:"/workspace") 在移动端登记为 managed：只入内存栈、不压假 history 条目。
  // 因此关浮层(点 X/点文件/切会话)不会 history.back()，不再制造会被退出确认误拦的假 POP。

  // 移动端退出实例确认 —— 单一 useBlocker 状态机（托管设计后浏览器 history 在该页全归 router）。
  // 系统返回 = 一次真实 POP，被本 blocker 恒拦(仅 isMobile)，按当前托管栈路由：
  //   - 有 managed 浮层在栈顶 → closeTopManaged()(关一层) + blocker.reset()(丢弃导航、停留)
  //   - 空闲(栈空) → 弹退出确认；确认 proceed()(放行真实 POP 回上一层) / 取消 reset()(停留)
  // 只拦 POP：PUSH/REPLACE(如无实例时重定向 navigate("/")) 放行，不误拦程序化跳转。
  const blocker = useBlocker(({ historyAction }) => historyAction === "POP" && isMobile)
  const [showExitConfirm, setShowExitConfirm] = useState(false)
  // blocked 后路由：有浮层 → 关它；栈空 → 弹确认。用 blocker.state 变化驱动，避开 stale 闭包。
  useEffect(() => {
    if (blocker.state !== "blocked") { setShowExitConfirm(false); return }
    const top = dialogStackStore.getState().peekTopManaged()
    if (top) {
      dialogStackStore.getState().closeTopManaged()
      blocker.reset?.()
    } else {
      setShowExitConfirm(true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blocker.state])
  // 移动端「返回上一级」/「返回实例列表」按钮：触发一次 POP，被 blocker 拦下走同一确认流。
  const requestExitConfirm = useCallback(() => navigate(-1), [navigate])
  // 确认退出：放行被挂起的真实 POP(回上一层)。先兜底清 workspace 上可能的 legacy 假条目(managed 无假条目无副作用)，
  // 再放行；放行后本页已切离，此时清 activeInstance 不会触发本页「无实例 → 重定向」多余导航。
  const proceedExit = useCallback(() => {
    dialogStackStore.getState().clearForRoute("/workspace")
    setActiveInstance(null)
    setShowExitConfirm(false)
    blocker.proceed?.()
  }, [setActiveInstance, blocker])
  const cancelExit = useCallback(() => {
    setShowExitConfirm(false)
    blocker.reset?.()
  }, [blocker])

  const instId = activeInstance?.id

  // 移动端外层「首页」tab 的实例内容快速入口：插件(全局已启用)/ Skill / 提示词包(实例内已装/已启用)。
  // Skill/提示词包打开实例级管理弹层；插件打开设置「插件」tab。每次切回 home 刷新一次数字。
  const [manageSkillsOpen, setManageSkillsOpen] = useState(false)
  const [managePackagesOpen, setManagePackagesOpen] = useState(false)
  const [contentCounts, setContentCounts] = useState<{ plugins: number; skill: number; pkg: number } | null>(null)
  const [contentCountsLoading, setContentCountsLoading] = useState(false)
  const loadContentCounts = useCallback(() => {
    if (!instId || !isMobile) return
    setContentCounts(null)
    setContentCountsLoading(true)
    Promise.all([
      pluginsApi.list(),
      packagesApi.listInInstance(instId),
      skillsApi.listForInstance(instId),
    ]).then(([plg, pkg, skl]) => {
      setContentCounts({
        plugins: plg.ok ? (plg.data?.plugins.filter((p) => p.enabled).length ?? 0) : 0,
        pkg: pkg.ok ? (pkg.data?.packages.length ?? 0) : 0,
        skill: skl.ok ? (skl.data?.filter((s) => s.source === "instance" && s.has_skill).length ?? 0) : 0,
      })
    }).catch(() => { }).finally(() => setContentCountsLoading(false))
  }, [instId, isMobile])
  useEffect(() => { if (mobileTab === "home") loadContentCounts() }, [mobileTab, loadContentCounts])


  // 激活文件（selectedFile）的 per-path 条目。无激活文件时为 undefined。
  const activeEntry: TabEntry | undefined = selectedFile ? tabStore[selectedFile] : undefined
  // 以下便捷取读仅供渲染/动作栏沿用旧名（守卫保证只在 selectedFile 非空分支使用）。
  // isImageOpen：当前激活是否为图片预览
  const isImageOpen = !!activeEntry?.isImage
  const editedContent = activeEntry?.edited ?? ""
  const isDirty = !!activeEntry?.dirty
  const imageDataUri = activeEntry?.imageUri ?? null
  const imageMeta = activeEntry?.imageMeta ?? null
  const gitHeadContent = activeEntry?.gitHead ?? null
  const payloadMessages = activeEntry?.payloadMessages ?? null
  const payloadMeta = activeEntry?.payloadMeta ?? []

  // 当前文件是否为 Markdown（决定是否显示阅读切换）
  const isMarkdown = !!selectedFile?.endsWith(".md")
  // 当前文件内容是否能解析出 payload messages（决定是否显示「Payload 阅读」切换）
  const isPayloadFile = payloadMessages !== null
  // 当前文件受阅读模式支持（md 必有；payload 需能解析出 messages）
  const supportsRead = isMarkdown || isPayloadFile
  // 当前激活文件的渲染模式：全局阅读偏好(readMode)实时派生，不 per-tab 固化——切入标签页读
  // 的是当前最新值。开阅读→受支持文件进对应阅读视图；关阅读(查看源码)→一律代码编辑。
  const editorView: "code" | "preview" | "payload" = readMode && isMarkdown
    ? "preview"
    : readMode && isPayloadFile
      ? "payload"
      : "code"

  // 图片扩展名判定——此类文件不进入文本编辑器，改为在工作区直接渲染 <img>
  const IMAGE_EXTS = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".avif"]
  const isImageFile = (p: string | null | undefined) => {
    if (!p) return false
    const lower = p.toLowerCase()
    return IMAGE_EXTS.some((ext) => lower.endsWith(ext))
  }

  // 进入 workspace 时设置默认 mode。宽屏保留 play/backstage 互斥切换；移动端已改用
  // 两层布局（外层三 tab + 独立游玩层），不读 mode，这里仅保证桌面初始合理。
  const defaultModeAppliedRef = useRef(false)
  if (!defaultModeAppliedRef.current) {
    defaultModeAppliedRef.current = true
    useViewModeStore.getState().setMode("backstage")
  }

  // 移动端底部 tab 切换守卫：从 files 切到其它 tab、当前文件带未保存更改时先经三选项确认。
  // 由 MobileTabBar(onTabChange) 与 openDirector 共用，统一不漏。当前 tab 经 store 现读，
  // 免闭包捕获陈旧值（本函数 identity 稳定，openDirector 可直接复用）。
  const guardedSwitchTab = useCallback((next: MobileTab) => {
    const leavingFiles = useMobileLayoutStore.getState().mobileTab === "files" && next !== "files"
    const cur = selectedFileRef.current
    if (leavingFiles && cur && isDirtyRef.current) {
      setLeavePending({ path: cur, kind: "exit", target: next })
      return
    }
    useMobileLayoutStore.getState().setMobileTab(next)
  }, [])

  // 唤起导演栏：桌面端展开折叠的 ChatPanel；移动端若在游玩层→盖全屏导演浮层（不退出游玩），
  // 否则切到外层 director tab。
  const openDirector = useCallback(() => {
    if (isMobile) {
      if (inPlay) {
        setOverlayClosing(false)
        setPlayDirectorOpen(true)
      } else {
        guardedSwitchTab("director")
      }
    } else {
      setChatCollapsed(false)
    }
  }, [isMobile, inPlay, guardedSwitchTab])

  // Git state — file statuses for tree coloring from unified store. The store
  // keys ARE bare backend paths; map them to "root/..." so they match tree nodes.
  const fileStatuses = useGitStore((s) => s.fileStatuses)
  const fileStatusesRoot = useMemo(() => {
    const m = new Map<string, string>()
    for (const [k, v] of fileStatuses) m.set(toFrontendPath(k), v)
    return m
  }, [fileStatuses])

  // Git derivations for the file-tree bottom Git bar (branch / latest commit / counts)
  const gitStatus = useGitStore((s) => s.gitStatus)
  const latestCommitMsg = gitStatus?.recent_commits?.[0]?.message
  const currentBranch = gitStatus?.current_branch || "main"
  const changeCounts = { added: 0, modified: 0, deleted: 0 }
  for (const st of fileStatuses.values()) {
    if (st === "A" || st === "?") changeCounts.added++
    else if (st === "M" || st === "R") changeCounts.modified++
    else if (st === "D") changeCounts.deleted++
  }
  const openGit = () => setFullscreenPanel("git")

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

  // File content is loaded by `openFile` (load-first + key remount). Reset the
  // editor state whenever the instance changes. Entering an instance also clears
  // its recycle bin (backend) + the undo/redo stacks (frontend) — undo lives
  // only for the current active session (single frontend link).
  useEffect(() => {
    setSelectedFile(null)
    setOpenTabs([])
    setLeavePending(null)
    setTabStore({})
    setSelectedFileVersion(0)
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
  }, [isDirty, selectedFile, instId])

  // 写盘指定文件（默认当前激活文件）。成功后清脏并刷新 git 状态。
  const saveFile = async (targetPath?: string) => {
    if (!instId) return false
    const path = targetPath ?? selectedFileRef.current
    if (!path) return false
    const entry = tabStoreRef.current[path]
    if (!entry) return false
    setIsSaving(true)
    const res = await instancesApi.writeFile(instId, path, entry.edited)
    if (res.ok) {
      const parsed = tryParsePayload(entry.edited)
      setTabStore((prev) => (prev[path] ? {
        ...prev,
        [path]: {
          ...prev[path],
          content: entry.edited,
          dirty: false,
          payloadMessages: parsed ? parsed.messages : null,
          payloadMeta: parsed ? parsed.meta : [],
        },
      } : prev))
      if (instId) useGitStore.getState().fetchGitStatus(instId)
      showSaveToast()
    }
    setIsSaving(false)
    return res.ok
  }

  // 历史入口名：只保存当前激活文件。
  const handleSave = () => saveFile()

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
    // Remap any open tab under the renamed entry / directory to the new path.
    remapOpenTabPaths(oldPath, newPath)
    applyLocalStructural({ type: "moved", path: newPath, prevPath: oldPath })
    pushUndo({
      undo: async () => {
        const rr = await instancesApi.renameEntry(instId!, newPath, oldPath.split("/").pop()!)
        if (!rr.ok) return
        remapOpenTabPaths(newPath, oldPath)
        await refresh()
      },
      redo: async () => {
        const rr = await instancesApi.renameEntry(instId!, oldPath, newName)
        if (!rr.ok) return
        remapOpenTabPaths(oldPath, newPath)
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
  // Mirror openTabs order so removeTab/closeTab closures can compute the active
  // fallback synchronously outside a setState updater.
  const openTabsRef = useRef(openTabs)
  openTabsRef.current = openTabs
  // Mirror the active entry so closures (SSE / async reloads) read latest without deps.
  const tabStoreRef = useRef(tabStore)
  tabStoreRef.current = tabStore
  // 桌面阅读视图（Markdown preview / Payload）滚动位置，按 path + 视图类型记忆。
  // Monaco 代码视图走 key 全量重挂、天然单文件无需记忆；此处只管同文件 code↔read 切换时
  // display:none→重显导致的 scrollTop 归零问题。
  const readScrollRef = useRef<Record<string, { preview: number; payload: number }>>({})
  const previewScrollElRef = useRef<HTMLDivElement | null>(null)
  const payloadScrollElRef = useRef<HTMLDivElement | null>(null)
  // 中间面板（标签栏+按钮栏+Monaco/阅读器）根容器：ESC 关标签的门控边界——
  // 焦点落在此容器内才响应，落在文件树/导演栏/对话框(modal)时放行。
  const editorPanelRef = useRef<HTMLDivElement | null>(null)

  // 阅读视图切换/换文件后，恢复当前激活文件的阅读滚动位置（容器从 hidden 变可见需等 DOM
  // 布置完再 scroll；内容渲染是异步的，故再 rAF 一层兜底）。code↔read 切换保留；切文件时
  // key 重挂容器 scrollTop 归零，读到的是上次为该 path 存的旧值，这里一并恢复。
  useLayoutEffect(() => {
    if (!selectedFile) return
    if (editorView === "preview" && previewScrollElRef.current) {
      const saved = readScrollRef.current[selectedFile]?.preview ?? 0
      if (saved > 0) {
        requestAnimationFrame(() => {
          if (previewScrollElRef.current) previewScrollElRef.current.scrollTop = saved
        })
      }
    } else if (editorView === "payload" && payloadScrollElRef.current) {
      const saved = readScrollRef.current[selectedFile]?.payload ?? 0
      if (saved > 0) {
        requestAnimationFrame(() => {
          if (payloadScrollElRef.current) payloadScrollElRef.current.scrollTop = saved
        })
      }
    }
  }, [selectedFile, editorView, isMarkdown, isPayloadFile])

  // Keep a ref for the active file's dirty flag so SSE callback can check without
  // depending on state. Syncs whenever the active path or its entry changes.
  const isDirtyRef = useRef(false)
  isDirtyRef.current = !!activeEntry?.dirty

  // Keep refs for the active loaded baseline + git HEAD + image URI so async
  // reloads can compare against current state without taking a dependency on
  // them (the active entry may change mid-flight).
  const fileContentRef = useRef("")
  fileContentRef.current = activeEntry?.content ?? ""
  const gitHeadContentRef = useRef<string | null>(null)
  gitHeadContentRef.current = activeEntry?.gitHead ?? null
  const imageDataUriRef = useRef<string | null>(null)
  imageDataUriRef.current = activeEntry?.imageUri ?? null

  // 激活某个 path：若已在 openTabs 则仅切换激活，否则追加为打开顺序尾部的新标签。
  // 首次打开时外部已构造好 entry 并写入 tabStore（调用方 setTabStore 后调此函数）。
  const activateTab = useCallback((path: string) => {
    setOpenTabs((prev) => (prev.includes(path) ? prev : [...prev, path]))
    setSelectedFile(path)
    setSelection([{ path, type: "file", name: path.split("/").pop() || path }])
  }, [])

  // 用新 entry 打开并激活一个 path（覆盖/初始化该 path 的 tabStore 条目）。
  const openTab = useCallback((path: string, entry: TabEntry) => {
    setTabStore((prev) => ({ ...prev, [path]: entry }))
    activateTab(path)
  }, [activateTab])

  // 强制移除某标签（ConfirmDialog 确认丢弃脏内容后 / 干净标签关闭 / 文件被删）。
  const removeTab = useCallback((path: string) => {
    const wasActive = selectedFileRef.current === path
    // 关闭的是激活标签 → 关闭后激活右邻（无右邻则左邻）；关唯一标签 → 回空态。
    if (wasActive) {
      const list = openTabsRef.current
      const idx = list.indexOf(path)
      const rest = list.filter((p) => p !== path)
      const fallback = rest[idx] ?? rest[idx - 1] ?? null
      setSelectedFile(fallback)
      if (fallback) setSelection([{ path: fallback, type: "file", name: fallback.split("/").pop() || fallback }])
      else setSelection([])
    }
    setTabStore((prev) => {
      if (!(path in prev)) return prev
      const next = { ...prev }
      delete next[path]
      return next
    })
    setOpenTabs((prev) => (prev.includes(path) ? prev.filter((p) => p !== path) : prev))
  }, [])

  // 关闭 path 对应的标签。脏标签 → 记入 leavePending(kind=close) 交由三选项守卫确认
  // （不直接删，保未保存内容）；干净标签直接关闭。
  const closeTab = useCallback((path: string) => {
    const entry = tabStoreRef.current[path]
    if (entry?.dirty) {
      setLeavePending({ path, kind: "close" })
      return
    }
    removeTab(path)
  }, [removeTab])

  // 丢弃某文件的未保存内容：把编辑缓冲还原为磁盘基线（保留标签可再读）。
  const discardChanges = useCallback((path: string) => {
    setTabStore((prev) => (prev[path] ? {
      ...prev,
      [path]: {
        ...prev[path],
        edited: prev[path].content,
        dirty: false,
      },
    } : prev))
  }, [])

  // 离开确认「取消」：留在当前文件/标签，清守卫。
  const cancelLeave = useCallback(() => {
    setLeavePending(null)
  }, [])

  // 三选项离开的公共收尾：清除守卫并执行真正的离开动作。kind=switch 切激活文件、
  // kind=exit 切底部 tab、kind=close 关标签（丢弃分支调用方已先把内容还原到基线）。
  function resolveLeave(path: string, kind: "close" | "switch" | "exit", target: string | undefined) {
    setLeavePending(null)
    if (kind === "close") {
      removeTab(path)
    } else if (kind === "switch") {
      if (target && target !== selectedFileRef.current) openFile(target)
    } else if (kind === "exit") {
      if (target) useMobileLayoutStore.getState().setMobileTab(target as MobileTab)
    }
  }

  // 丢弃并离开：丢弃未保存内容后执行离开。关闭标签本就会移除脏内容，无需先还原；
  // 切换/退出 files 则还原该文件为磁盘基线、保留标签。
  const confirmDiscardLeave = () => {
    if (!leavePending) return
    const { path, kind, target } = leavePending
    if (kind === "switch" || kind === "exit") discardChanges(path)
    resolveLeave(path, kind, target)
  }

  // 保存并离开：写盘成功后执行离开；写盘失败留在原处不关闭守卫。
  const confirmSaveLeave = async () => {
    if (!leavePending) return
    const { path, kind, target } = leavePending
    const ok = await saveFile(path)
    if (!ok) return
    resolveLeave(path, kind, target)
  }

  // 把已开标签里所有挂在 oldPath（自身或其目录前缀）下的键迁移到 newPath。
  // rename/move（含 undo/redo）后调用，让标签/激活/内容状态跟随文件新位置。
  function remapOpenTabPaths(oldPath: string, newPath: string) {
    setOpenTabs((prev) => {
      if (!prev.some((p) => p === oldPath || p.startsWith(oldPath + "/"))) return prev
      return prev.map((p) => p === oldPath ? newPath : p.startsWith(oldPath + "/") ? newPath + p.slice(oldPath.length) : p)
    })
    setTabStore((prev) => {
      const keys = Object.keys(prev).filter((p) => p === oldPath || p.startsWith(oldPath + "/"))
      if (!keys.length) return prev
      const next = { ...prev }
      for (const k of keys) {
        const nk = k === oldPath ? newPath : newPath + k.slice(oldPath.length)
        next[nk] = next[nk] ? { ...next[k], ...next[nk] } : next[k]
        delete next[k]
      }
      return next
    })
    if (selectedFileRef.current === oldPath || selectedFileRef.current?.startsWith(oldPath + "/")) {
      const cur = selectedFileRef.current
      setSelectedFile(cur === oldPath ? newPath : newPath + cur.slice(oldPath.length))
    }
  }

  // 更新激活文件（selectedFile）的编辑缓冲 + 脏标记。桌面 Monaco / 移动 textarea onChange 共用。
  const updateActiveEdited = useCallback((value: string) => {
    const path = selectedFileRef.current
    if (!path) return
    setTabStore((prev) => (prev[path] ? {
      ...prev,
      [path]: { ...prev[path], edited: value, dirty: value !== prev[path].content },
    } : prev))
  }, [])

  // ESC 关闭当前文件标签——快捷键绑定在"编辑器栏整块"（中间面板：标签栏+按钮栏+Monaco/
  // 阅读器）而非仅 Monaco 内部，故阅读/代码/标签栏任意处聚焦均生效。门控：焦点落在此面板
  // 容器内才响应；文件树/导演栏/对话框(modal 在面板之外)聚焦时放行，避免误关标签或与
  // 对话框自身 ESC 语义冲突。桌面端有该面板，移动端无 Monaco/标签栏故不适用。
  useEffect(() => {
    if (isMobile) return
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return
      const panel = editorPanelRef.current
      // 焦点不在编辑器面板内（或根本没有激活文件/标签）→ 放行
      if (!panel || !panel.contains(document.activeElement)) return
      if (!selectedFileRef.current) return
      e.preventDefault()
      closeTab(selectedFileRef.current)
    }
    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [isMobile, closeTab])

  // Load a file (content + git HEAD) then open it. Loads first so Monaco mounts
  // once with the correct defaultValue and a clean undo stack.
  const openFile = useCallback(async (path: string) => {
    if (!instId) return
    // 打开/激活即确保父目录链展开，树高亮可见（占位符跳转或深层打开时目标目录可能未展开）。
    setExpanded(prev => {
      let changed = false
      const next = new Set(prev)
      let dir = parentOf(path)
      while (dir) {
        if (!next.has(dir)) { next.add(dir); changed = true }
        const i = dir.lastIndexOf("/")
        if (i < 0) break
        dir = dir.slice(0, i)
      }
      return changed ? next : prev
    })
    if (path === selectedFileRef.current) return
    // 若该文件的标签已打开（可能带未保存内容/滚动/阅读视图）→ 仅切换激活，不重读覆盖，
    // 保留其当前编辑状态。
    if (openTabs.includes(path)) {
      activateTab(path)
      return
    }
    const seq = ++loadSeqRef.current

    // 图片文件走 readAsset 渲染，不经历文本加载/脏标记/编辑器挂载。
    if (isImageFile(path)) {
      const [assetRes] = await Promise.all([
        instancesApi.readAsset(instId, path),
        gitApi.showFile(instId, path).catch(() => ({ ok: false as const })),
      ])
      if (seq !== loadSeqRef.current) return // stale response
      if (!assetRes.ok) return // file gone; keep current selection
      openTab(path, {
        content: "",
        edited: "",
        dirty: false,
        gitHead: "",
        isImage: true,
        imageUri: `data:${assetRes.data!.mime};base64,${assetRes.data!.data}`,
        imageMeta: assetRes.data!.size ? { w: assetRes.data!.size[0], h: assetRes.data!.size[1] } : null,
        payloadMessages: null,
        payloadMeta: [],
      })
      return
    }

    const [fileRes, headRes] = await Promise.all([
      instancesApi.readText(instId, path),
      gitApi.showFile(instId, path),
    ])
    if (seq !== loadSeqRef.current) return // stale response
    if (!fileRes.ok) return // file gone; keep current selection
    const content = fileRes.data!.content
    const head = headRes.ok && headRes.data?.content != null ? headRes.data.content : ""
    const parsed = tryParsePayload(content)
    // 渲染模式(阅读/代码)由全局 readMode 在渲染期实时派生，不在打开时固化到 entry。
    openTab(path, {
      content,
      edited: content,
      dirty: false,
      gitHead: head,
      isImage: false,
      imageUri: null,
      imageMeta: null,
      payloadMessages: parsed ? parsed.messages : null,
      payloadMeta: parsed ? parsed.meta : [],
    })
  }, [instId, parentOf, openTabs, activateTab, openTab])


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
        removeTab(path) // 资产消失 → 关闭该标签（clean，直接关）
        return
      }
      const nextUri = `data:${res.data!.mime};base64,${res.data!.data}`
      if (nextUri === imageDataUriRef.current) return
      setTabStore((prev) => (prev[path] ? {
        ...prev,
        [path]: { ...prev[path], imageUri: nextUri, imageMeta: res.data!.size ? { w: res.data!.size[0], h: res.data!.size[1] } : null },
      } : prev))
      return
    }

    const [fileRes, headRes] = await Promise.all([
      instancesApi.readText(instId, path),
      gitApi.showFile(instId, path),
    ])
    if (seq !== loadSeqRef.current) return
    if (!fileRes.ok) {
      removeTab(path) // 文件消失 → 关闭该标签（clean，直接关）
      return
    }
    const content = fileRes.data!.content
    const head = headRes.ok && headRes.data?.content != null ? headRes.data.content : ""
    if (content === fileContentRef.current && head === gitHeadContentRef.current) return
    const parsed = tryParsePayload(content)
    setTabStore((prev) => (prev[path] ? {
      ...prev,
      [path]: {
        ...prev[path],
        content,
        edited: content,
        gitHead: head,
        dirty: false,
        isImage: false,
        imageUri: null,
        imageMeta: null,
        payloadMessages: parsed ? parsed.messages : null,
        payloadMeta: parsed ? parsed.meta : [],
      },
    } : prev))
    setSelectedFileVersion((v) => v + 1) // 仅内容变化时自增 → Monaco 按 key 重挂
  }, [instId, removeTab])

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
  // 若 path 是被删除/撤销移除的文件（或含其目录），则关闭对应标签、清空编辑器。
  const closeEditorFor = useCallback((path: string) => {
    // 收集所有受影响（path 自身或其目录前缀匹配）的已开标签，逐个关闭。
    const affected = openTabsRef.current.filter((p) => p === path || p.startsWith(path + "/"))
    if (!affected.length) return
    affected.forEach((p) => removeTab(p))
  }, [removeTab])

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
      // Remap any open tab under the moved entry / directory to its new location.
      const base = srcPath.split("/").pop() ?? srcPath
      const newPath = destParent ? `${destParent}/${base}` : base
      remapOpenTabPaths(srcPath, newPath)
      await refresh()
      // drag&drop 移动可撤销：undo 移回原父目录。
      const fromParent = parentOf(srcPath)
      pushUndo({
        undo: async () => {
          const rr = await instancesApi.moveEntry(instId!, newPath, fromParent)
          if (!rr.ok) return
          remapOpenTabPaths(newPath, srcPath)
          await refresh()
        },
        redo: async () => {
          const rr = await instancesApi.moveEntry(instId!, srcPath, destParent)
          if (!rr.ok) return
          remapOpenTabPaths(srcPath, newPath)
          await refresh()
        },
      })
    } finally {
      moveInFlightRef.current = false
    }
  }, [instId, refresh, parentOf, pushUndo])

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
        // Remap any open tab under the moved entry / directory to its new location.
        const base = srcPath.split("/").pop() ?? srcPath
        const newPath = target ? `${target}/${base}` : base
        remapOpenTabPaths(srcPath, newPath)
        // cut-move undo：移回原父目录。
        pushUndo({
          undo: async () => {
            const rr = await instancesApi.moveEntry(instId!, newPath, fromParent)
            if (!rr.ok) return
            remapOpenTabPaths(newPath, srcPath)
            await refresh()
          },
          redo: async () => {
            const rr = await instancesApi.moveEntry(instId!, srcPath, target)
            if (!rr.ok) return
            remapOpenTabPaths(srcPath, newPath)
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
      const fullReload = type === "__full_reload"
      if (fullReload) {
        // Burst mixed structural + content events in a way a single event can't
        // reconstruct (e.g. mkdir + write, or Generate's payload + .meta) —
        // reload the whole tree as the safe convergence path.
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
      if (fullReload) {
        // The delivered path is just one of several changed files, so we can't
        // tell whether the open file is among them — reload it unconditionally
        // (dirty edits preserved). Without this an open payload JSON stays stale
        // after a dry-run that rewrites it back-to-back with its .meta.
        if (selectedFileRef.current && !isDirtyRef.current) reloadOpenFile()
        return
      }
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

  // 键盘粘贴目标锚点：selection 最后一项 → 目录则其内、文件则其父目录；空则 root。
  const pasteAnchor = useCallback((): string => {
    const sel = selectionRef.current
    if (!sel.length) return ROOT
    const last = sel[sel.length - 1]
    return last.type === "directory" ? last.path : parentOf(last.path)
  }, [parentOf])

  // 文件树容器自身可聚焦（tabIndex=-1）。指针按下命中树时把焦点领进树，
  // 使后续键盘快捷键（Del/方向/Ctrl+A/C/X/V）只作用于文件树、不再抢对话/输出区。
  const focusTreeRoot = useCallback(() => {
    treeRootRef.current?.focus()
  }, [])

  // 文件树键盘快捷键（VSCode 式）：Ctrl+A/C/X/V、Del/Backspace、Ctrl+Z/Y。
  // 仅当焦点落在文件树容器内才生效（inclusion 门控）。编辑器/输入框/导演对话
  // 等其它焦点一律让位原生行为——那里不该因"点开文件"而复制成当前文件。
  useEffect(() => {
    if (!instId) return
    const handler = (e: KeyboardEvent) => {
      const root = treeRootRef.current
      // 焦点不在文件树容器内 → 完全放行，绝不拦截任何键（含 Esc/Del/Ctrl+C/V）。
      if (!root || !root.contains(document.activeElement)) return
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
  }, [instId, pasteAnchor, copyEntry, cutEntry, pasteEntry, beginDelete, runUndo, runRedo])

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

  // 三选项守卫：离开带未保存更改的文件（禁止原生 confirm）。覆盖桌面关标签 / 移动端
  // 切文件 / 退出 files 面板。kind 决定标题正文文案。
  const dirtyLeaveDialog = (
    <SaveDiscardDialog
      open={leavePending !== null}
      title={leavePending
        ? leavePending.kind === "close" ? t("dirtyLeave.closeTitle")
          : leavePending.kind === "switch" ? t("dirtyLeave.switchTitle")
            : t("dirtyLeave.exitTitle")
        : ""}
      message={leavePending
        ? leavePending.kind === "close" ? t("dirtyLeave.closeMessage", { path: leavePending.path })
          : leavePending.kind === "switch" ? t("dirtyLeave.switchMessage", { path: leavePending.path })
            : t("dirtyLeave.exitMessage", { path: leavePending.path })
        : ""}
      saveText={t("dirtyLeave.save")}
      discardText={t("dirtyLeave.discard")}
      cancelText={t("common:cancel")}
      onSave={confirmSaveLeave}
      onDiscard={confirmDiscardLeave}
      onCancel={cancelLeave}
    />
  )

  // ============================================================================
  // Mobile layout
  // ============================================================================
  if (isMobile) {
    return (
      <div className="h-full flex flex-col overflow-hidden bg-background relative">
        {/* ===== 独立全屏游玩层（常驻挂载保 SSE，inPlay 时覆盖外层；从右滑入/滑出） ===== */}
        <div className={`${inPlay || playClosing
            ? `${playClosing
                ? "absolute inset-0 z-40 flex flex-col bg-background animate-out slide-out-to-right duration-[220ms] fill-mode-forwards"
                : "absolute inset-0 z-40 flex flex-col bg-background animate-in slide-in-from-right duration-[220ms]"}`
            : "hidden"}`}>
          <div className="relative flex-1 flex flex-col min-h-0">
            <OutputPanel instanceId={instId} instanceName={activeInstance?.name} onSend={(msg) => useSessionStore.getState().setPendingMessage(msg)} onOpenDirector={openDirector} />
            {/* 游玩层悬浮球（常驻，仅保留三项：退出游玩/版本控制/主题） */}
            {inPlay && (
              <>
                <div className="absolute top-3 right-3 z-30">
                  <button
                    className="px-3 py-2 rounded-full bg-primary text-primary-foreground shadow-lg flex items-center gap-1.5 text-xs font-medium active:scale-95 transition-transform"
                    onClick={() => setShowMobileMenu(!showMobileMenu)}
                    title={t("menuTitle")}
                  >
                    <Gamepad2 className="h-3.5 w-3.5" />
                    <Menu className="h-3.5 w-3.5" />
                  </button>
                  {showMobileMenu && (
                    <MobilePlayMenu
                      isDark={isDark}
                      onExitPlay={() => { animateExitPlay(); setShowMobileMenu(false) }}
                      onOpenDirector={() => { openDirector(); setShowMobileMenu(false) }}
                      onOpenGit={() => { setFullscreenPanel("git"); setShowMobileMenu(false) }}
                      onToggleTheme={() => { toggleTheme(); setShowMobileMenu(false) }}
                      onClose={() => setShowMobileMenu(false)}
                    />
                  )}
                </div>
              </>
            )}
          </div>
        </div>

        {/* ===== 外层：home / files 内容（不含导演 tab——导演 ChatPanel 独立常驻，见下） ===== */}
        <div className={`${!inPlay && mobileTab !== "director" ? "flex-1 flex flex-col min-h-0 overflow-hidden" : "hidden"}`}>
          {/* home tab */}
          {mobileTab === "home" && (
            <MobileHome
              instanceName={activeInstance?.name ?? ""}
              onEnterPlay={animateEnterPlay}
              onOpenModel={() => openSettings("slots")}
              onOpenFiles={() => { setFullscreenPanel("files"); setShowMobileMenu(false) }}
              onOpenGit={() => { setFullscreenPanel("git") }}
              changeCounts={changeCounts}
              onBackToHome={requestExitConfirm}
              counts={contentCounts}
              countsLoading={contentCountsLoading}
              onOpenPlugins={() => openSettings("plugins")}
              onOpenSkills={() => setManageSkillsOpen(true)}
              onOpenPackages={() => setManagePackagesOpen(true)}
            />
          )}

          {/* files tab — 编辑器（文件状态在 WorkspacePage，故挂载即留存） */}
          {mobileTab === "files" && (
            <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
              {/* 顶部栏：文件树触发器（icon + 文件名一体）+ 保存 */}
              <div className="flex items-center gap-2 px-2 h-14 border-b border-border shrink-0">
                <button
                  className="flex items-center gap-2 min-w-0 flex-1 rounded px-1.5 py-1.5 hover:bg-muted"
                  onClick={openFileTree}
                  title={t("fileTreeTitle")}
                >
                  <FolderTree className="h-5 w-5 shrink-0 text-muted-foreground" />
                  <span className="text-sm truncate">
                    {selectedFile
                      ? <span className="text-foreground font-mono">{selectedFile}</span>
                      : <span className="text-muted-foreground">{t("noFileSelected")}</span>}
                  </span>
                </button>
                {selectedFile && !isImageOpen && (
                  <div className="flex items-center gap-2 shrink-0">
                    {isDirty && <span className="text-xs text-orange-500">{t("unsaved")}</span>}
                    {supportsRead && (editorView === "code" ? (
                      <Button size="sm" variant="ghost" onClick={() => persistReadMode(true)} className="gap-1" title={isMarkdown ? t("mdRead") : t("payload")}>
                        {isMarkdown ? <Eye className="h-3 w-3" /> : <BookOpen className="h-3 w-3" />}
                        {isMarkdown ? t("mdRead") : t("payload")}
                      </Button>
                    ) : (
                      <Button size="sm" variant="ghost" onClick={() => persistReadMode(false)} className="gap-1" title={t("viewSource")}>
                        <Code2 className="h-3 w-3" />
                        {t("viewSource")}
                      </Button>
                    ))}
                    <Button size="sm" variant="outline" onClick={handleSave} disabled={!isDirty || isSaving} className="gap-1">
                      {isSaving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
                      {t("common:save")}
                    </Button>
                  </div>
                )}
              </div>
              {selectedFile ? (
                isImageOpen ? (
                  <div className="flex-1 overflow-auto flex items-start justify-center p-4">
                    <img src={imageDataUri ?? undefined} alt={selectedFile} className="max-w-full max-h-full object-contain rounded shadow-sm" />
                  </div>
                ) : isMarkdown && editorView === "preview" ? (
                  <div className="flex-1 overflow-auto">
                    <MarkdownRenderer content={editedContent} onOpenPath={(p) => openFile(toFrontendPath(p))} />
                  </div>
                ) : isPayloadFile && editorView === "payload" ? (
                  <div className="flex-1 overflow-auto">
                    <PayloadViewer messages={payloadMessages!} meta={payloadMeta} />
                  </div>
                ) : (
                  <textarea
                    className="flex-1 w-full resize-none bg-background text-foreground p-4 font-mono text-sm outline-none border-0"
                    value={editedContent}
                    onChange={(e) => updateActiveEdited(e.target.value)}
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

        {/* ===== 导演 ChatPanel：常驻单实例（保 SSE）。三态——
            ① 外层 director tab 页：flex 占 content（底部还有 tab 栏），右上角无关闭钮；
            ② 游玩中唤出的导演栏：全屏覆盖盖在游玩层之上，右上角带关闭钮（关闭即隐藏、保 SSE）。
               从右侧滑入/滑出（closing 期间保持渲染播完离场）。z-45 介于游玩层(z-40)与设置弹窗(z-50)。
            ③ 其它：隐藏但保持挂载。 ===== */}
        <div
          className={
            inPlay
              ? playDirectorOpen || overlayClosing
                ? overlayClosing
                  ? "absolute inset-0 z-[45] flex flex-col bg-background animate-out slide-out-to-right duration-[220ms] fill-mode-forwards"
                  : "absolute inset-0 z-[45] flex flex-col bg-background animate-in slide-in-from-right duration-[220ms]"
                : "hidden"
              : mobileTab === "director"
                ? "flex-1 flex flex-col min-h-0"
                : "hidden"
          }
        >
          {/* 浮层形态传 onClosePanel → ChatHeader 右上角出关闭钮；外层 director 页不传 → 空白 */}
          <ChatPanel
            onClosePanel={inPlay && playDirectorOpen ? closePlayDirector : undefined}
          />
        </div>

        {/* 底部常驻 tab 栏 */}
        {!inPlay && <MobileTabBar onTabChange={guardedSwitchTab} />}

        {/* Fullscreen panels：git / files（导演已并入 tab，不再全屏）。
            GitDialog 常驻渲染以支持移动端进出动画（内部按 open/closing 自管理显隐） */}
        <GitDialog
          instanceId={instId!}
          open={fullscreenPanel === "git"}
          onClose={() => setFullscreenPanel(null)}
          onRefresh={() => { refresh(); setFullscreenPanel(null) }}
        />

        {/* 文件清单全屏面板：常驻渲染以支持移动端进出动画（内部按 open/closing 自管理） */}
        <SandboxFileList
          instanceId={instId}
          instanceName={activeInstance?.name}
          variant="fullscreen"
          open={fullscreenPanel === "files"}
          onClose={() => setFullscreenPanel(null)}
        />

        {/* 首页快速入口的实例级管理弹层：Skill / 提示词包（关闭后刷新入口数字） */}
        {manageSkillsOpen && (
          <InstanceSkillsDialog instance={activeInstance} onClose={() => { setManageSkillsOpen(false); loadContentCounts() }} />
        )}
        {managePackagesOpen && (
          <InstancePackagesDialog instance={activeInstance} onClose={() => { setManagePackagesOpen(false); loadContentCounts() }} />
        )}

        {/* File tree overlay (half-screen drawer) — only in backstage mode。进出动画对齐导演抽屉 */}
        {(showFileTree || fileTreeClosing) && (
          <>
            <div
              className={`fixed inset-0 bg-black/40 backdrop-blur-sm z-40 ${
                fileTreeClosing
                  ? "animate-out fade-out duration-200 fill-mode-forwards"
                  : "animate-in fade-in duration-200"
              }`}
              onClick={closeFileTree}
            />
            <div
              className={`fixed left-0 top-0 bottom-0 w-[78%] max-w-sm z-50 bg-background border-r border-border flex flex-col shadow-lg ${
                fileTreeClosing
                  ? "animate-out slide-out-to-left duration-200 fill-mode-forwards"
                  : "animate-in slide-in-from-left duration-200"
              }`}
            >
              <div className="p-3 border-b border-border flex items-center justify-between shrink-0">
                <span className="text-sm font-semibold truncate" title={activeInstance.name}>
                  {activeInstance.name}
                </span>
                <div className="flex items-center gap-1 shrink-0">
                  <button className="p-1.5 rounded hover:bg-muted" onClick={() => exportDialogRef.current?.open("prototype")} title={t("export.titleBar")}>
                    <Archive className="h-4 w-4" />
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
                    onRowClick={(node, opts) => {
                      const isFileOpen = node.type === "file" && !opts.ctrl
                      // 移动端：当前文件带未保存更改时切另一文件 → 先经三选项守卫（保存/丢弃/取消）。
                      if (isFileOpen && node.path !== selectedFileRef.current
                        && selectedFileRef.current && isDirtyRef.current) {
                        setLeavePending({ path: selectedFileRef.current, kind: "switch", target: node.path })
                        closeFileTree()
                        return
                      }
                      handleNodeClick(node, opts)
                      // 点开文件即收抽屉；点文件夹(展开)与长按(菜单)不收
                      if (isFileOpen) closeFileTree()
                    }}
                    onSelect={(path) => {
                      if (path !== selectedFileRef.current
                        && selectedFileRef.current && isDirtyRef.current) {
                        setLeavePending({ path: selectedFileRef.current, kind: "switch", target: path })
                        closeFileTree()
                        return
                      }
                      closeFileTree()
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
              <FileTreeGitBar
                currentBranch={currentBranch}
                latestCommitMsg={latestCommitMsg}
                changeCounts={changeCounts}
                onClick={openGit}
                title={t("chat:openVersionControl")}
              />
            </div>
          </>
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

        {/* 三选项守卫：移动端切文件 / 退出 files 面板带未保存更改时。 */}
        {dirtyLeaveDialog}

        {/* 移动端退出实例确认：空闲时系统返回被 blocker 拦 → 弹窗。确认放行 / 取消停留。 */}
        <ConfirmDialog
          open={showExitConfirm}
          title={t("confirmExit.title")}
          message={t("confirmExit.message")}
          variant="destructive"
          confirmText={t("confirmExit.proceed")}
          confirmOnEnter
          onConfirm={proceedExit}
          onCancel={cancelExit}
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
              ref={(el) => { if (!isMobile) dragContainerEl.current = el; if (!isMobile) treeRootRef.current = el }}
              tabIndex={-1}
              className={`flex-1 overflow-auto py-1 select-none relative focus:outline-none ${
                ((externalDrop !== null) || dragInfo !== null) && (externalDrop ? externalDrop.target : dropTargetPath) === ROOT
                  ? "ring-2 ring-inset ring-accent" : ""
              }`}
              onPointerDown={(e) => { onFileTreePointerDown(e); if (e.button === 0) focusTreeRoot() }}
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

            <FileTreeGitBar
              currentBranch={currentBranch}
              latestCommitMsg={latestCommitMsg}
              changeCounts={changeCounts}
              onClick={openGit}
              title={t("chat:openVersionControl")}
            />
          </aside>

          {/* Middle panel — Editor */}
          <div
            ref={(el) => { editorPanelRef.current = el }}
            className="flex-1 flex flex-col bg-background min-w-0"
            tabIndex={-1}
            onPointerDown={(e) => { if (e.target === e.currentTarget) editorPanelRef.current?.focus() }}
          >
            {selectedFile ? (
              <>
                {/* 标签栏（仅桌面端）：已打开的多个文件，点击切换激活，× 关闭 */}
                <EditorTabs
                  tabs={openTabs}
                  activePath={selectedFile}
                  entries={tabStore}
                  onActivate={(index) => {
                    const p = openTabs[index]
                    if (p) { setSelectedFile(p); setSelection([{ path: p, type: "file", name: p.split("/").pop() || p }]) }
                  }}
                  onClose={(index) => closeTab(openTabs[index])}
                />
                <div className="flex items-center gap-2 px-3 py-2 border-b border-border shrink-0">
                  {isImageOpen && (
                    <span className="text-xs text-muted-foreground">
                      {imageMeta ? `${imageMeta.w} × ${imageMeta.h}` : t("image")}
                    </span>
                  )}
                  {!isImageOpen && (
                    <>
                      <button
                        onClick={() => copyPathEntry(selectedFile)}
                        className="min-w-0 flex-1 flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors text-left cursor-pointer"
                        title={t("clipboard.copyPath") + ": " + toBackendPath(selectedFile)}
                      >
                        <span className="shrink-0 font-medium">{t("currentFile")}</span>
                        <span className="truncate font-mono text-muted-foreground/90">{toBackendPath(selectedFile)}</span>
                      </button>
                      <div className="flex items-center gap-2 shrink-0">
                      {isDirty && !saveToast && <span className="text-xs text-orange-500">{t("unsaved")}</span>}
                      {saveToast && <span ref={saveToastRef} className="text-xs text-green-500">{t("savedToDisk")}</span>}
                      {/* 阅读切换：代码态→给进入阅读的按钮（并置阅读模式开）；阅读态→「查看源码」回代码（并置关） */}
                      {supportsRead && (editorView === "code" ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => persistReadMode(true)}
                          className="gap-1"
                          title={isMarkdown ? t("mdRead") : t("payload")}
                        >
                          {isMarkdown ? <Eye className="h-3 w-3" /> : <BookOpen className="h-3 w-3" />}
                          {isMarkdown ? t("mdRead") : t("payload")}
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => persistReadMode(false)}
                          className="gap-1"
                          title={t("viewSource")}
                        >
                          <Code2 className="h-3 w-3" />
                          {t("viewSource")}
                        </Button>
                      ))}
                      <Button size="sm" variant="outline" onClick={handleSave} disabled={!isDirty || isSaving} className="gap-1">
                        {isSaving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
                        {t("common:save")}
                      </Button>
                    </div>
                    </>
                  )}
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
                      key={`${selectedFile}#${selectedFileVersion}`}
                      path={selectedFile}
                      defaultValue={editedContent}
                      onOpenPath={(p) => openFile(toFrontendPath(p))}
                      original={gitHeadContent ?? ""}
                      onSave={handleSave}
                      onChange={(val) => updateActiveEdited(val)}
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
                    <div
                      ref={editorView === "preview" ? previewScrollElRef : undefined}
                      onScroll={() => {
                        const el = previewScrollElRef.current
                        const p = selectedFileRef.current
                        if (el && p) {
                          readScrollRef.current[p] = { ...(readScrollRef.current[p] ?? { preview: 0, payload: 0 }), preview: el.scrollTop }
                        }
                      }}
                      className={`h-full overflow-auto ${editorView === "preview" ? "" : "hidden"}`}
                    >
                      <MarkdownRenderer
                        content={editedContent}
                        onOpenPath={(p) => openFile(toFrontendPath(p))}
                      />
                    </div>
                  )}
                  {isPayloadFile && (
                    <div
                      ref={editorView === "payload" ? payloadScrollElRef : undefined}
                      onScroll={() => {
                        const el = payloadScrollElRef.current
                        const p = selectedFileRef.current
                        if (el && p) {
                          readScrollRef.current[p] = { ...(readScrollRef.current[p] ?? { preview: 0, payload: 0 }), payload: el.scrollTop }
                        }
                      }}
                      className={`h-full overflow-auto ${editorView === "payload" ? "" : "hidden"}`}
                    >
                      <PayloadViewer messages={payloadMessages!} meta={payloadMeta} />
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

      {/* 三选项守卫：桌面关脏标签 */}
      {dirtyLeaveDialog}

      {/* Drag overlay — prevents iframe from capturing mouse during panel resize */}
      {isDragging && (
        <div
          className="fixed inset-0 z-50 cursor-col-resize"
          style={{ userSelect: "none" } as React.CSSProperties}
        />
      )}

      {/* Git Dialog (desktop host migrated from ChatPanel) */}
      {fullscreenPanel === "git" && (
        <GitDialog
          instanceId={instId!}
          open={true}
          onClose={() => setFullscreenPanel(null)}
          onRefresh={() => { refresh(); setFullscreenPanel(null) }}
        />
      )}
    </div>
  )
}
