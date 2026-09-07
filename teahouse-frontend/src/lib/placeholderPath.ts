// 占位符扫描与"占位符→目标文件路径"解析的共享实现。
// MarkdownRenderer(阅读着色/跳转) 与 MonacoEditor(teahouse 语法高亮/Ctrl+Click 跳转)
// 共用同一份 scanBrace/解析，避免两侧重复与规则漂移。语义镜像后端 placeholder.py
// 的 `_match_brace_group`(每个单花括号计数)与路径切分规则。

// 数 `{`/`}` 从 start 直到深度回到 0，返回 (闭合后的下标, 剩余深度)。
// 每个单花括号都计数，故内嵌 `{{切片}}` 不会提前截断、`${...}` 内跨行可续扫。
export function scanBrace(text: string, start: number): { end: number; depth: number } {
  let depth = 0
  let end = start
  while (end < text.length) {
    const ch = text[end]
    if (ch === "{") depth++
    else if (ch === "}") {
      depth--
      if (depth === 0) {
        end++
        break
      }
    }
    end++
  }
  return { end, depth }
}

// 从 `from` 起最早出现的 `${` 或 `{{` 下标，或 -1。单 `{` 不开启占位符。
export function findPlaceholderStart(line: string, from: number): number {
  for (let j = from; j < line.length - 1; j++) {
    const a = line[j]
    const b = line[j + 1]
    if ((a === "$" && b === "{") || (a === "{" && b === "{")) return j
  }
  return -1
}

// 从 {{...}} 占位符整段(含两端花括号 original)解析"目标文件路径"。支持 {{path}} 与
// {{path|切片}}：路径取 `|` 前、含 `:`(行段/glob)时裁到根文件段。仅返回像普通相对路径的
// 引用(不含 glob:/@包/空白/通配/无 ./)，否则返回 null(不可跳转)。
export function resolvePlaceholderPath(original: string): string | null {
  // original 形如 `{{...}}`，剥掉两端花括号
  const inner = original.slice(2, -2)
  let p = inner
  const pipe = p.indexOf("|")
  if (pipe >= 0) p = p.slice(0, pipe)
  const colon = p.indexOf(":")
  if (colon >= 0) p = p.slice(0, colon)
  p = p.trim()
  // 空 / glob 模式 / @包引用 / 含空白 等非普通路径一律不可跳
  if (!p || p.includes("*") || p.startsWith("@") || p.includes("?") || /\s/.test(p)) return null
  // 必须像文件的引用：至少含一个扩展名或斜杠，避免把纯文本误当路径
  if (!/[./]/.test(p)) return null
  return p
}

// 单行内、给定光标列(Monaco column 为 1-based)命中的可跳占位符目标。
// 返回 { path, start, end }(start/end 为 0-based、end 不包含)，命中独立 `{{...}}` 文件
// 引用时返回之；否则 null。跳过整段 `${...}`：其内嵌 `{{}}` 不作为候选(与着色语义一致，
// ${} 内嵌 {{}} 是注释/关键字色，不是 string 可跳)；故 `${{a}}` 不会命中内层。
export function findClickTargetAtColumn(
  line: string,
  column1Based: number,
): { path: string; start: number; end: number } | null {
  let i = 0
  const n = line.length
  while (i < n) {
    const start = findPlaceholderStart(line, i)
    if (start < 0) break
    const isVar = line[start] === "$"
    const { end, depth } = scanBrace(line, start)
    if (isVar) {
      // ${...} 段整体跳过：其内部 {{}} 不可跳。
      i = depth === 0 ? end : n
      continue
    }
    // 独立 {{...}}。Monaco column=charIndex+1；可点区间可视作 [start+1, end]
    // (end exclusive → 内部最后有效列是 end)。
    const lo = start + 1
    const hi = end // end exclusive，内部含花括号到 end-1，故最后一内列 = end
    if (column1Based >= lo && column1Based <= hi) {
      const path = resolvePlaceholderPath(line.slice(start, end))
      if (path) return { path, start, end }
    }
    i = depth === 0 ? end : n
  }
  return null
}
