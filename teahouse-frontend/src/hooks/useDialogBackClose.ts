import { useEffect, useRef } from "react"
import { dialogStackStore } from "@/stores/dialogStackStore"

/**
 * 让一个全屏弹窗/抽屉响应系统的返回键信号（物理返回键 / 手势 / 全面屏扫动）。
 *
 * 语义已收口到 `dialogStackStore`（见该文件注释）：本 hook 是其 React 薄封装，仅负责
 * 把"open 时压语义层、卸载/close 时移除"与组件生命周期绑定。
 *
 * @param open   弹窗是否打开。
 * @param onClose 系统返回要关本弹窗时应执行的动作（播动画后真正改组件 state）。
 * @param opts   可选语义：
 *   - route：本弹窗盖在哪个真实路由页之上（"/" 大厅 / "/workspace"）。传了它，导航离开该页前
 *     `dialogStackStore.clearForRoute(route)` 才能把它连同其假条目一起清掉，杜绝孤儿。
 *     不传 = route "*"，不参与路由清理（向后兼容旧调用点）。
 *   - kind/name：语义标签，便于调试与后续复用。
 */
export function useDialogBackClose(
  open: boolean,
  onClose: () => void,
  opts?: { route?: string; kind?: string; name?: string },
) {
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const keyRef = useRef<number | null>(null)

  useEffect(() => {
    if (!open) return
    const key = dialogStackStore.getState().pushLayer({
      kind: opts?.kind ?? "dialog",
      route: opts?.route ?? "*",
      name: opts?.name,
      onClose: () => onCloseRef.current(),
    })
    keyRef.current = key
    return () => {
      if (keyRef.current != null) {
        dialogStackStore.getState().removeSelf(keyRef.current)
        keyRef.current = null
      }
    }
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps
}
