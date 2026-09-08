import { create } from "zustand"

/**
 * 语义层栈 store —— 收口全应用"全屏弹层 / 抽屉 / 面板"对系统返回键（物理返回 / 手势 / 扫动）的响应。
 *
 * 为什么需要它（背景）：
 * 旧 `useDialogBackClose` 用模块级 `layers:[{id,onClose}]` 按"注册顺序"对应弹窗与 history 假条目，
 * 层无语义（无 kind / from / to）。两个硬伤：
 *   1. 组件卸载时只补弹"仍在自己栈顶"的假条目（topIsOwnLayer），一旦假条目被路由切走残留成孤儿，
 *      后续一次系统返回会越过该页直接退穿到更底层的真实路由（如从详情启动实例后 /workspace 退穿到大厅）。
 *   2. 无法表达"从哪个路由来、应回哪个路由"，退出守卫只能靠猜层数。
 *
 * 本 store 的职责边界：
 *   - **只收口应用层弹层的打开/关闭/顺序**（带 kind / route 语义），不镜像浏览器真实路由历史
 *     （真实路由不可枚举、假条目无 idx 会污染 react-router 计数，见调研）。
 *   - 真实路由部分交给 React Router；跨真实路由页跳转前由调用方调 `clearForRoute(route)` 预防孤儿。
 *
 * 物理承载：每个应用层 = 一条 `history.pushState({[STATE_KEY]: key})` 假条目。系统返回（popstate）
 * 时弹栈顶语义层、调其 onClose。主动关闭（点 X / 点遮罩）由组件调 `removeSelf`，内部用
 * `history.back()` 弹掉自己的假条目并用 suppress 标记吞掉那一下 popstate，避免 Router 收到后退。
 */

/** 语义层：k 唯一自增；kind 是弹层类型；route 是该层盖在哪个真实路由页之上（孤儿清理按它分组）；name 可读名。 */
export interface DialogLayer {
  key: number
  kind: string
  route: string // 真实路由 path（"/" 大厅 / "/workspace"）——clearForRoute 的清理依据
  name?: string
  onClose: () => void
}

const STATE_KEY = "__teahouseDialog"

// —— 模块级弹层栈（跨组件共享，非 React state）——
let layers: DialogLayer[] = []
let layerSeq = 0
let installed = false
// 主动关闭触发 history.back() 会带来一次 popstate；用计数跳过它
let suppressNextPop = 0

/** 当前历史栈顶 state 是否正是某层压的假条目 */
function topIsOwnLayer(key: number): boolean {
  const s = typeof history.state === "object" && history.state !== null ? history.state : {}
  return s[STATE_KEY] === key
}

function popLayerOnBack() {
  if (suppressNextPop > 0) {
    suppressNextPop--
    return
  }
  const top = layers[layers.length - 1]
  if (!top) return // 栈空 → 没有弹窗等返回 → 放行给 Router 正常后退
  layers.pop()!
  top.onClose()
}

function install() {
  if (installed) return
  installed = true
  window.addEventListener("popstate", popLayerOnBack)
}

interface DialogStackState {
  /** 压一层（附带一条 history 假条目承载）。返回该层 key。 */
  pushLayer: (layer: Omit<DialogLayer, "key">) => number
  /** 弹出最顶层并调其 onClose（= 一次系统返回的效果）。 */
  popTop: () => void
  /** 移除指定层并弹掉它的假条目（主动关闭用；suppress 掉那一下 popstate）。若该层已不在栈顶则忽略 back。 */
  removeSelf: (key: number) => void
  /** 关闭并摘掉所有挂在某真实路由页(route)上的层，按 LIFO 一个个调 onClose + 补弹假条目。
      在"导航离开该真实路由页"前调用，预防孤儿假条目残留。 */
  clearForRoute: (route: string) => void
}

/** 内部非响应式状态接口：这些层驱动命令式返回关闭（非 React 渲染），故仅暴露命令式动作。 */
export const dialogStackStore = create<DialogStackState>()(() => ({
  pushLayer: (layer) => {
    install()
    const key = ++layerSeq
    layers.push({ key, ...layer })
    history.pushState({ [STATE_KEY]: key }, "")
    return key
  },
  popTop: () => {
    const top = layers[layers.length - 1]
    if (!top) return
    layers.pop()!
    top.onClose()
  },
  removeSelf: (key) => {
    const idx = layers.findIndex((l) => l.key === key)
    if (idx < 0) return
    layers.splice(idx, 1)
    // 只有该层压的假条目仍在栈顶时才可安全补弹；否则说明已被系统返回消费/路由切走，不再补
    if (topIsOwnLayer(key)) {
      suppressNextPop++
      history.back()
    }
  },
  clearForRoute: (route) => {
    // 从顶层往下，只摘 route 匹配的层：每摘一个先补弹其假条目（若仍在栈顶）再调 onClose。
    // 顺序无关紧要，关键是都清掉且不残留假条目。
    for (let i = layers.length - 1; i >= 0; i--) {
      const l = layers[i]
      if (l.route !== route) continue
      layers.splice(i, 1)
      if (topIsOwnLayer(l.key)) {
        suppressNextPop++
        history.back()
      }
      l.onClose()
    }
  },
}))
