import { useEffect, useRef } from "react"

/**
 * 让一个全屏弹窗响应系统的返回键信号（物理返回键 / 手势 / 全面屏扫动）。
 *
 * 机制（不改变 URL、不影响 React Router、不卸载组件）：
 * - 弹窗 open 时向浏览器 history 压入一层"假条目"（不带真实 path，Router 无感知）。
 * - 用户触发系统返回 → 浏览器 popstate → 全局单例监听器消费最顶层打开的弹窗，调用其 onClose。
 * - 弹窗本身仍由组件状态 open 控制，这里只做"返回信号 → 关弹窗"的桥接。
 *
 * 历史栈同步：
 * - 用户返回（popstate）关闭：历史栈已自动回退一层，假条目天然消费，无需补偿。
 * - 用户主动点 X 关闭：用 describe 配对的 history.back() 把假条目弹掉；期间用 suppress
 *   标记让即将到来的 popstate 被忽略，避免 Router 收到把用户再退一页。
 */
type Layer = {
  id: number
  onClose: () => void
}

const layers: Layer[] = []
let layerId = 0
let installed = false
// 主动关闭触发的 history.back() 会带来一次 popstate；用计数跳过它
let suppressNextPop = 0

const DIALOG_STATE_KEY = "__teahouseDialog"

function install() {
  if (installed) return
  installed = true
  window.addEventListener("popstate", onPopstate)
}

function onPopstate() {
  if (suppressNextPop > 0) {
    suppressNextPop--
    return
  }
  const top = layers[layers.length - 1]
  if (!top) return // 栈空 → 没有弹窗在等返回 → 放行给 Router 正常后退
  // 消费最顶层弹窗；本次 popstate 已让历史栈回退一层，假条目已消耗
  layers.pop()!
  top.onClose()
}

/** 当前历史栈顶是不是指定弹窗压的假条目（仅当正好是本层时才可安全弹掉） */
function topIsOwnLayer(id: number): boolean {
  const s = typeof history.state === "object" && history.state !== null ? history.state : {}
  return s[DIALOG_STATE_KEY] === id
}

export function useDialogBackClose(open: boolean, onClose: () => void) {
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    install()
    if (!open) return

    const id = ++layerId
    const layer: Layer = { id, onClose: () => onCloseRef.current() }
    layers.push(layer)
    history.pushState({ [DIALOG_STATE_KEY]: id }, "")

    return () => {
      const idx = layers.lastIndexOf(layer)
      if (idx >= 0) layers.splice(idx, 1)
      // 若本层压的假条目仍在历史栈顶（主动关闭，未被 back 消费），用 back 弹掉
      if (topIsOwnLayer(id)) {
        suppressNextPop++
        history.back()
      }
    }
  }, [open])
}
