import { create } from "zustand"

/**
 * 语义层栈 store —— 收口全应用"全屏弹层 / 抽屉 / 面板"对系统返回键（物理返回 / 手势 / 扫动）的响应。
 *
 * 托管(managed)模式背景：
 * /workspace 移动端有退出实例确认（useBlocker）。若该页浮层仍走"压裸假 history 条目"的 legacy 方式，
 * 浮层被 React state 关闭时 cleanup 会 history.back() 弹假条目，这条 POP 会与刚重新武装的 useBlocker 互踩，
 * 把"关浮层"误判成"离开实例"→ 闪退出确认 + remount（react-router 对非 router 创建的 POP 有专警告）。
 *
 * 因此托管区里的浮层改为"只登记内存栈、不压假条目"（managed=true）；该页的单一 useBlocker 收到系统返回后
 * 调用 `closeTopManaged()`（弹内存栈顶 onClose）+ reset，空闲时再走退出确认。浏览器 history 在托管页 100%
 * 归 router。桌面 / 其它路由页无托管区 → 全部走 legacy 假条目，行为不变。
 *
 * 物理承载（legacy 层）：每条 = 一个 `history.pushState({[STATE_KEY]: key})` 假条目。系统返回（popstate）时弹
 * 栈顶语义层、调其 onClose。主动关闭（点 X / 点遮罩）由组件调 `removeSelf`，内部用 `history.back()` 弹掉自己的
 * 假条目并用 suppress 标记吞掉那一下 popstate，避免 Router 收到后退。
 */
export interface DialogLayer {
  key: number
  kind: string
  route: string // 真实路由 path("/" 大厅 / "/workspace")——clearForRoute 的清理依据
  name?: string
  onClose: () => void
  /** 托管层：只登记内存栈、不压假条目，系统返回交给页面 useBlocker 处理。 */
  managed?: boolean
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
  // 托管层在栈顶：它的系统返回由页面 useBlocker 消费（closeTopManaged），此处不自动弹、让位。
  // 仅当栈顶是 legacy 层（真压了假条目，浏览器已 POP 到它上面）才由本监听消费掉。
  if (top.managed) return
  layers.pop()!
  top.onClose()
}

function install() {
  if (installed) return
  installed = true
  window.addEventListener("popstate", popLayerOnBack)
}

interface DialogStackState {
  /** 压一层。托管区经 managed=true 只登记内存栈；否则附带一条 history 假条目承载。返回该层 key。 */
  pushLayer: (layer: Omit<DialogLayer, "key">) => number
  /** 弹出最顶层并调其 onClose（= 一次系统返回的效果）。 */
  popTop: () => void
  /** 移除指定层。managed 层仅从栈摘除（无假条目、不 back）；legacy 层补弹假条目（主动关闭用）。 */
  removeSelf: (key: number) => void
  /** 关闭并摘掉所有挂在某真实路由页(route)上的层，按 LIFO 一个个调 onClose + 补弹假条目。
      managed 层没压假条目，只摘除不补弹。在"导航离开该真实路由页"前调用，预防孤儿假条目残留。 */
  clearForRoute: (route: string) => void
  /** 托管区顶部是否有（托管）层：有则系统返回应先关它，由页面 useBlocker 决定 closeTopManaged。 */
  peekTopManaged: () => DialogLayer | null
  /** 弹掉托管栈顶并调其 onClose（页面 useBlocker 拦到返回时，若栈顶是浮层则调用它关一层）。 */
  closeTopManaged: () => void
}

/** 内部非响应式状态接口：这些层驱动命令式返回关闭（非 React 渲染），故仅暴露命令式动作。 */
export const dialogStackStore = create<DialogStackState>()(() => ({
  pushLayer: (layer) => {
    install()
    const key = ++layerSeq
    layers.push({ key, ...layer })
    if (!layer.managed) {
      history.pushState({ [STATE_KEY]: key }, "")
    }
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
    const wasManaged = layers[idx].managed === true
    layers.splice(idx, 1)
    if (wasManaged) return // 无假条目可弹，也无需 suppress
    // 只有该层压的假条目仍在栈顶时才可安全补弹；否则说明已被系统返回消费/路由切走，不再补
    if (topIsOwnLayer(key)) {
      suppressNextPop++
      history.back()
    }
  },
  clearForRoute: (route) => {
    // 从顶层往下，只摘 route 匹配的层：每摘一个先补弹其假条目（若仍在栈顶）再调 onClose。
    for (let i = layers.length - 1; i >= 0; i--) {
      const l = layers[i]
      if (l.route !== route) continue
      layers.splice(i, 1)
      if (l.managed) {
        l.onClose()
        continue
      }
      if (topIsOwnLayer(l.key)) {
        suppressNextPop++
        history.back()
      }
      l.onClose()
    }
  },
  peekTopManaged: () => {
    for (let i = layers.length - 1; i >= 0; i--) {
      const l = layers[i]
      if (l.managed) return l
    }
    return null
  },
  closeTopManaged: () => {
    for (let i = layers.length - 1; i >= 0; i--) {
      const l = layers[i]
      if (l.managed) {
        layers.splice(i, 1)
        l.onClose()
        return
      }
    }
  },
}))
