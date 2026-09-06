import { useState } from "react"
import { useEffect } from "react"
import { useThemeStore } from "@/stores/themeStore"

// ---- Mermaid 图表渲染（MarkdownRenderer 与聊天气泡共用的纯渲染件）----
// 从代码块提取图表源码，经 mermaid 异步渲染为 SVG 后注入 DOM。
// mermaid 体积大，改为按需动态 import，首次出现图表时才加载，避免拖慢首屏。
// 每个图表用递增 id 保证唯一；主题跟随全局 dark 模式，切换时重渲染。
// 渲染结果用 (isDark, code) 作 key 存储，避免陈旧结果在输入/主题变化时闪现。

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

let mermaidSeq = 0

export function MermaidDiagram({ code }: { code: string }) {
  const isDark = useThemeStore((s) => s.isDark)
  const [rendered, setRendered] = useState<{ key: string; svg: string } | null>(null)
  const [error, setError] = useState<{ key: string; message: string } | null>(null)

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
      <div
        className="my-4 flex justify-center overflow-x-auto"
        dangerouslySetInnerHTML={{ __html: rendered.svg }}
      />
    )
  }

  return <div className="my-4 py-4 text-center text-sm text-muted-foreground">正在渲染图表…</div>
}
