// Payload JSON 阅读：把 Generate dry-run 落盘的 payload（顶层含 messages: [{role, content}…]）
// 探测并解析成可读结构，供「Payload 阅读」视图展示。识别不了返回 null。

export interface PayloadMessage {
  role: string
  content: string
  [k: string]: unknown
}

export interface PayloadParse {
  messages: PayloadMessage[]
  meta: Array<[string, string]>
}

const META_KEYS = new Set([
  "model", "api_style", "url", "api_key", "max_tokens", "temperature",
  "top_p", "frequency_penalty", "presence_penalty", "reasoning_effort",
])

function asObject(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

function msgContent(v: unknown): string | null {
  if (v == null) return null
  if (typeof v === "string") return v
  return null
}

// 一组合法 message 条目 → 规整为 PayloadMessage；识别不足返回 null
function normalizeMessages(entries: unknown): PayloadMessage[] | null {
  if (!Array.isArray(entries) || entries.length === 0) return null
  const out: PayloadMessage[] = []
  for (const raw of entries) {
    const o = asObject(raw)
    if (!o) return null
    const role = typeof o.role === "string" ? o.role : ""
    const contentRaw = msgContent(o.content)
    if (!role && contentRaw === null) return null // 至少要有 role 或 content 之一
    out.push({ ...o, role, content: contentRaw ?? "" })
  }
  return out
}

export function tryParsePayload(text: string): PayloadParse | null {
  let root: unknown
  try {
    root = JSON.parse(text)
  } catch {
    return null
  }

  // 顶层自身就是 {role,content} 列表，或裸 messages 数组
  const rootArr = normalizeMessages(root)
  if (rootArr) return { messages: rootArr, meta: [] }

  const obj = asObject(root)
  if (!obj) return null

  // 候选：obj.messages，其次任意值数组字段里第一个能识别成 message 列表的
  const direct = normalizeMessages(obj.messages)
  if (direct) {
    const meta: Array<[string, string]> = []
    for (const k of Object.keys(obj)) {
      if (META_KEYS.has(k) && (typeof obj[k] === "string" || typeof obj[k] === "number")) {
        meta.push([k, String(obj[k])])
      }
    }
    return { messages: direct, meta }
  }

  for (const k of Object.keys(obj)) {
    if (k === "messages") continue
    const cand = normalizeMessages(obj[k])
    if (cand) return { messages: cand, meta: [] }
  }

  return null
}
