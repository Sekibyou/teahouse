import type { Variants, Transition } from "motion/react"

/**
 * 大厅/书架共享的动画原语。
 *
 * 规则：
 * - 微动效只用 transform/opacity（不动 layout 属性，避免重排/掉帧）。
 * - 所有 `duration` 落在 150–300ms 的微交互区间，进出不超过 240ms。
 * - 一律尊重 `prefers-reduced-motion`：关闭时退化为无动画（组件各自用
 *   `useReducedMotion()` 决定是否挂 variants）。
 */

/** 瀑布卡片 stagger 容器：子项各错开一点依次入场。 */
export const STAGGER_CONTAINER: Variants = {
  hidden: {},
  show: {
    transition: { staggerChildren: 0.07, delayChildren: 0.05 },
  },
}

/** 瀑布单卡片：从下方浮现 + 上浮。opacity 与 y 同一时长/缓动，完全同步 */
export const CARD_UP: Variants = {
  hidden: { opacity: 0, y: 28 },
  show: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.5, ease: [0.22, 1, 0.36, 1], delay: 0.03 },
  },
}

/** 对话框外壳：淡入 + 轻微放大 + 由下而上（桌面）或由右向左（移动）入场。 */
export function dialogShell(overlay: "desktop" | "mobile"): Variants {
  const x = overlay === "mobile" ? 40 : 0
  return {
    hidden: { opacity: 0, x, y: 16, scale: 0.98 },
    show: {
      opacity: 1,
      x: 0,
      y: 0,
      scale: 1,
      transition: { type: "spring", damping: 26, stiffness: 380, mass: 0.8 },
    },
    exit: {
      opacity: 0,
      x,
      y: 10,
      scale: 0.99,
      transition: { duration: 0.16, ease: "easeIn" },
    },
  }
}

/** 覆盖层遮罩：纯淡入/淡出。 */
export const BACKDROP_FADE: Variants = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { duration: 0.2 } },
  exit: { opacity: 0, transition: { duration: 0.15 } },
}

/** Aurora 光斑缓慢漂移，让背景有呼吸感但不扰人。 */
export const AURORA_DRIFT: Transition = {
  duration: 18,
  ease: "easeInOut",
  repeat: Infinity,
  repeatType: "reverse",
}
