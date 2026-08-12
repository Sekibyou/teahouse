export type MsgStatus = "pending" | "reasoning" | "streaming" | "done" | "queued"

export interface ContentBlock {
  type: "text" | "tool_call"
  text?: string                // type=text 时的文字片段
  id?: string                  // type=tool_call 时的 call id
  name?: string                // type=tool_call 时的工具名
  args?: Record<string, unknown>
  result?: string
  /** BatchExecute 展开显示元数据：{path, index, total}（仅用于标注，不进 LLM） */
  batch?: { path: string; index: number; total: number }
}

/**
 * 单条 UI 气泡（物理拆分后：每条 JSONL 记录 → 一个或多个气泡）。
 *
 * 顺序由后端 JSONL 唯一决定：``order`` 是会话内单调自增的 record id，
 * ``sub`` 区分同一条记录内的子泡（assistant 的 reasoning="r"，blocks[i]=i；
 * user 为 null）。``subRank`` 是数值排序 key（reasoning=-1, blocks 0..n，
 * user=0），前端按 ``(order, subRank)`` 纯排序渲染，不再用状态推断。
 */
export interface RichMessage {
  id: string
  role: "user" | "assistant"
  content: string              // 该气泡的完整文字内容
  reasoning: string
  status: MsgStatus
  /** 该气泡承载的内容块（物理拆分后单泡至多一个块） */
  blocks?: ContentBlock[]
  /** 后端统一顺序号（record id），jsonl 唯一事实来源 */
  order: number
  /** 同 record 内的子泡序号："r"=reasoning，数字=block i，user=null */
  sub: number | "r" | null
  /** 数值排序 key，配合 order 使用（reasoning=-1, blocks 0..n, user=0） */
  subRank: number
  /** 后端队列 ID，用于 queued→done 升级匹配 */
  _queue_id?: string
  /** 固定格式 `[auto]` 系统消息的归类（特殊标记渲染）；普通消息无此字段 */
  autoKind?: "interrupt" | "endsession" | "session_done" | "compact" | "auto_continue"
  /** 当 autoKind==="session_done" 时，提取出的子会话 sid（如 "session-<uuid>"） */
  autoSid?: string
}

