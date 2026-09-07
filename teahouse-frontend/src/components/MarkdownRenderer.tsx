import { Fragment, type ReactNode } from "react"
import { useMemo, useRef, useEffect } from "react"
import ReactMarkdown, { type Components } from "react-markdown"
import remarkGfm from "remark-gfm"
import { isMermaidLanguage, MermaidDiagram, isPendingMermaidLanguage, MermaidPending, maskUnclosedMermaidTail } from "./MermaidDiagram"
import { scanBrace, resolvePlaceholderPath } from "@/lib/placeholderPath"
import i18n from "@/i18n/config"

// ---- 占位符着色 ----
// 预览模式下给 teahouse 占位符语法加颜色，与 Monaco 编辑器 token 颜色对齐：
//   ${@note ...}        → 暗绿（注释，剥空）
//   ${@var/type ...}    → 蓝（取变量值/类型）
//   ${@python/condition/...} / ${... return ...} / ${条件: ...} → 粉（可执行）
//   ${name}             → 蓝（裸变量）
//   {{path}}            → 橙（文件切片）
// markdown 会把占位符里的换行/空白按 markdown 规则折叠、并按硬换行/缩进把多行
// 占位符拆成多个文本节点，破坏「括号深度配平」的边界。因此在喂给 react-markdown
// 之前，先扫描原始文本、按配平抽出占位符替换为单行令牌（markdown 不碰），渲染后
// 再把令牌换回原文本着色——多行 `${@note ...}` / 多行代码块也能正确整体着色。
// fenced 代码块内不替换（代码块保留原文，交给 highlightText 直接配平扫描）。
const PH_CLASS: Record<string, string> = {
  comment: "text-green-600 dark:text-green-400",
  keyword: "text-fuchsia-600 dark:text-fuchsia-400",
  variable: "text-sky-600 dark:text-sky-400",
  string: "text-orange-600 dark:text-orange-400",
}

// inner = `${` 与匹配 `}` 之间的文本；closed = 本段内已闭合。
function phKind(inner: string, closed: boolean): keyof typeof PH_CLASS {
  const s = inner.trim()
  if (s === "@note" || s.startsWith("@note ")) return "comment"
  if (closed) {
    if (s === "@var" || s.startsWith("@var ") || s === "@type" || s.startsWith("@type ")) return "variable"
    if (s !== "" && !s.startsWith("@") && !s.includes("return") && !s.includes(":") && !/\s/.test(s)) return "variable"
  }
  return "keyword"
}

type Placeholder = { original: string; kind: keyof typeof PH_CLASS }

// 令牌用私用区字符包裹，markdown 不会折叠、正文几乎不可能撞车。
const TOKEN_PREFIX = ""
const TOKEN_SUFFIX = ""

// 把一段 prose 里的占位符替换为令牌，原文本记入 placeholders。
function protectText(text: string, placeholders: Map<string, Placeholder>, seq: { n: number }): string {
  let out = ""
  let last = 0
  let i = 0
  const n = text.length
  while (i < n) {
    const c = text[i]
    let end = -1
    let kind: keyof typeof PH_CLASS | null = null
    if (c === "$" && text[i + 1] === "{") {
      const r = scanBrace(text, i)
      if (r.depth === 0) {
        end = r.end
        kind = phKind(text.slice(i + 2, end - 1), true)
      }
    } else if (c === "{" && text[i + 1] === "{") {
      const r = scanBrace(text, i)
      if (r.depth === 0) {
        end = r.end
        kind = "string"
      }
    }
    if (end >= 0 && kind) {
      const token = TOKEN_PREFIX + (seq.n++) + TOKEN_SUFFIX
      placeholders.set(token, { original: text.slice(i, end), kind })
      out += text.slice(last, i) + token
      last = end
      i = end
      continue
    }
    i++
  }
  out += text.slice(last)
  return out
}

// 扫描全文，仅替换 fenced 代码块**之外**的占位符。
function protectPlaceholders(content: string): { text: string; placeholders: Map<string, Placeholder> } {
  const placeholders = new Map<string, Placeholder>()
  const seq = { n: 0 }
  const lines = content.split("\n")
  const out: string[] = []
  let inFence = false
  let prose: string[] = []
  const flush = () => {
    if (prose.length) {
      out.push(protectText(prose.join("\n"), placeholders, seq))
      prose = []
    }
  }
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      flush()
      out.push(line)
      inFence = !inFence
    } else if (inFence) {
      out.push(line)
    } else {
      prose.push(line)
    }
  }
  flush()
  return { text: out.join("\n"), placeholders }
}

// 把一段纯文本拆成普通段 + 高亮段：先还原令牌为着色 span，再对残留的裸占位符
// （来自 fenced 代码块）做括号配平扫描着色。
function highlightText(text: string, placeholders: Map<string, Placeholder>): ReactNode[] {
  if (!text) return [text]
  const out: ReactNode[] = []
  let last = 0
  let i = 0
  const n = text.length
  while (i < n) {
    if (text[i] === TOKEN_PREFIX) {
      let j = i + 1
      while (j < n && text[j] !== TOKEN_SUFFIX) j++
      if (j < n) {
        const token = text.slice(i, j + 1)
        const ph = placeholders.get(token)
        if (ph) {
          if (i > last) out.push(text.slice(last, i))
          // 正文里的 {{path}} 文件引用占位符：附 data-src-path 供外层点击跳转(仅正文，
          // fenced 代码块不经过本 map 分支故不可点)。
          const target = ph.kind === "string" ? resolvePlaceholderPath(ph.original) : null
          out.push(
            <span
              key={i}
              className={`${PH_CLASS[ph.kind]} whitespace-pre-wrap`}
              {...(target ? { "data-src-path": target, title: `${i18n.t("misc:monaco.ctrlClickOpen")}${target}` } : {})}
            >
              {ph.original}
            </span>,
          )
          last = j + 1
          i = j + 1
          continue
        }
      }
      i++
      continue
    }
    if (text[i] === "$" && text[i + 1] === "{") {
      const { end, depth } = scanBrace(text, i)
      if (depth === 0) {
        const inner = text.slice(i + 2, end - 1)
        if (i > last) out.push(text.slice(last, i))
        out.push(
          <span key={i} className={PH_CLASS[phKind(inner, true)]}>
            {text.slice(i, end)}
          </span>,
        )
        last = end
        i = end
      } else {
        i += 2
      }
      continue
    }
    if (text[i] === "{" && text[i + 1] === "{") {
      const { end, depth } = scanBrace(text, i)
      if (depth === 0) {
        if (i > last) out.push(text.slice(last, i))
        out.push(
          <span key={i} className={PH_CLASS.string}>
            {text.slice(i, end)}
          </span>,
        )
        last = end
        i = end
      } else {
        i += 2
      }
      continue
    }
    i++
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

// hast-util-to-jsx-runtime 的 components 只对「元素」生效（text 节点写死原样输出），
// 所以这里覆盖文本容器，把 children 里的字符串子节点做占位符着色，其余节点原样透传。
function highlightChildren(children: ReactNode, placeholders: Map<string, Placeholder>): ReactNode {
  if (typeof children === "string") return highlightText(children, placeholders)
  if (Array.isArray(children)) {
    return children.map((c, i) => (typeof c === "string" ? <Fragment key={i}>{highlightText(c, placeholders)}</Fragment> : c))
  }
  return children
}

// ---- Markdown 渲染器 ----
// 工作区「预览」模式用的渲染器：GFM 语法 + ```mermaid 代码块转结构图。
// 不启用 rehype-raw，原始 HTML 按文本转义，天然规避 XSS。
// mermaid 渲染逻辑见 ./MermaidDiagram（聊天气泡共用）。

export function MarkdownRenderer({ content, onOpenPath }: {
  content: string
  /** 点击正文里的 {{path}} 占位符(文件引用)时回调，携带解析出的目标路径(未加 root/ 前缀)。 */
  onOpenPath?: (path: string) => void
}) {
  const { text, placeholders } = useMemo(() => protectPlaceholders(content), [content])

  // ---- Ctrl+Hover 手型提示（仅按住 Ctrl/Cmd 且悬停在可跳 {{path}} 上才变 pointer）----
  // 纯 CSS 感知不到修饰键，故跟踪全局 ctrl 态 + 当前悬停的可跳元素，用 classList 动态加/去
  // ph-open-pointer。DOM 直操作避免因逐帧悬停触发 React 重渲染。
  const ctrlHeldRef = useRef(false)
  const hoverElRef = useRef<HTMLElement | null>(null)
  const applyPointer = () => {
    const el = hoverElRef.current
    if (!el) return
    el.classList.toggle("ph-open-pointer", ctrlHeldRef.current)
  }
  useEffect(() => {
    const sync = () => { ctrlHeldRef.current = false; applyPointer() }
    const onKeyDown = (e: KeyboardEvent) => {
      const held = e.ctrlKey || e.metaKey
      if (held && !ctrlHeldRef.current) { ctrlHeldRef.current = true; applyPointer() }
      // keyup 单独在下方处理；此处只需上沿
    }
    const onKeyUp = (e: KeyboardEvent) => {
      if (!e.ctrlKey && !e.metaKey && ctrlHeldRef.current) { ctrlHeldRef.current = false; applyPointer() }
    }
    // 窗口失焦兜底清掉按住态，避免卡在手型
    window.addEventListener("blur", sync)
    document.addEventListener("keydown", onKeyDown)
    document.addEventListener("keyup", onKeyUp)
    return () => {
      window.removeEventListener("blur", sync)
      document.removeEventListener("keydown", onKeyDown)
      document.removeEventListener("keyup", onKeyUp)
    }
  }, [])

  // 覆盖承载文本的元素，把字符串 children 里的占位符着色；其余（嵌套节点）透传。
  const wrap = (Tag: "p" | "li" | "td" | "th" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "strong" | "em" | "blockquote" | "a") =>
    function TextWrap({ children }: { children?: ReactNode }) {
      return <Tag>{highlightChildren(children, placeholders)}</Tag>
    } satisfies Components[typeof Tag]

  const components: Components = {
    p: wrap("p"),
    li: wrap("li"),
    td: wrap("td"),
    th: wrap("th"),
    h1: wrap("h1"),
    h2: wrap("h2"),
    h3: wrap("h3"),
    h4: wrap("h4"),
    h5: wrap("h5"),
    h6: wrap("h6"),
    strong: wrap("strong"),
    em: wrap("em"),
    blockquote: wrap("blockquote"),
    a: wrap("a"),
    code({ className, children }) {
      if (isMermaidLanguage(className)) {
        return <MermaidDiagram code={String(children).replace(/\n$/, "")} />
      }
      if (isPendingMermaidLanguage(className)) {
        return <MermaidPending />
      }
      // fenced / 行内代码文本里的占位符也着色
      return <code className={className}>{highlightChildren(children, placeholders)}</code>
    },
    pre({ node, children }) {
      // fenced 代码块会被 react-markdown 包进 <pre>；mermaid 图表不应套代码框，
      // 这里识别 pre 下的 code 是否为 mermaid，是则直接透出子元素（图表）。
      const codeNode = node?.children?.[0]
      const className = (
        codeNode as { properties?: { className?: unknown } } | undefined
      )?.properties?.className
      if (isMermaidLanguage(className)) return <>{children}</>
      if (isPendingMermaidLanguage(className)) return <>{children}</>
      return <pre>{children}</pre>
    },
  }

  return (
    <div
      className="prose dark:prose-invert max-w-none px-6 py-4"
      onClickCapture={(e) => {
        if (!onOpenPath) return
        // 与 Monaco 统一：Ctrl/Cmd+Click 才跳转，普通单击保留文本选中，不劫持。
        if (!e.ctrlKey && !e.metaKey) return
        const el = (e.target as HTMLElement).closest?.("[data-src-path]") as HTMLElement | null
        if (el?.dataset.srcPath) onOpenPath(el.dataset.srcPath)
      }}
      onMouseOver={(e) => {
        const el = (e.target as HTMLElement).closest?.("[data-src-path]") as HTMLElement | null
        hoverElRef.current = el
        applyPointer()
      }}
      onMouseOut={(e) => {
        // 指针离开可跳元素时清掉悬停态(用 relatedTarget 判断是否仍在同元素上)
        const next = (e as React.MouseEvent).relatedTarget as HTMLElement | null
        const stillOn = next && next.closest?.("[data-src-path]")
        if (!stillOn) {
          hoverElRef.current?.classList.remove("ph-open-pointer")
          hoverElRef.current = null
        }
      }}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {maskUnclosedMermaidTail(text) ?? text}
      </ReactMarkdown>
    </div>
  )
}
