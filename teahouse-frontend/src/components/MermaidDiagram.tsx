import { useState } from "react"
import { useEffect, useRef } from "react"
import { useTranslation } from "react-i18next"
import { useThemeStore } from "@/stores/themeStore"
import { useDialogBackClose } from "@/hooks/useDialogBackClose"

// ---- Mermaid 图表渲染（MarkdownRenderer 与聊天气泡共用的纯渲染件）----
// 从代码块提取图表源码，经 mermaid 异步渲染为 SVG 后注入 DOM。
// mermaid 体积大，改为按需动态 import，首次出现图表时才加载，避免拖慢首屏。
// 每个图表用递增 id 保证唯一；主题跟随全局 dark 模式，切换时重渲染。
// 渲染结果用 (isDark, code) 作 key 存储，避免陈旧结果在输入/主题变化时闪现。
//
// 大图处理：缩略态由全局类 .teahouse-mermaid-thumb 等比缩到容器宽（不溢出），
// 点击弹全屏查看器：滚轮/按钮/双击 + 单指拖动平移 + 双指捏合缩放；单击(未拖动)关闭。

type Mermaid = typeof import("mermaid").default

let mermaidMod: Promise<Mermaid> | null = null
function loadMermaid(): Promise<Mermaid> {
  mermaidMod ??= import("mermaid").then((m) => m.default)
  return mermaidMod
}

let initializedTheme: "default" | "dark" | null = null
function ensureMermaid(m: Mermaid, theme: "default" | "dark") {
  if (initializedTheme === theme) return
  m.initialize({
    startOnLoad: false,
    theme,
    securityLevel: "strict",
    // 渲染失败时不画 mermaid 内建的炸弹 error 图（会往临时 body 节点塞
    // "Syntax error in text" 残留、难看），而是抛错走我们的 .catch 显示干净报错框。
    suppressErrorRendering: true,
  })
  initializedTheme = theme
}

function mermaidKey(isDark: boolean, code: string) {
  return `${isDark ? "dark" : "light"} ${code}`
}

// react-markdown 把语言传进 code 覆盖的 className（字符串 `language-<lang>`），
// pre 覆盖则通过 node.properties.className（数组）。统一判是否 mermaid。
export function isMermaidLanguage(className?: unknown): boolean {
  if (typeof className === "string") return /(?:^|\s)language-mermaid(?:\s|$)/.test(className)
  if (Array.isArray(className)) return className.includes("language-mermaid")
  return false
}

// ---- 流式 mermaid 的「未闭合围栏」兜底 ----
// LLM 是流式输出正文的：围栏一旦以 ```mermaid 开头、收尾的 ``` 还没敲完前，
// react-markdown 会把「其后到文档末尾的一切」吞进同一个 mermaid code 节点。
// 于是每个 chunk 都在对一段「残缺图源码 + 后续杂文本」跑真实渲染 → 报错/抖动/残留报错。
// 处理：把这段「尾部未闭合 mermaid」替换成固定哨兵，真实图表留到围栏闭合（内容完整）再渲。

// 哨兵语言：区别于真实 mermaid，仅表示「图仍在生成、未完整」。
const PENDING_LANG = "teahouse-mermaid-pending"

export function isPendingMermaidLanguage(className?: unknown): boolean {
  const marker = `language-${PENDING_LANG}`
  if (typeof className === "string") return className.split(/\s+/).includes(marker)
  if (Array.isArray(className)) return className.includes(marker)
  return false
}

// 逐行扫围栏；若扫描结束时仍落在某个未闭合的 ```mermaid 围栏内，返回该围栏
// 开头行在 lines 里的下标，否则返回 -1。兼容 ``` 与 ~~~ 两种围栏。
function findUnclosedMermaidFence(text: string): number {
  const lines = text.split("\n")
  let inFence = false
  let fenceChar = ""
  let openIdx = -1
  let lang = ""
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!inFence) {
      const m = /^\s*(```|~~~)\s*(.*)$/.exec(line)
      if (!m) continue
      inFence = true
      fenceChar = m[1]
      openIdx = i
      lang = (m[2] || "").trim().split(/\s+/)[0] || ""
      continue
    }
    // 闭合围栏需同字符、≥3 个、只含空白或类名后缀。
    if (new RegExp(`^\\s*${fenceChar === "```" ? "`{3,}" : "~{3,}"}\\s*`).test(line)) {
      inFence = false
      fenceChar = ""
      openIdx = -1
      lang = ""
    }
  }
  return inFence && lang === "mermaid" ? openIdx : -1
}

// 主入口：文本尾部落在未闭合 ```mermaid 内 → 返回把该尾段替换成哨兵后的文本，
// 否则返回 null（无需 mask）。
export function maskUnclosedMermaidTail(text: string): string | null {
  const openIdx = findUnclosedMermaidFence(text)
  if (openIdx < 0) return null
  const lines = text.split("\n")
  const prefix = lines.slice(0, openIdx).join("\n").replace(/\s+$/, "")
  // 哨兵内容固定写死（闭合对、空体），不随流式 chunk 变化 → 占位标记稳定不抖。
  const marker = `${prefix ? prefix + "\n\n" : ""}\`\`\`${PENDING_LANG}\n\`\`\`\n`
  return marker
}

// 占位标记：未完整图表期间的稳定静态提示，不做 mermaid 渲染。
export function MermaidPending() {
  const { t } = useTranslation("misc")
  return (
    <div className="my-2 rounded-md bg-muted/60 px-3 py-2 text-sm text-muted-foreground">
      {t("assistant.mermaidPending")}
    </div>
  )
}

let mermaidSeq = 0

type View = { scale: number; x: number; y: number }
const clampScale = (s: number) => Math.min(20, Math.max(0.05, s))
const MIN_MOVE = 4 // 小于此位移视为点击（不触发拖动）

// 全屏查看器。
// 模型：svg 固定在 stage 中心，scale 始终以 stage 中心为锚，x/y 为缩放后附加的屏幕平移。
// 即某内容点相对中心的屏幕偏移 A 恒满足 A = x + c*scale（c=该点在 svg 局部坐标的偏移）。
// 要以任意屏幕锚点 F 缩放（光标/双指中点/双击处），锚点需保持不变 → 解出 x'：
//   x' = A_F + (x - A_F) * (scale'/scale)，A_F = F 相对 stage 中心的偏移。
// 真值源收敛在 viewRef，事件回调读它算新值一次性 flush，避免并发手势互相覆盖。
function MermaidFullscreen({ svg, onClose }: { svg: string; onClose: () => void }) {
  const [view, setView] = useState<View>({ scale: 1, x: 0, y: 0 })
  const viewRef = useRef(view)
  const stageRef = useRef<HTMLDivElement>(null)
  const pointersRef = useRef<Map<number, { x: number; y: number }>>(new Map())
  const pinchRef = useRef<{ dist: number; scale: number; c0x: number; c0y: number } | null>(null)
  const dragRef = useRef<{ lastX: number; lastY: number; moved: boolean } | null>(null)
  // 一次手势中是否发生过实际移动/缩放；pointerup 后 stage 的 onClick 据此区分“拖动”与“单击”。
  const interactedRef = useRef(false)
  // 单击关 / 双击缩放 冲突处理：单击延迟关闭，双击第一击触发 click 后再来 dblclick 则取消。
  const clickTimerRef = useRef<number | null>(null)
  const clearCloseTimer = () => {
    if (clickTimerRef.current !== null) {
      window.clearTimeout(clickTimerRef.current)
      clickTimerRef.current = null
    }
  }

  const apply = (next: View) => {
    viewRef.current = next
    setView(next)
  }

  const fit = () => {
    const stage = stageRef.current
    if (!stage) return
    const raw = stage.querySelector("svg")
    const vw = raw?.viewBox?.baseVal?.width
    const vh = raw?.viewBox?.baseVal?.height
    const iw = vw && vw > 0 ? vw : (raw?.getBoundingClientRect().width ?? 1)
    const ih = vh && vh > 0 ? vh : (raw?.getBoundingClientRect().height ?? 1)
    const availW = Math.max(100, stage.clientWidth * 0.92)
    const availH = Math.max(100, stage.clientHeight * 0.92)
    apply({ scale: Math.min(availW / iw, availH / ih), x: 0, y: 0 })
  }

  // 以屏幕坐标 (sx, sy) 为不动锚点缩放 factor。
  const anchorZoom = (sx: number, sy: number, factor: number) => {
    const stage = stageRef.current
    if (!stage) return
    const rect = stage.getBoundingClientRect()
    const ax = sx - rect.left - rect.width / 2
    const ay = sy - rect.top - rect.height / 2
    const v = viewRef.current
    const s2 = clampScale(v.scale * factor)
    const k = s2 / v.scale
    apply({ scale: s2, x: ax + (v.x - ax) * k, y: ay + (v.y - ay) * k })
  }
  // 以舞台中心为锚缩放（加减号/双击用）。
  const stageCenterZoom = (factor: number) => {
    const stage = stageRef.current
    if (!stage) return
    const rect = stage.getBoundingClientRect()
    anchorZoom(rect.left + rect.width / 2, rect.top + rect.height / 2, factor)
  }

  useEffect(() => {
    fit()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 系统返回键（桌面浏览器返回 / 移动端返回手势）关闭全屏查看器。
  // MermaidFullscreen 只在 open 时挂载，此 hook 以其常开 true 等效“open”。
  useDialogBackClose(true, onClose)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKey)
    return () => {
      window.removeEventListener("keydown", onKey)
      clearCloseTimer()
    }
  }, [onClose])

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    const stage = stageRef.current
    if (!stage) return
    stage.setPointerCapture?.(e.pointerId)
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    interactedRef.current = false // 新手势重置

    if (pointersRef.current.size === 2) {
      // 第二指落下 → 进入捏合：锚定当前双指中点对应的内容点 c0，后续让该点跟着指中走。
      const [a, b] = [...pointersRef.current.values()]
      const rect = stage.getBoundingClientRect()
      const mx = (a.x + b.x) / 2
      const my = (a.y + b.y) / 2
      const ax = mx - rect.left - rect.width / 2
      const ay = my - rect.top - rect.height / 2
      const v = viewRef.current
      pinchRef.current = {
        dist: Math.hypot(a.x - b.x, a.y - b.y),
        scale: v.scale,
        c0x: (ax - v.x) / v.scale,
        c0y: (ay - v.y) / v.scale,
      }
      dragRef.current = null
    } else {
      dragRef.current = { lastX: e.clientX, lastY: e.clientY, moved: false }
    }
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const cur = pointersRef.current.get(e.pointerId)
    if (!cur) return
    const dx = e.clientX - cur.x
    const dy = e.clientY - cur.y
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY })

    // 捏合（两指在屏）：缩放 + 让捏合起始锚定的内容点跟随当前指中平移。
    if (pinchRef.current) {
      const stage = stageRef.current
      if (!stage) return
      const [a, b] = [...pointersRef.current.values()]
      const dist = Math.hypot(a.x - b.x, a.y - b.y)
      const rect = stage.getBoundingClientRect()
      const mx = (a.x + b.x) / 2
      const my = (a.y + b.y) / 2
      const ax = mx - rect.left - rect.width / 2
      const ay = my - rect.top - rect.height / 2
      const p = pinchRef.current
      const s = clampScale(p.scale * (dist / p.dist))
      apply({ scale: s, x: ax - p.c0x * s, y: ay - p.c0y * s })
      interactedRef.current = true
      dragRef.current = null
      return
    }

    // 单指拖动平移。
    const dr = dragRef.current
    if (!dr) return
    const moved = dr.moved || Math.hypot(dx, dy) >= MIN_MOVE
    if (moved) {
      const v = viewRef.current
      apply({ ...v, x: v.x + dx, y: v.y + dy })
      interactedRef.current = true
    }
    dragRef.current = { lastX: e.clientX, lastY: e.clientY, moved }
  }

  const onPointerUp = (e: React.PointerEvent) => {
    pointersRef.current.delete(e.pointerId)
    if (pointersRef.current.size < 2) pinchRef.current = null
    dragRef.current = null
    // 抬指后若仍剩一指，接续成单指拖动（方便两指松开一指后继续平移）。
    if (pointersRef.current.size === 1) {
      const last = [...pointersRef.current.values()][0]
      dragRef.current = { lastX: last.x, lastY: last.y, moved: false }
    }
  }

  const handleStageClick = () => {
    // 仅在无移动/缩放（=干净单击）时延迟关闭；拖拽/捏合后不触发。
    if (interactedRef.current) return
    clearCloseTimer()
    clickTimerRef.current = window.setTimeout(() => {
      clickTimerRef.current = null
      onClose()
    }, 260)
  }

  const onStageWheel = (e: React.WheelEvent) => {
    e.preventDefault()
    anchorZoom(e.clientX, e.clientY, e.deltaY < 0 ? 1.15 : 1 / 1.15)
  }
  const onStageDoubleClick = (e: React.MouseEvent) => {
    // 双击=缩放而非关闭：取消单击关闭的延迟定时器。
    clearCloseTimer()
    e.preventDefault()
    const stage = stageRef.current
    if (!stage) return
    const rect = stage.getBoundingClientRect()
    anchorZoom(rect.left + rect.width / 2, rect.top + rect.height / 2, viewRef.current.scale <= 1.01 ? 2.5 : 1 / 2.5)
  }

  return (
    <div
      className="fixed inset-0 z-[999] flex flex-col"
      onClick={handleStageClick}
      onContextMenu={(e) => e.preventDefault()}
    >
      {/* 背景：模糊 + 压暗，让 SVG 在纯色上更清晰。为避免全屏 svg 自身也被模糊，
          这里底色由外层 div 承担（backdrop-filter 模糊它后面内容），svg 独立在其上。 */}
      <div className="pointer-events-none absolute inset-0 bg-black/80 backdrop-blur-sm" />

      {/* 顶栏 */}
      <div className="relative z-10 flex items-center gap-1 px-3 py-2 text-white" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-1 rounded-full bg-black/50 px-2 py-1 backdrop-blur-sm">
          <button className="flex h-8 w-8 items-center justify-center rounded-full hover:bg-white/15" onClick={() => stageCenterZoom(1 / 1.25)} aria-label="缩小">−</button>
          <div className="w-12 text-center text-sm tabular-nums">{Math.round(view.scale * 100)}%</div>
          <button className="flex h-8 w-8 items-center justify-center rounded-full hover:bg-white/15" onClick={() => stageCenterZoom(1.25)} aria-label="放大">+</button>
          <button className="ml-1 rounded-full px-3 py-1 text-xs text-white/85 hover:bg-white/15" onClick={fit}>适应</button>
        </div>
        <div className="flex-1" />
        <span className="mr-2 hidden text-xs text-white/60 sm:inline">滚轮缩放 · 拖动平移 · 双指缩放 · 点击空白关闭</span>
        <button className="flex h-8 w-8 items-center justify-center rounded-full bg-black/50 backdrop-blur-sm hover:bg-white/15" onClick={onClose} aria-label="关闭">✕</button>
      </div>

      {/* 舞台 */}
      <div
        ref={stageRef}
        className="relative flex-1 touch-none overflow-hidden"
        onWheel={onStageWheel}
        onDoubleClick={onStageDoubleClick}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onClick={handleStageClick}
      >
        <div
          className="absolute inset-0"
          style={{
            transform: `translate(calc(-50% + ${view.x}px), calc(-50% + ${view.y}px)) scale(${view.scale})`,
            transformOrigin: "center center",
            pointerEvents: "none",
          }}
        >
          {/* 居中锚点：用 50%/50% + translate(-50%,-50%) 让内容中心停在 stage 中心 + pan */}
          <div className="absolute left-1/2 top-1/2" dangerouslySetInnerHTML={{ __html: svg }} />
        </div>
      </div>
    </div>
  )
}

export function MermaidDiagram({ code }: { code: string }) {
  const isDark = useThemeStore((s) => s.isDark)
  const [rendered, setRendered] = useState<{ key: string; svg: string } | null>(null)
  const [error, setError] = useState<{ key: string; message: string } | null>(null)
  const [open, setOpen] = useState(false)

  const currentKey = mermaidKey(isDark, code)

  useEffect(() => {
    let cancelled = false
    const theme = isDark ? "dark" : "default"
    const key = mermaidKey(isDark, code)
    const id = `teahouse-mermaid-${++mermaidSeq}`
    loadMermaid()
      .then((m) => {
        if (cancelled) return
        ensureMermaid(m, theme)
        return m.render(id, code)
      })
      .then((result) => {
        if (cancelled || !result) return
        setRendered({ key, svg: result.svg })
      })
      .catch((e: unknown) => {
        if (!cancelled) setError({ key, message: e instanceof Error ? e.message : String(e) })
      })
    return () => {
      cancelled = true
    }
  }, [code, isDark])

  if (error && error.key === currentKey) {
    return (
      <div className="my-4 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
        <div className="mb-1 font-medium text-destructive">Mermaid 图表渲染失败</div>
        <pre className="overflow-auto whitespace-pre-wrap text-xs text-destructive/80">{error.message}</pre>
        <pre className="mt-2 overflow-auto whitespace-pre-wrap text-xs text-muted-foreground">{code}</pre>
      </div>
    )
  }

  if (rendered && rendered.key === currentKey) {
    return (
      <>
        {/* 缩略：svg 由 .teahouse-mermaid-thumb 等比缩到容器宽，点击弹全屏查看器 */}
        <button
          type="button"
          className="my-4 block w-full cursor-zoom-in rounded-lg p-2 text-center transition-colors hover:bg-muted/40"
          onClick={() => setOpen(true)}
          title="点此放大查看"
        >
          <span className="teahouse-mermaid-thumb block w-full" dangerouslySetInnerHTML={{ __html: rendered.svg }} />
          <span className="mt-1 inline-block text-xs text-muted-foreground/60">🔍 点击放大</span>
        </button>
        {open && <MermaidFullscreen svg={rendered.svg} onClose={() => setOpen(false)} />}
      </>
    )
  }

  return <div className="my-4 py-4 text-center text-sm text-muted-foreground">正在渲染图表…</div>
}
