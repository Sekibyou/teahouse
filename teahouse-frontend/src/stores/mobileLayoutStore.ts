import { create } from "zustand"
import { persist } from "zustand/middleware"

export type MobileTab = "home" | "files" | "director"

interface MobileLayoutState {
  /** 外层三 tab：当前激活 tab */
  mobileTab: MobileTab
  setMobileTab: (tab: MobileTab) => void
  /** 是否展开独立全屏游玩层（离开外层三 tab UI） */
  inPlay: boolean
  enterPlay: () => void
  exitPlay: () => void
}

/**
 * 移动端实例内的两层导航状态：
 * - 外层 = QQ 式底部三 tab（home / files / director），memo 上次激活 tab（persist）。
 * - inPlay = 独立全屏游玩层展开（不持久化——进实例默认回外层首页）。
 *
 * 与桌面端 play/backstage(mode) 完全解耦：MainLayout 移动分支不读 mode，
 * 此处三态互斥、覆盖移动端全部外层可见态。
 */
export const useMobileLayoutStore = create<MobileLayoutState>()(
  persist(
    (set) => ({
      mobileTab: "home",
      setMobileTab: (tab) => set({ mobileTab: tab }),
      inPlay: false,
      enterPlay: () => set({ inPlay: true }),
      exitPlay: () => set({ inPlay: false }),
    }),
    {
      name: "teahouse-mobile-layout",
      partialize: (state) => ({
        mobileTab: state.mobileTab,
      }),
    }
  )
)
