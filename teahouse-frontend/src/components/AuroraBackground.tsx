import { motion, useReducedMotion } from "motion/react"
import { AURORA_DRIFT } from "@/lib/animations"

/**
 * 主页背景：暗色为静态墨绿渐变 + 颗粒纹理；light 模式为纸张质感（暖白基底 + 细纤维噪点）。
 * 两层径向光斑（暗色光晕 / 亮色高光）带 18s 慢速漂移，给背景一丝呼吸感但不扰人。
 * 尊重 prefers-reduced-motion：降级为纯静态。
 */

const NOISE_URL =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='240' height='240'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/%3E%3CfeColorMatrix type='saturate' values='0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")"

export function AuroraBackground({ className = "" }: { className?: string }) {
  const reduced = useReducedMotion()
  return (
    <div
      aria-hidden
      className={`pointer-events-none absolute inset-0 -z-10 overflow-hidden ${className}`}
    >
      {/* ============ 暗色：墨绿山雾 ============ */}
      {/* 基底墨绿渐变：左上深 → 右下略浅带暖，长过渡不分层 */}
      <div
        className="absolute inset-0 hidden dark:block"
        style={{
          background:
            "linear-gradient(160deg, oklch(0.105 0.028 158) 0%, oklch(0.09 0.024 158) 48%, oklch(0.15 0.03 152) 100%)",
        }}
      />
      {/* 柔和透光晕染：慢速漂移 */}
      <motion.div
        className="absolute inset-0 hidden dark:block"
        style={{
          background:
            "radial-gradient(120% 90% at 82% 8%, oklch(0.22 0.038 150 / 0.22), transparent 70%)",
        }}
        initial={false}
        animate={reduced ? undefined : { x: [0, 40, 0], y: [0, 18, 0] }}
        transition={AURORA_DRIFT}
      />
      {/* 暗色颗粒纹理 */}
      <div
        className="absolute inset-0 hidden dark:block"
        style={{ backgroundImage: NOISE_URL, opacity: 0.035 }}
      />

      {/* ============ Light：纸张质感 ============ */}
      {/* 暖白纸面基底：左上略亮（受光），右下略暖偏黄 */}
      <div
        className="absolute inset-0 dark:hidden"
        style={{
          background:
            "linear-gradient(135deg, oklch(0.985 0.008 88) 0%, oklch(0.965 0.012 92) 55%, oklch(0.945 0.016 90) 100%)",
        }}
      />
      {/* 纸张纤维噪点：横向细丝 + 细颗粒双层叠加，突出纸面纤维质感 */}
      <div
        className="absolute inset-0 dark:hidden"
        style={{
          backgroundImage: NOISE_URL,
          opacity: 0.08,
        }}
      />
      {/* 横向纤维丝：x/y 频率不对称拉出细长纤维，read 起来更像纸张肌理 */}
      <div
        className="absolute inset-0 dark:hidden"
        style={{
          backgroundImage:
            "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='300' height='300'%3E%3Cfilter id='f'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.015 0.45' numOctaves='2' stitchTiles='stitch'/%3E%3CfeColorMatrix type='saturate' values='0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23f)'/%3E%3C/svg%3E\")",
          opacity: 0.12,
        }}
      />
      {/* 顶部受光边缘：极淡高光让纸面有厚度，缓慢漂移 */}
      <motion.div
        className="absolute inset-0 dark:hidden"
        style={{
          background:
            "radial-gradient(70% 40% at 50% 0%, oklch(1 0 0 / 0.35), transparent 70%)",
        }}
        initial={false}
        animate={reduced ? undefined : { x: [0, -30, 0], y: [0, 14, 0] }}
        transition={AURORA_DRIFT}
      />
    </div>
  )
}
