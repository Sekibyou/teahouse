import { create } from "zustand"

export interface UiScalePreset {
  id: string
  /** 字号乘数 —— 落到 CSS 变量 --ui-scale / Monaco fontSize / 沙盒 font-scale */
  multiplier: number
}

export const UI_SCALE_PRESETS: UiScalePreset[] = [
  { id: "small", multiplier: 0.9 },
  { id: "normal", multiplier: 1 },
  { id: "large", multiplier: 1.15 },
  { id: "xlarge", multiplier: 1.3 },
]

export const DEFAULT_UI_SCALE_ID = "normal"

export function multiplierForScale(id: string): number {
  return UI_SCALE_PRESETS.find((p) => p.id === id)?.multiplier ?? 1
}

function applyScaleToDom(multiplier: number) {
  document.documentElement.style.setProperty("--ui-scale", String(multiplier))
}

interface UiScaleState {
  /** 档位 id（small/normal/large/xlarge），DOM 与本地态同源 */
  scaleId: string
  /** 当前档位的乘数（Monaco / 沙盒消费） */
  multiplier: number
  setScaleId: (id: string) => void
  /** 登出等场景复位到默认档并清掉 DOM 残留 */
  reset: () => void
}

export const useUiScaleStore = create<UiScaleState>()((set) => ({
  scaleId: DEFAULT_UI_SCALE_ID,
  multiplier: 1,
  setScaleId: (id) => {
    const multiplier = multiplierForScale(id)
    applyScaleToDom(multiplier)
    set({ scaleId: id, multiplier })
  },
  reset: () => {
    applyScaleToDom(1)
    set({ scaleId: DEFAULT_UI_SCALE_ID, multiplier: 1 })
  },
}))
