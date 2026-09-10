// DM 用户消息「包裹层」—— 前端在**发送前**给用户消息套一行系统前缀。
//
// 位置与语义（见 ignored/dm-design.md §7）：
//   - 前缀行随正文一起发出 → 后端落盘进 .sessions/dm.jsonl + 喂给 DM（DM 据此知道
//     这句是玩家发言、是否已入呈现记录、以及自己的下一条 seq）。
//   - **不落进 runtime/dm-output.jsonl** —— 后端写呈现记录时会剥掉前缀（呈现是玩家
//     可见的气泡，不含元信息）。
//
// 前缀格式（固定 fence `[[TH-SYS …]]`，内部区分两种）：
//   [[TH-SYS presence N]]   扮演发言（沙盒输入）——已进 dm-output，seq=N
//   [[TH-SYS ooc]]          局外发言（DM 控制台输入）——不进 dm-output
//
// 渲染：
//   - 导演栏（DM 控制台）读 session → 调用 parseDmWrap() 把前缀裁掉、渲染为 badge
//     （`#N` / `#ooc`），只显示 body。
//   - 沙盒气泡读 dm-output（已无前缀）→ 直接当正文渲染，无需解析。

const PRESENCE_RE = /^\[\[TH-SYS presence (\d+)\]\]$/
const OOC_MARKER = "[[TH-SYS ooc]]"

export function dmPresenceMarker(seq: number): string {
  return `[[TH-SYS presence ${seq}]]`
}

export const dmOocMarker = OOC_MARKER

/** 给用户消息套上前缀行（`<marker>\n\n<body>`）。 */
export function wrapDmMessage(raw: string, opts: { ooc: boolean; seq?: number }): string {
  const marker = opts.ooc ? OOC_MARKER : dmPresenceMarker(opts.seq ?? 0)
  return `${marker}\n\n${raw}`
}

/** 解析包裹层。无前缀时 marker 为 null、body 为原文。 */
export function parseDmWrap(content: string): { marker: string | null; body: string } {
  const idx = content.indexOf("\n\n")
  const first = idx === -1 ? content : content.slice(0, idx)
  if (first === OOC_MARKER || PRESENCE_RE.test(first)) {
    return { marker: first, body: idx === -1 ? "" : content.slice(idx + 2) }
  }
  return { marker: null, body: content }
}

/** 前缀 → 控制台 badge 文案（`#N` / `#ooc`）；无前缀 → null。 */
export function dmBadgeLabel(marker: string | null): string | null {
  if (!marker) return null
  const m = PRESENCE_RE.exec(marker)
  if (m) return `#${m[1]}`
  if (marker === OOC_MARKER) return "#ooc"
  return null
}
