import type { RichMessage } from "./types"

// ---- Message helpers ----

let msgIdCounter = 0
export function nextId() {
  return `msg-${++msgIdCounter}`
}

/**
 * 按 (order, subRank) 升序比较两条气泡，用于稳定排序 / 有序插入。
 * 后端 JSONL 是唯一事实来源：order 即 record 序，subRank 即记录内的子泡序。
 */
export function compareBubbles(a: { order: number; subRank: number }, b: { order: number; subRank: number }): number {
  if (a.order !== b.order) return a.order - b.order
  return a.subRank - b.subRank
}

/** 在列表中定位拥有指定 (order, sub) 的气泡，找不到返回 -1。 */
export function findBubbleIndex(
  msgs: RichMessage[],
  order: number,
  sub: number | string | null,
): number {
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i]
    if (m.order === order && m.sub === sub) return i
  }
  return -1
}

/** 在保持 (order, subRank) 顺序的前提下，把一个气泡插入列表正确位置。 */
export function insertBubbleSorted(msgs: RichMessage[], msg: RichMessage): RichMessage[] {
  const idx = msgs.findIndex(m => compareBubbles(m, msg) > 0)
  if (idx === -1) return [...msgs, msg]
  if (msgs[idx].order === msg.order && msgs[idx].sub === msg.sub) return msgs
  const next = msgs.slice()
  next.splice(idx, 0, msg)
  return next
}

/**
 * 识别固定格式的 `[auto]` 系统消息并归类，以便前端用特殊标记渲染而非普通气泡。
 * - "interrupt"   : 用户打断（"[auto] user interrupted"）
 * - "endsession"  : 子会话经 EndSession 被后端强制中断（"[auto] interrupted by EndSession tool"）
 * - "session_done": 委派的子会话已结束（…"子会话 session-<uuid> 已完成"…），并附带提取出的 uuid
 * 其它消息返回 null（普通 user 气泡）。
 */
export function autoMsgKind(content: string): { kind: "interrupt" } | { kind: "endsession" } | { kind: "session_done"; sid: string } | { kind: "compact" } | { kind: "auto_continue" } | { kind: "long_msg" } | { kind: "paste_notice" } | null {
  // A [compact] prefix (whether the manual command or the summary marker written
  // after a finished compact) renders as a system bubble, not a normal user bubble.
  if (content.trim().startsWith("[compact]")) return { kind: "compact" }
  if (!content.startsWith("[auto] ")) return null
  const trimmed = content.slice("[auto] ".length)
  // Oversized user message spilled to a temp/ file — render as a user-aligned
  // bubble carrying the pointer, flagged with a "长消息" corner badge.
  if (trimmed.startsWith("用户发送消息过长")) return { kind: "long_msg" }
  // Paste-block notice (the second record of a paste enqueue) — centred system
  // badge; the manual text stays as its own preceding user bubble.
  if (trimmed.startsWith("用户在本次输入时粘贴了长文本")) return { kind: "paste_notice" }
  if (trimmed.trim() === "user interrupted") return { kind: "interrupt" }
  if (trimmed.trim() === "interrupted by EndSession tool") return { kind: "endsession" }
  if (trimmed.startsWith("会话已压缩")) return { kind: "auto_continue" }
  const sidMatch = trimmed.match(/session-([0-9a-fA-F]{4,})/)
  if (sidMatch && /子会话/.test(trimmed)) return { kind: "session_done", sid: sidMatch[0] }
  return null
}

export interface PasteNoticeInfo {
  /** 落盘文件路径（过长时整批暂存）；非 null 时正文要去读这个文件 */
  spilled: string | null
  /** 内联在消息里的粘贴块正文，已剥掉 【粘贴N】 标签 */
  blocks: { n: number; text: string }[]
}

/**
 * 解析 paste_notice 记录的两种形态，供徽章文案与「点击查看」面板共用：
 * - 过长暂存：正文不在记录里，只有一句指向 temp/pasted/<hex8>.md 的提示；
 * - 内联：整批粘贴正文就在记录里，各块带 【粘贴N】 标签。
 * 早期记录还没有 【粘贴N】 标签，此时整段作为单块返回，仍可查看。
 * 文案由调用方按 i18n 拼（这里只返结构化结果）。
 */
export function parsePasteNotice(content: string): PasteNoticeInfo {
  // 新格式落在 temp/pasted/<hex8>.md；旧记录里仍是 temp/pasted-<hex8>.md，两种都认。
  const spilledMatch = content.match(/(temp\/pasted\/[0-9a-f]{8}\.md|temp\/pasted-[0-9a-f]{8}\.md)/)
  if (spilledMatch) {
    return { spilled: spilledMatch[1], blocks: [] }
  }
  // 剥掉 "[auto] 用户在本次输入时粘贴了长文本，内容是：" 那行，剩下按 【粘贴N】 切块。
  const body = content.replace(/^\[auto\][^\n]*\n?/, "").trim()
  const marks: { n: number; idx: number; len: number }[] = []
  const re = /【粘贴(\d+)】\n?/g
  let m: RegExpExecArray | null
  while ((m = re.exec(body)) !== null) {
    marks.push({ n: Number(m[1]), idx: m.index, len: m[0].length })
  }
  const blocks: { n: number; text: string }[] = []
  for (let i = 0; i < marks.length; i++) {
    const start = marks[i].idx + marks[i].len
    const end = i + 1 < marks.length ? marks[i + 1].idx : body.length
    blocks.push({ n: marks[i].n, text: body.slice(start, end).trim() })
  }
  if (blocks.length === 0) {
    if (!body) return { spilled: null, blocks: [] }
    return { spilled: null, blocks: [{ n: 1, text: body }] }
  }
  return { spilled: null, blocks }
}

/** 把 autoMsgKind 的结果映射为 RichMessage 上的 autoKind / autoSid 字段。 */export function autoKindFields(auto: NonNullable<ReturnType<typeof autoMsgKind>>) {
  if (auto.kind === "session_done") {
    return { autoKind: "session_done" as const, autoSid: auto.sid }
  }
  if (auto.kind === "endsession") {
    return { autoKind: "endsession" as const }
  }
  if (auto.kind === "compact") {
    return { autoKind: "compact" as const }
  }
  if (auto.kind === "auto_continue") {
    return { autoKind: "auto_continue" as const }
  }
  if (auto.kind === "long_msg") {
    return { autoKind: "long_msg" as const }
  }
  if (auto.kind === "paste_notice") {
    return { autoKind: "paste_notice" as const }
  }
  return { autoKind: "interrupt" as const }
}

/**
 * 从长消息指针消息内容里提取落盘的 temp 文件名（如 ``temp/长消息-xxxx.md``）。
 * 返回 null 表示没匹配到标准格式。
 */
export function longMsgPath(content: string): string | null {
  const m = content.match(/temp\/长消息-[0-9a-f]{8}\.md/)
  return m ? m[0] : null
}

/**
 * 合并连续相同 role 的消息为单条（用换行分隔）。
 * Anthropic API 会在服务端自动合并；OpenAI 原生不强制交替；
 * 但严格第三方提供商（Kimi、Qwen 等）要求严格交替，合并后满足所有 API。
 */
export function mergeConsecutiveSameRole(msgs: RichMessage[]): RichMessage[] {
  const result: RichMessage[] = []
  for (const m of msgs) {
    const last = result[result.length - 1]
    const lastHasBlocks = last?.blocks && last.blocks.length > 0
    const curHasBlocks = m.blocks && m.blocks.length > 0
    if (last && last.role === m.role && !lastHasBlocks && !curHasBlocks) {
      last.content = last.content ? last.content + "\n" + m.content : m.content
    } else {
      result.push({ ...m })
    }
  }
  return result
}

/**
 * 更新单条消息：只替换目标索引那条（保持其它引用不变），
 * 配合 AssistantBubble 的 memo 让无关消息跳过重渲染。
 */
export function updateMessage(
  prev: RichMessage[],
  id: string,
  updater: (m: RichMessage) => RichMessage
): RichMessage[] | null {
  const idx = prev.findIndex((m) => m.id === id)
  if (idx === -1) return null
  const target = prev[idx]
  const nextMsg = updater(target)
  if (nextMsg === target) return null
  const next = prev.slice()
  next[idx] = nextMsg
  return next
}

// ---- Formatting helpers ----

export function formatCommitPreview(args: Record<string, unknown>): string {
  const type = args.type as string
  const msg = args.message as string
  if (type === "floor") return `[楼层] 第 ${args.number} 层：${msg}`
  if (type === "summary") {
    if (args.start === args.end) return `[总结] 第 ${args.start} 层：${msg}`
    return `[总结] 第 ${args.start}~${args.end} 层：${msg}`
  }
  return `[其他] ${msg}`
}

/** Format tool call args for compact display */
export function formatBlockArgs(block: { args?: Record<string, unknown>; name?: string }): string {
  const args = block.args || {}
  const name = block.name || ""
  if (name === "Read") return args.path as string
  if (name === "Write") return args.path as string
  if (name === "Edit") {
    const slice = args.slice as string | undefined
    if (slice) return slice
    const p = args.path as string
    const range =
      args.offset != null || args.limit != null
        ? `:${args.offset ?? 1}${args.limit != null ? `+${args.limit}` : ""}`
        : ""
    return `${p}${range}`
  }
  if (name === "WriteLine") return args.path as string
  if (name === "Glob") return args.pattern as string
  if (name === "TodoWrite") {
    const todos = (args.todos as Array<{ status: string; activeForm?: string }>) || []
    if (todos.length === 0) return "（空清单）"
    const done = todos.filter((t) => t.status === "completed").length
    const active = todos.find((t) => t.status === "in_progress")
    const parts = [`${todos.length} 项`]
    if (done > 0) parts.push(`${done} 项已完成`)
    if (active) parts.push(`进行中: ${active.activeForm}`)
    return parts.join("，")
  }
  return JSON.stringify(args)
}
