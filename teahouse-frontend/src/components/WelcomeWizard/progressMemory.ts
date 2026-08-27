const STORAGE_KEY = "teahouse_wizard_lit"

/**
 * 「上次离开向导时，哪几项已经点亮了」的记忆。
 *
 * 用途只有一个：进页面时拿它和当前状态做差集，得出**本次新完成**的项，
 * 给这些项放点亮特效——已经亮了很久的项不该每次进来都再闪一遍。
 *
 * 刻意不做成 zustand store：基线只在向导挂载那一刻读一次（存进组件的
 * useState 初始值里），之后 store 化的响应式更新反而会把基线冲掉、
 * 让刚播完特效的项立刻"变成旧项"。读写各一次的纯 localStorage 更合适。
 *
 * 只记**真正完成**的项，不记「跳过」——跳过是用户主动放弃，不该有庆祝特效。
 */

/** 读取上次记录的已点亮项；隐私模式 / 坏数据一律退化成「一项都没亮过」（于是全部当作本次新完成）。 */
export function loadLitSteps(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    const arr = raw ? JSON.parse(raw) : []
    return Array.isArray(arr) ? Object.fromEntries(arr.map((k: string) => [k, true])) : {}
  } catch {
    return {}
  }
}

/** 覆盖写入当前已点亮项。写失败就只在本次会话生效，不影响流程。 */
export function saveLitSteps(keys: string[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(keys))
  } catch {
    // 配额满 / 隐私模式：下次进来会当成「全是新完成的」再闪一次，可接受
  }
}
