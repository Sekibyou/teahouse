// teahouseVars — 解析并应用正文里的 `<!-- teahouse-vars: [...] -->` 变量操作块。
//
// 本文件是纯逻辑模块（无 React / 无 API 依赖），可独立测试。宿主 SandboxManager
// 的 `commitDraft` 复用它：解析块 → 逐条应用 → 给每条标记 msg(consumed/error) →
// 把标记后的正文文本写回。
//
// 约定源：tests/teahouse-commit-draft-api.md (v2)。所有语义须与之保持一致。

// ---- 暴露给正文 bot 的合法类型（硬约束）----
type VarValue = boolean | string | number | unknown[]

type Action =
  | { type: "set"; name: string; value: VarValue }
  | { type: "add"; name: string; value: number }
  | { type: "append"; name: string; value: VarValue }
  | { type: "pop"; name: string; value: VarValue }
  | { type: "x"; name: string; index: number; value: VarValue }

/** 内部展开后的操作：带命名参数、带原文引用。 */
interface ParsedAction {
  /** 原始 type 字符串（用于失败留痕）。 */
  type: Action["type"]
  name: string
  /** set/append/pop/x 的 value；add 的 delta；x 必带 index。 */
  value?: unknown
  index?: number
  /** 在原始 JSON 数组中的下标（用于回溯定位）。 */
  _index: number
}

interface AppliedAction {
  type: Action["type"]
  name: string
  value?: unknown
  index?: number
  /** 应用后的现值（add/append/pop/x 反映变更后；set 即写入值）。 */
  applied_value?: unknown
}

interface FailedAction {
  /** 原始 type；坏块（JSON 整体损坏）用 "_block"。 */
  type: string
  name: string
  value?: unknown
  index?: number
  /** 失败原因（写入正文 msg: "error: <原因>"）。 */
  error: string
}

export interface CommitDraftResult {
  /** 本次实际操作的条数（含成功的与失败的）。 */
  applied: AppliedAction[]
  /** 本次解析失败的 action（error 已含原因）。 */
  failed: FailedAction[]
  /** 成功写入的变量（name → 新值），调用方据此组装一次 setVar。 */
  updates: Record<string, unknown>
  /** 标注后的正文文本（成功加 consumed、失败加 error），写回用它。 */
  markedMarkdown: string
}

// ---- 序号 => 中文名（用于错误信息）----

/** 深相等：数组/对象逐字段比较，标量用 ===（pop 按值匹配、x/append 定位用）。 */
function deepEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (isArray(a) && isArray(b)) {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (!deepEquals(a[i], b[i])) return false
    return true
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a as Record<string, unknown>)
    const kb = Object.keys(b as Record<string, unknown>)
    if (ka.length !== kb.length) return false
    for (const k of ka) {
      if (!Object.prototype.hasOwnProperty.call(b as object, k)) return false
      if (!deepEquals((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false
    }
    return true
  }
  return false
}

/**
 * 防御性修复正文 bot 写坏的 JSON 大字面量：`"value": True` → `"value": true`。
 *
 * 正文变量清单用 Python 风格渲染现值（大写 True/False），bot 有时会照抄进
 * teahouse-vars 块，导致 `JSON.parse` 整块失败。此处只在 `"value"` 字段值位置
 * 把裸的大写 True/False 换成小写（JSON 合法字面量）。
 *
 * 覆盖范围刻意收窄——正则要求 `"value"` 冒号后紧邻一个裸 `True|False` 且其后是
 * `空白/,/]/}`。因此不会误伤：
 *   - 字符串值 `"value": "False"`（其后是引号）
 *   - 嵌套对象 `"value": {"x": False}`（False 前是 "x": 不是 "value":）
 *   - 数组内嵌 `"value": [False]` / 嵌套对象 `[... {"size":True}]`（前缀不同）
 *   - 非 value 键 `{"x": True}`
 * 数组/深嵌套里的大写布尔修复不到，交给「坏块留痕」兜底。
 */
function repairVarsJsonLiteral(jsonStr: string): string {
  return jsonStr.replace(
    /("value"\s*:\s*)(True|False)(?=[\s,\]\}])/g,
    (_m, p1: string, p2: string) => p1 + p2.toLowerCase(),
  )
}

/**
 * 解析块内 JSON（先防御替换）。返回 {ok, value}：value 为数组或 null。
 * 修复后仍解析失败（bot 写了其它非法结构）→ ok=false。
 */
function tryParseVarBlock(jsonStr: string): { ok: boolean; value: unknown[] | null; error?: string } {
  const repaired = repairVarsJsonLiteral(jsonStr)
  try {
    const p = JSON.parse(repaired)
    if (Array.isArray(p)) return { ok: true, value: p }
    return { ok: false, value: null, error: "teahouse-vars 顶层必须是 JSON 数组" }
  } catch (e) {
    return { ok: false, value: null, error: `teahouse-vars JSON 解析失败：${e instanceof Error ? e.message : String(e)}` }
  }
}

/** 断言 name 无空白、无冒号 —— 与后端 validate_var_name 一致（空白破坏 ${...} 标识符；冒号是 ${type:名字} 类型语法的保留前缀）。 */
function validateName(name: unknown): string | null {
  if (typeof name !== "string") return "name 必须是字符串"
  if (name.trim() === "") return "name 不能为空"
  if (/\s/.test(name)) return `变量名「${name}」禁止含空白字符`
  if (name.includes(":")) return `变量名「${name}」禁止含冒号「:」（它是 \${type:名字} 类型语法的保留前缀）`
  return null
}

function isNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v)
}

function isArray(v: unknown): v is unknown[] {
  return Array.isArray(v)
}

/**
 * 解析正文里的 teahouse-vars 块。
 * 返回无 msg、待消费的裸 action 列表；块缺省 / 解析失败返回空数组。
 * @param markdown 正文文本
 */
export function parseTeahouseVars(markdown: string): ParsedAction[] {
  if (!markdown) return []
  // <!-- teahouse-vars: JSON -->  不限位置：文中/文末均可。非贪婪到最近 `-->`。
  const m = /<!--\s*teahouse-vars\s*:\s*([\s\S]*?)\s*-->/m.exec(markdown)
  if (!m) return []
  const { ok, value } = tryParseVarBlock(m[1])
  if (!ok || !value) return []
  const out: ParsedAction[] = []
  for (let i = 0; i < value.length; i++) {
    const raw = value[i]
    if (!raw || typeof raw !== "object") continue
    const o = raw as Record<string, unknown>
    if (typeof o.type !== "string") continue
    // 已消费/已留痕的裸 action 不在此列（调用方已过滤 msg），但防御：带 msg 跳过。
    if (o.msg !== undefined) continue
    const t = o.type as string
    // 合法的五类 type 且必需字段类型正确
    if (t === "set" && "name" in o && "value" in o) {
      out.push({ type: "set", name: String(o.name), value: o.value, _index: i })
    } else if (t === "add" && "name" in o && "value" in o) {
      out.push({ type: "add", name: String(o.name), value: o.value, _index: i })
    } else if (t === "append" && "name" in o && "value" in o) {
      out.push({ type: "append", name: String(o.name), value: o.value, _index: i })
    } else if (t === "pop" && "name" in o && "value" in o) {
      out.push({ type: "pop", name: String(o.name), value: o.value, _index: i })
    } else if (t === "x" && "name" in o && "index" in o && "value" in o) {
      out.push({ type: "x", name: String(o.name), index: o.index as number, value: o.value, _index: i })
    }
    // 其余（未知 type / 缺字段）—— 保持原样不消费，转正时既不 applied 也不 failed（留待人工）
  }
  return out
}

/**
 * 把带 msg 标注意的 action 数组重序列化回正文文本，替换原 teahouse-vars 块。
 * 不认得的裸 action（解析阶段没拆出来的）保持原样。
 * @param markdown 原正文
 * @param updates 每项 { index-or-原下标, newObj } 的替换信息，由 apply 阶段生成
 */
export function replaceVarsBlock(markdown: string, block: Array<Record<string, unknown>>): string {
  const json = JSON.stringify(block, null, 2)
  // 用同样的正则整体替换块内容（不限位置）
  const re = /<!--\s*teahouse-vars\s*:\s*[\s\S]*?\s*-->/m
  if (!re.test(markdown)) return markdown
  return markdown.replace(re, `<!-- teahouse-vars: ${json} -->`)
}

/**
 * 从当前变量快照取现值（未设置 → undefined）。
 * @param vars 当前全部变量 [{name, value}]
 * @param name 变量名
 */
export function lookupVar(vars: Array<{ name: string; value?: unknown }>, name: string): unknown {
  for (let i = 0; i < vars.length; i++) {
    if (vars[i].name === name) return vars[i].value
  }
  return undefined
}

/**
 * 核心：对一组裸 action 逐条应用，返回 applied / failed / 更新的变量表 / 每条的新对象。
 *
 * @param actions 待消费的裸 action（来自 parseTeahouseVars，顺序敏感）
 * @param vars 当前变量表 [{name, value}]，函数内会 mutate
 * @returns applied（成功）/ failed（失败）+ 每条对应的更新后 JSON 对象
 */
export function applyActions(
  actions: ParsedAction[],
  vars: Array<{ name: string; value?: unknown }>,
): {
  applied: AppliedAction[]
  failed: FailedAction[]
  /** 成功写入的变量（name → 新值），调用方据此组装一次 setVar。 */
  updates: Record<string, unknown>
  /** 每条 action 序列化时应写回的对象（含 msg），原下标对应。 */
  marked: Map<number, Record<string, unknown>>
} {
  const applied: AppliedAction[] = []
  const failed: FailedAction[] = []
  const updates: Record<string, unknown> = {}
  const marked = new Map<number, Record<string, unknown>>()

  for (const act of actions) {
    const built = buildResultObject(act)
    marked.set(act._index, built)

    const nameErr = validateName(act.name)
    if (nameErr) {
      buildFailure(built, act, nameErr, failed, applied)
      continue
    }

    const cur = lookupVar(vars, act.name)
    const curIsSet = cur !== undefined

    try {
      switch (act.type) {
        case "set": {
          const v = act.value
          // 对象/数组禁止：对象非最佳实践；数组允许（属于合法类型）
          if (v !== null && typeof v === "object" && !isArray(v)) {
            buildFailure(built, act, `${act.name} 为对象类型，正文 bot 不维护对象，请改用 set 其合法标量/数组`, failed, applied)
          } else {
            setVarValue(vars, act.name, v)
            updates[act.name] = v
            buildApplied(built, act, v, applied)
          }
          break
        }
        case "add": {
          const delta = act.value
          if (!isNumber(delta)) {
            buildFailure(built, act, `${act.name} 的 add.value 必须为数字（得到 ${String(delta)}）`, failed, applied)
            continue
          }
          if (curIsSet && !isNumber(cur)) {
            buildFailure(built, act, `${act.name} 为 ${typeNameOf(cur)}，add 仅支持 number`, failed, applied)
            continue
          }
          // 未设按 0 起加
          const base = curIsSet ? (cur as number) : 0
          const next = base + delta
          setVarValue(vars, act.name, next)
          updates[act.name] = next
          buildApplied(built, act, next, applied)
          break
        }
        case "append": {
          const v = act.value
          // 已设但非数组：报错（避免把标量悄悄变成数组）。未设按空数组起步。
          if (curIsSet && !isArray(cur)) {
            buildFailure(built, act, `${act.name} 为 ${typeNameOf(cur)}，append 目标是 array`, failed, applied)
            continue
          }
          const arr = curIsSet ? (cur as unknown[]).slice() : []
          arr.push(v)
          setVarValue(vars, act.name, arr)
          updates[act.name] = arr
          buildApplied(built, act, arr, applied)
          break
        }
        case "pop": {
          if (!curIsSet || !isArray(cur)) {
            buildFailure(built, act, `${act.name} 为 ${curIsSet ? typeNameOf(cur) : "未设置"}，pop 目标是 array`, failed, applied)
            continue
          }
          const arr = cur as unknown[]
          const idx = arr.findIndex((e) => deepEquals(e, act.value))
          if (idx < 0) {
            // 未找到 —— 视为成功（幂等：目标已不存在）。记录现值不变量。
            buildApplied(built, act, arr.slice(), applied)
          } else {
            arr.splice(idx, 1)
            setVarValue(vars, act.name, arr.slice())
            updates[act.name] = arr.slice()
            buildApplied(built, act, arr.slice(), applied)
          }
          break
        }
        case "x": {
          if (!curIsSet || !isArray(cur)) {
            buildFailure(built, act, `${act.name} 为 ${curIsSet ? typeNameOf(cur) : "未设置"}，x 目标是 array`, failed, applied)
            continue
          }
          const arr = cur as unknown[]
          let raw = act.index
          if (!isNumber(raw)) {
            buildFailure(built, act, `x 的 index 必须为数字（得到 ${String(raw)}）`, failed, applied)
            continue
          }
          let idx = Math.trunc(raw)
          if (idx < 0) idx = arr.length + idx
          if (idx < 0 || idx >= arr.length) {
            buildFailure(built, act, `${act.name} 下标 ${raw} 越界（长度 ${arr.length}）`, failed, applied)
            continue
          }
          arr[idx] = act.value
          setVarValue(vars, act.name, arr.slice())
          updates[act.name] = arr.slice()
          buildApplied(built, act, arr.slice(), applied)
          break
        }
        default:
          buildFailure(built, act, `未知操作类型 ${String(act.type)}`, failed, applied)
      }
    } catch (e) {
      buildFailure(built, act, `应用失败：${e instanceof Error ? e.message : String(e)}`, failed, applied)
    }
  }
  return { applied, failed, updates, marked }
}

function typeNameOf(v: unknown): string {
  if (v === null) return "null"
  if (isArray(v)) return "array"
  return typeof v
}

function buildResultObject(act: ParsedAction): Record<string, unknown> {
  const o: Record<string, unknown> = { type: act.type, name: act.name }
  if (act.value !== undefined) o.value = act.value
  if (act.index !== undefined) o.index = act.index
  return o
}

function buildApplied(
  built: Record<string, unknown>,
  act: ParsedAction,
  appliedValue: unknown,
  applied: AppliedAction[],
): void {
  built.msg = "consumed"
  applied.push({
    type: act.type,
    name: act.name,
    value: act.value,
    index: act.index,
    applied_value: appliedValue,
  })
}

function buildFailure(
  built: Record<string, unknown>,
  act: ParsedAction,
  reason: string,
  failed: FailedAction[],
  applied: AppliedAction[],
): void {
  // 失败同样进 applied（含现值语义），便于导演在 vars_applied 里看到失败的现值。
  built.msg = `error: ${reason}`
  const f: FailedAction = { type: act.type, name: act.name, value: act.value, index: act.index, error: reason }
  failed.push(f)
  applied.push({ type: act.type, name: act.name, value: act.value, index: act.index, applied_value: undefined })
}

function setVarValue(vars: Array<{ name: string; value?: unknown }>, name: string, value: unknown): void {
  for (let i = 0; i < vars.length; i++) {
    if (vars[i].name === name) {
      vars[i].value = value
      return
    }
  }
  vars.push({ name, value })
}

// ---- 组合入口：给正文 + 当前变量，返回新正文 + applied/failed ----
/**
 * 处理一份正文的待消费 action：
 * @param markdown 正文全文（draft 或正式稿）
 * @param vars 当前变量表（外部已取全量快照）——函数内 mutate 为新值
 * @returns 新正文（含 msg 标注）+ applied/failed
 */
export function consumeVars(markdown: string, vars: Array<{ name: string; value?: unknown }>): CommitDraftResult {
  // 0) 坏块检测：块存在但修复后仍解析失败 → 不静默丢块，留痕失败并被导演看见。
  const badBlock = detectBrokenVarsBlock(markdown)
  if (badBlock) {
    return {
      applied: [],
      failed: [{ type: "_block", name: "", error: badBlock }],
      updates: {},
      // 原文写回（坏块留着，供人工修复），绝不改写为空
      markedMarkdown: markdown,
    }
  }

  const rawActions = parseTeahouseVars(markdown)
  // 只处理"无 msg"的裸 action：parse 已过滤带 msg 的，这里再保险
  const actions = rawActions.filter((a) => a && !("msg" in a))
  if (actions.length === 0) {
    // 无块或无待消费 → 正文原样，无操作
    return { applied: [], failed: [], updates: {}, markedMarkdown: markdown }
  }
  // 重新解析原始 blocks JSON，保持未消费的条目逐字保留
  const blocks = extractRawActions(markdown)
  const { applied, failed, updates, marked } = applyActions(actions, vars)
  // 用 marked 覆盖对应下标的条目
  for (const [idx, obj] of marked.entries()) {
    if (idx < blocks.length) {
      // 合并：保留原条目未提及字段（如 index 只在 x 有），并覆盖 msg
      blocks[idx] = { ...blocks[idx], ...obj }
    }
  }
  const newMarkdown = replaceVarsBlock(markdown, blocks)
  return { applied, failed, updates, markedMarkdown: newMarkdown }
}

/**
 * 检测"块存在但修复后仍解析失败"的情况。返回错误信息或 null。
 * 区别于无块（null）：无块是正常，坏块留痕。
 */
export function detectBrokenVarsBlock(markdown: string): string | null {
  if (!markdown) return null
  const m = /<!--\s*teahouse-vars\s*:\s*([\s\S]*?)\s*-->/m.exec(markdown)
  if (!m) return null
  const { ok, error } = tryParseVarBlock(m[1])
  return ok ? null : error ?? "teahouse-vars 块损坏"
}

/** 提取块内原始对象数组（还原逐条原始对象，含 index）；解析失败返回空数组。
 *  走 tryParseVarBlock，故 value 里的裸大写布尔已被修复为小写——写回正文的块合法。 */
export function extractRawActions(markdown: string): Array<Record<string, unknown>> {
  const m = /<!--\s*teahouse-vars\s*:\s*([\s\S]*?)\s*-->/m.exec(markdown || "")
  if (!m) return []
  const { ok, value } = tryParseVarBlock(m[1])
  if (!ok || !value) return []
  return value.filter((x) => x && typeof x === "object") as Array<Record<string, unknown>>
}
