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

export interface RichMessage {
  id: string
  role: "user" | "assistant"
  content: string              // 完整文字内容（向后兼容）
  reasoning: string
  status: MsgStatus
  /** 交错的内容块：text + tool_call 按生成顺序排列 */
  blocks?: ContentBlock[]
  /** 后端队列 ID，用于 queued→done 升级匹配 */
  _queue_id?: string
}
