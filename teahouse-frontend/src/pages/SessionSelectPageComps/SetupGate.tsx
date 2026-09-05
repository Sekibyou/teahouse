import { useEffect } from "react"
import { useSetupStatus } from "@/hooks/useSetupStatus"
import { useWizardDoneStore } from "@/stores/wizardDoneStore"
import { WelcomeWizard } from "@/components/WelcomeWizard/WelcomeWizard"

/**
 * 空实例的空态入口：当模型体系（供应商/模型/槽位）没配好时，显示 Welcome Wizard
 * 引导（不渲染「新建实例」，实现新用户拦截）；配好后再显示正常空态。
 */
export function SetupGateEmpty({ children }: { onNew: () => void; children: React.ReactNode }) {
  const { complete, loading } = useSetupStatus()
  const done = useWizardDoneStore((s) => s.done)
  const resetDone = useWizardDoneStore((s) => s.resetDone)

  // 配置回退（删了供应商/模型等）→ 清掉「已确认」标记，下次配好仍要走一遍点确定。
  // ⚠️ 必须等 loading 结束再判断：挂载初期 complete 恒为 false，若此刻就 reset，
  // 会把上次已确认的标记误清掉、导致每次进页面都重新弹向导。
  useEffect(() => {
    if (!loading && !complete) resetDone()
  }, [loading, complete, resetDone])

  // 加载中一律不渲染向导：否则加载帧 complete 恒 false，已确认用户会先看到向导一闪而过。
  if (loading) return null

  // 不再「配好即移除」：清单全绿仍停留在向导里，等用户点「完成」才放行
  if (!complete || !done) return <WelcomeWizard />
  return <>{children}</>
}
