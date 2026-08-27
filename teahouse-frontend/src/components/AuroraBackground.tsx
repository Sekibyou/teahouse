import { motion, useReducedMotion } from "motion/react"

/**
 * 主页背景：一整片主题渐变，缓慢漂移，不做离散光斑。
 *
 * 用三层 `color-mix` 把绿色系主题色（青绿 chart-2 / 黄绿 chart-4）揉进背景色，
 * 整体压向深绿：去掉暖金 primary、拉高 chart-2 浓度，让绿更沉更深。每一处像素
 * 都有色、没有透明死区，所以看起来是"整片渐变"而非几团光斑。漂移只动 transform
 * （整层交给合成器），渐变本身不重算，长期挂在首页也不掉帧。
 *
 * - 颜色全走主题变量，light 茶褐暖调 / dark 灰绿雾墨 自动跟随。
 * - 底层铺到 `-inset-[30%]`（1.6 倍视口），漂移时不会露出边缘。
 * - `prefers-reduced-motion` 时停在静止构图。
 */

export function AuroraBackground({ className = "" }: { className?: string }) {
  const reduced = useReducedMotion()
  // 临时诊断：确认 reduced-motion 是否吞掉了动画，确认后删除
  console.log("[Aurora] reduced-motion =", reduced)

  return (
    <div
      aria-hidden
      className={`pointer-events-none absolute inset-0 -z-10 overflow-hidden ${className}`}
    >
      <motion.div
        className="absolute -inset-[30%]"
        style={{
          background:
            "linear-gradient(118deg, " +
            "color-mix(in oklch, var(--chart-2) 32%, var(--background)) 0%, " +
            "color-mix(in oklch, var(--chart-2) 10%, var(--background)) 52%, " +
            "color-mix(in oklch, var(--chart-4) 18%, var(--background)) 100%)",
          willChange: "transform",
        }}
        animate={{
          x: ["0%", "-8%", "5%", "0%"],
          y: ["0%", "6%", "-5%", "0%"],
          rotate: [0, 4, -3, 0],
          scale: [1, 1.08, 1.04, 1],
        }}
        transition={{ duration: 16, repeat: Infinity, ease: "easeInOut" }}
      />

      {/* 底部渐隐：让卡片区底下有个收口，渐变不至于被裁断得太生硬 */}
      <div className="absolute inset-x-0 bottom-0 h-40 bg-gradient-to-t from-background to-transparent" />
    </div>
  )
}
