import { create } from "zustand"

function applyThemeClass(dark: boolean) {
  document.documentElement.classList.toggle("dark", dark)
}

interface ThemeState {
  isDark: boolean
  setTheme: (dark: boolean) => void
  toggleTheme: () => void
}

// 初始值从 localStorage 读，默认 dark；切主题时同步 DOM class + localStorage
function initDark(): boolean {
  const saved = localStorage.getItem("theme")
  const dark = saved ? saved === "dark" : true
  applyThemeClass(dark)
  return dark
}

export const useThemeStore = create<ThemeState>()((set, get) => ({
  isDark: initDark(),
  setTheme: (dark) => {
    applyThemeClass(dark)
    localStorage.setItem("theme", dark ? "dark" : "light")
    set({ isDark: dark })
  },
  toggleTheme: () => get().setTheme(!get().isDark),
}))
