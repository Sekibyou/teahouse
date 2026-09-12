import { create } from "zustand"

/**
 * 是否显示每轮额外信息（token 计数 / 耗时 / 缓存命中率）。
 *
 * 后端偏好 `show_extra_info` 是权威值，由 MainLayout 在登录后灌入；
 * 这里只作为跨组件的读取点——气泡渲染在 ChatPanel 深处，不便层层传 prop。
 */
interface ExtraInfoState {
  show: boolean
  setShow: (show: boolean) => void
  /** 登出等场景复位，避免上一账号的偏好残留到下一账号 */
  reset: () => void
}

export const DEFAULT_SHOW_EXTRA_INFO = true

export const useExtraInfoStore = create<ExtraInfoState>()((set) => ({
  show: DEFAULT_SHOW_EXTRA_INFO,
  setShow: (show) => set({ show }),
  reset: () => set({ show: DEFAULT_SHOW_EXTRA_INFO }),
}))
