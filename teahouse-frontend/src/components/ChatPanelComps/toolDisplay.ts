import type { TFunction } from "i18next"
import {
  Terminal, FileText, FilePlus, FileCode, PenLine, Search, FolderSearch, FolderPlus,
  Trash2, GitBranch, GitCommit, GitCompare, History, ListChecks, Undo2,
  Hash, Wrench, ListTodo, Sparkles, Layers, MessageSquare, Send, Flag, Scissors,
  Timer, Dices, PackageCheck, BookOpen, ScrollText, ShieldAlert, type LucideIcon,
} from "lucide-react"

/**
 * 每个内置工具在导演栏气泡里的展示形态。
 *
 * 后端 tool_result 的 `result` 是**纯字符串**（executor 已把结构拍平），所以这里
 * 按工具解析该字符串得到"有意义的摘要"。解析失败一律回退 `summary: null`，
 * 由调用方退回默认渲染（原始结果截断）——格式漂移只会降级，不会崩。
 *
 * `target` 是标题行里工具名右侧的最重要标识（文件路径 / skill 名 / 模式 / 消息）。
 * `summary` 为 null 表示"没有可用摘要"，调用方按默认渲染处理（含错误、插件工具）。
 */
export interface ToolSummary {
  icon: LucideIcon
  target: string
  summary: string | null
  /** 展开原文时的渲染方式：diff 走逐行 +/- 着色 */
  rawKind?: "diff"
}

/** 千分位；负数与小数保持原样。 */
function n(v: number): string {
  return v.toLocaleString()
}

/** 从 "1,234" 这类千分位串还原成数字。 */
function num(s: string | undefined): number {
  return Number((s ?? "").replace(/,/g, "")) || 0
}

function str(v: unknown): string {
  return typeof v === "string" ? v : ""
}

/**
 * BatchGenerate 的结果拆成逐条明细，供 BatchGenerateResult 渲染成清单。
 *
 * 后端结果形如（状态与路径之间的空格数不固定，部分/失败还各带一种尾巴）：
 *   BatchGenerate 完成 2/3（失败步可单独重发普通 Generate 重试）
 *     [1] ok    temp/a.md
 *     [2] 部分  temp/b.md（生成中断，已落盘半成品）
 *     [3] 失败  temp/c.md — Error: 正文模型返回为空
 */
export type BatchStepStatus = "ok" | "部分" | "失败"

export interface BatchStep {
  status: BatchStepStatus
  path: string
  note: string | null
}

export function parseBatchSteps(result: string): BatchStep[] {
  const steps: BatchStep[] = []
  for (const line of result.split("\n")) {
    const m = line.match(/^\s*\[\d+\]\s+(ok|部分|失败)\s+(.*)$/)
    if (!m) continue
    let rest = m[2]
    let note: string | null = null
    const dash = rest.indexOf(" — ")
    if (dash !== -1) {
      // 失败：`{path} — {原因}`
      note = rest.slice(dash + 3)
      rest = rest.slice(0, dash)
    } else {
      // 部分：`{path}（说明）`
      const paren = rest.match(/^(.+?)（(.+)）$/)
      if (paren) {
        rest = paren[1]
        note = paren[2]
      }
    }
    steps.push({ status: m[1] as BatchStepStatus, path: rest, note })
  }
  return steps
}

/** 文本的"字数"与行数（末尾换行不计入行数）。 */
function textSize(text: string): { chars: number; lines: number } {
  if (!text) return { chars: 0, lines: 0 }
  const body = text.endsWith("\n") ? text.slice(0, -1) : text
  return { chars: text.length, lines: body.split("\n").length }
}

// Read 结果里被行号 gutter 包住的正文：`{行号}  │ {内容}`（切片模式还有 `~` 前缀）。
// 跳过 footer、空 gutter 行与切片段头，只累加真正的正文。
function readContentChars(result: string): number {
  let chars = 0
  for (const line of result.split("\n")) {
    const idx = line.indexOf("│ ")
    if (idx === -1) continue
    chars += line.length - (idx + 2)
  }
  return chars
}

// 数"非空行"——用于条目本身带缩进的列表（git status 变更行、分支列表）。
function countNonEmpty(result: string, skip = 0): number {
  return result.split("\n").slice(skip).filter((l) => l.trim() !== "").length
}

// 数"顶格行"——用于条目顶格、续行缩进的列表（变量条目 name: value + 缩进的 note）。
function countAtRoot(result: string, skip = 0): number {
  return result.split("\n").slice(skip).filter((l) => l !== "" && !/^\s/.test(l)).length
}

interface SummaryCtx {
  name: string
  args: Record<string, unknown>
  result: string
  t: TFunction
}

/** 逐工具摘要。返回 null = 该工具没有特化摘要，回退默认渲染。 */
function buildSummary({ name, args, result, t }: SummaryCtx): string | null {
  const k = (key: string, opts?: Record<string, unknown>) => t(`assistant.tools.${key}`, opts)

  switch (name) {
    // ---- 文件读 ----
    case "Read": {
      const chars = readContentChars(result)
      const trunc = result.includes("已达单次读取上限") ? k("truncated") : ""
      const slice = result.match(/\(slice: (\d+) 行 \/ (\d+) 个文件, source: /)
      if (slice) {
        return k("readSlice", { rows: n(Number(slice[1])), files: n(Number(slice[2])), chars: n(chars) }) + trunc
      }
      const lines = result.match(/\((\d+)–(\d+)\/(\d+) lines, source: /)
      if (lines) {
        return k("readLines", { a: n(Number(lines[1])), b: n(Number(lines[2])), chars: n(chars) }) + trunc
      }
      return null
    }
    case "Glob": {
      const m = result.match(/^\((\d+) files\)$/m)
      if (m) return k("globFiles", { n: n(Number(m[1])) })
      if (/^No files matched/.test(result)) return k("noMatch")
      return null
    }
    case "Grep": {
      const m = result.match(/^\((\d+) files\)$/m)
      if (!m) return /^No files matched/.test(result) ? k("noMatch") : null
      let matches = 0
      for (const line of result.split("\n").slice(1)) {
        const explicit = line.match(/ \((\d+) matches\)$/)
        if (explicit) { matches += Number(explicit[1]); continue }
        const range = line.match(/ : ([\d, ]+)$/)
        if (range) matches += range[1].split(",").length
      }
      return k("grepStat", { files: n(Number(m[1])), matches: n(matches) })
    }
    case "SkillRead": {
      const body = result.split("\n").slice(2).join("\n")
      return k("skillLoaded", { chars: n(body.length) })
    }
    case "CheckPackageRefs": {
      const broken = result.match(/^\((\d+) broken package refs\)$/m)
      if (broken) return k("refsBroken", { n: n(Number(broken[1])) })
      const checked = result.match(/（检查了 (\d+) 处引用）/)
      if (checked) return k("refsOkN", { n: n(Number(checked[1])) })
      if (result.startsWith("所有 ")) return k("refsOk")
      return null
    }
    case "CheckDMConfig": {
      const fatal = (result.match(/^\[✗ 会崩\]/gm) || []).length
      const silent = (result.match(/^\[! 静默\]/gm) || []).length
      if (fatal || silent) return k("dmConfigIssues", { fatal: n(fatal), silent: n(silent) })
      if (/配置正常/.test(result)) return k("dmConfigOk")
      return null
    }

    // ---- 文件写 ----
    case "Write": {
      // 开了 resolve_placeholders 时，落盘内容 ≠ args.content（切片会被展开成
      // 整个文件），此时只能信 result 里的字节数，不能拿 args 充数。
      if (args.resolve_placeholders) {
        const bytes = result.match(/Successfully wrote ([\d,]+) bytes to /)
        if (bytes) return k("writeBytes", { bytes: num(bytes[1]).toLocaleString() })
      }
      const { chars, lines } = textSize(str(args.content))
      return k("writeStat", { lines: n(lines), chars: n(chars) })
    }
    case "WriteLine": {
      const { chars } = textSize(str(args.new_content))
      return k("linesRange", {
        a: n(Number(args.start_line) || 0),
        b: n(Number(args.end_line) || 0),
        chars: n(chars),
      })
    }
    case "Edit": {
      const all = result.match(/Successfully replaced all (\d+) occurrences/)
      if (all) return k("editStatAll", { n: n(Number(all[1])) })
      if (/Successfully applied edit to /.test(result)) return k("editStat", { n: n(1) })
      return null
    }
    case "Report": {
      const { chars } = textSize(str(args.content))
      return k("reported", { name: str(args.filename) || "—", chars: n(chars) })
    }
    case "FileOps": {
      const action = str(args.action)
      if (action === "mkdir") return k("dirCreated")
      if (action === "move") return k("moved", { dest: str(args.destination) || "—" })
      if (action === "delete") return k("deleted", { path: str(args.path) || "—" })
      return null
    }

    // ---- git ----
    case "GitStatus": {
      if (result.startsWith("工作区干净")) return k("gitClean")
      if (result.startsWith("工作区变更")) return k("gitChanges", { n: n(countNonEmpty(result, 1)) })
      return null
    }
    case "GitDiff": {
      if (/^没有(已暂存的)?差异/.test(result)) return k("gitNoDiff")
      let files = 0, add = 0, del = 0
      for (const line of result.split("\n")) {
        if (line.startsWith("diff --git ")) files++
        else if (line.startsWith("+") && !line.startsWith("+++")) add++
        else if (line.startsWith("-") && !line.startsWith("---")) del++
      }
      return k("gitDiffStat", { files: n(files), add: n(add), del: n(del) })
    }
    case "GitLog": {
      const m = result.match(/^最近 (\d+) 条提交/)
      if (m) return k("gitLogCount", { n: n(Number(m[1])) })
      return null
    }
    case "GitCommit": {
      if (result.startsWith("提交成功")) {
        const hash = result.match(/Commit: (\w+)/)
        return k("gitCommitted", { hash: hash ? hash[1].slice(0, 7) : "—" })
      }
      if (result.startsWith("没有需要提交的变更")) return k("gitNothingToCommit")
      return null
    }
    case "GitBranch": {
      const action = str(args.action)
      const name = str(args.name) || "—"
      if (action === "list") {
        const m = result.match(/分支列表：\n([\s\S]*)/)
        return m ? k("branchList", { n: n(countNonEmpty(m[1])) }) : null
      }
      if (action === "create") return k("branchCreated", { name })
      if (action === "switch") return k("branchSwitched", { name })
      if (action === "delete") return k("branchDeleted", { name })
      if (action === "rename") return k("branchRenamed", { name, new: str(args.new_name) || "—" })
      return null
    }
    case "GitCheckout": {
      const m = result.match(/目标提交: (\w+)/)
      return m ? k("checkedOut", { hash: m[1].slice(0, 7) }) : null
    }

    // ---- 变量 ----
    case "GetRuntimeVars": {
      if (result.startsWith("No sandbox variables")) return k("varNone")
      return k("varCount", { n: n(countAtRoot(result)) })
    }
    case "SetRuntimeVar": {
      if (result.startsWith("Variables deleted:")) {
        const names = result.split("\n")[0].replace("Variables deleted:", "").split(",").filter((s) => s.trim())
        return k("varDeleted", { n: n(names.length) })
      }
      if (result.startsWith("Variables set:")) return k("varSet", { n: n(countAtRoot(result, 1)) })
      if (result.startsWith("No variables found")) return k("varNone")
      return null
    }
    case "RepairVars": {
      const floor = result.match(/当前正式楼层：(\d+)/)
      const vars = result.match(/变量数：(\d+)/)
      if (!floor || !vars) return null
      return k("varRepaired", { floor: n(Number(floor[1])), vars: n(Number(vars[1])) })
    }

    // ---- 生成 / 呈现 ----
    case "Generate": {
      const done = result.match(/字数：(\d+)/)
      if (done) return k("generated", { n: n(Number(done[1])) })
      const partial = result.match(/已产出字数：(\d+)/)
      if (partial) return k("generatedPartial", { n: n(Number(partial[1])) })
      return null
    }
    // 汇总走标题行、逐条明细由 BatchGenerateResult 渲染，此处不出摘要。
    case "BatchGenerate":
      return null
    case "Output": {
      const { chars } = textSize(str(args.content))
      return k("outputShown", { chars: n(chars) })
    }
    case "OutputEdit":
      return k("outputEdited")

    // ---- 杂项 ----
    case "Roll": {
      // `note` 是导演给这次掷骰的说明，只存在于工具入参里（execute_roll 不用它、
      // 也不会落进会话记录）——纯展示时从 args 现取，不入 result、不进 LLM 上下文。
      // 有 note 时把它当标题（说明这一掷是干什么的），正文补出骰式；没 note 时
      // 标题回落骰式，正文只留结果，避免重复。
      return str(args.note).trim()
        ? k("rolledDice", { dice: str(args.dice), value: result.trim() })
        : k("rolled", { value: result.trim() })
    }
    case "Wait":
      return k("waited", { ms: n(Number(args.ms) || 0) })
    case "PruneContext": {
      if (result.startsWith("当前没有可压缩")) return k("pruneNone")
      const cand = result.match(/可压缩候选 (\d+) 条，合计可省约 ([\d,]+) 字符/)
      if (cand) return k("pruneCandidates", { n: n(Number(cand[1])), chars: n(num(cand[2])) })
      const applied = result.match(/已压缩 (\d+) 处，释放约 ([\d,]+) 字符/)
      if (applied) return k("pruneApplied", { n: n(Number(applied[1])), chars: n(num(applied[2])) })
      return null
    }

    // ---- 子会话 ----
    case "StartSubSession": {
      const m = result.match(/sub-session (session-\w+)/)
      return m ? k("subCreated", { sid: m[1] }) : null
    }
    case "SendToSubSession":
      return k("subSent", { sid: str(args.session_id) || "—" })
    case "DeleteSubSession":
      return k("subDestroyed", { sid: str(args.session_id) || "—" })
    case "EndSession": {
      const m = result.match(/^Session (\S+) marked done/)
      return k("sessionEnded", { sid: m ? m[1] : "main" })
    }

    default:
      return null
  }
}

const ICONS: Record<string, LucideIcon> = {
  Read: FileText,
  Glob: FolderSearch,
  Grep: Search,
  CheckPackageRefs: PackageCheck,
  CheckDMConfig: ShieldAlert,
  SkillRead: BookOpen,
  Write: FilePlus,
  Edit: PenLine,
  WriteLine: FileCode,
  FileOps: FolderPlus,
  Report: ScrollText,
  GitCommit: GitCommit,
  GitBranch: GitBranch,
  GitCheckout: Undo2,
  GitLog: History,
  GitDiff: GitCompare,
  GitStatus: ListChecks,
  GetRuntimeVars: Hash,
  SetRuntimeVar: Hash,
  RepairVars: Wrench,
  TodoWrite: ListTodo,
  Generate: Sparkles,
  BatchGenerate: Layers,
  Output: MessageSquare,
  OutputEdit: PenLine,
  Roll: Dices,
  Wait: Timer,
  PruneContext: Scissors,
  StartSubSession: Send,
  SendToSubSession: Send,
  DeleteSubSession: Trash2,
  EndSession: Flag,
}

/**
 * 标题行里工具名右侧的最重要标识。
 *
 * 多数工具取入参（路径 / 模式 / 提交信息）；BatchGenerate 例外——它取结果里的
 * 汇总（"完成 2/3"），逐条明细交给 BatchGenerateResult 放在正文。
 */
function buildTarget(
  name: string,
  args: Record<string, unknown>,
  t: TFunction,
  result: string | undefined,
): string {
  switch (name) {
    case "TodoWrite": {
      const todos = Array.isArray(args.todos) ? (args.todos as unknown[]) : []
      return t("assistant.tools.todoTop", { n: n(todos.length) })
    }
    case "Read":
      return str(args.slice) || str(args.path)
    case "Write":
    case "WriteLine":
      return str(args.path)
    case "Edit": {
      const slice = str(args.slice)
      if (slice) return slice
      const p = str(args.path)
      const range =
        args.offset != null || args.limit != null
          ? `:${args.offset ?? 1}${args.limit != null ? `+${args.limit}` : ""}`
          : ""
      return `${p}${range}`
    }
    case "Glob":
    case "Grep":
      return str(args.pattern) + (name === "Grep" && args.path ? `  ← ${str(args.path)}` : "")
    case "SkillRead":
      return str(args.name) + (args.file ? `/${str(args.file)}` : "")
    case "GitCommit":
      return str(args.message)
    case "GitBranch":
      return str(args.name) || str(args.action)
    case "GitCheckout":
      return str(args.target_hash)
    case "GitDiff":
      return str(args.path)
    case "GetRuntimeVars":
      return Array.isArray(args.names) ? (args.names as string[]).join(", ") : str(args.names)
    case "SetRuntimeVar": {
      const names = new Set<string>()
      for (const key of ["updates", "note", "change_log", "meta"] as const) {
        const mapping = args[key]
        if (mapping && typeof mapping === "object") Object.keys(mapping).forEach((x) => names.add(x))
      }
      if (Array.isArray(args.delete)) (args.delete as string[]).forEach((x) => names.add(x))
      return [...names].join(", ")
    }
    case "Generate":
      return str(args.path)
    case "BatchGenerate": {
      // 标题放汇总，明细（哪几步成功/失败）在正文清单里。
      const m = (result ?? "").match(/BatchGenerate 完成 (\d+)\/(\d+)/)
      return m
        ? t("assistant.tools.batchDone", { ok: n(Number(m[1])), total: n(Number(m[2])) })
        : ""
    }
    case "Output":
      return str(args.chara)
    case "OutputEdit":
      return args.seq != null ? `#${args.seq}` : ""
    case "Roll":
      return str(args.note).trim() || str(args.dice)
    case "Wait":
      return args.ms != null ? `${args.ms}ms` : ""
    case "Report":
      return str(args.filename)
    case "CheckDMConfig":
      return str(args.path) || "dm.yaml"
    case "FileOps":
      return str(args.path)
    case "StartSubSession":
      return str(args.task)
    case "SendToSubSession":
    case "DeleteSubSession":
    case "EndSession":
      return str(args.session_id)
    default:
      return ""
  }
}

/**
 * 计算气泡的展示形态。未知工具（插件工具等）自动落回 `{Terminal, "", null}`，
 * 由调用方走默认渲染。
 *
 * `summary` 仅在**成功**结果上计算——错误与未完成（result 为空）一律返回 null，
 * 让调用方沿用其错误 / 执行中的呈现。
 */
export function toolSummary(
  name: string,
  args: Record<string, unknown> | undefined,
  result: string | undefined,
  t: TFunction,
): ToolSummary {
  const a = args || {}
  const icon = ICONS[name] ?? Terminal
  const target = buildTarget(name, a, t, result)

  const ok = typeof result === "string" && result !== "" && result !== "(interrupted)" && !result.startsWith("Error")
  const summary = ok ? buildSummary({ name, args: a, result: result as string, t }) : null

  return { icon, target, summary, rawKind: name === "GitDiff" ? "diff" : undefined }
}
