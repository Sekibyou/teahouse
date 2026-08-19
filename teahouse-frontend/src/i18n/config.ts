import i18next from "i18next"
import { initReactI18next } from "react-i18next"
import { create } from "zustand"
import { persist } from "zustand/middleware"
import { resourceZh } from "./locales/zh"
import { resourceEn } from "./locales/en"
import { resourceJa } from "./locales/ja"

// en / ja 为第一阶段翻译适配（字典已填充）；翻译不足的 key 经 fallbackLng
// 回退中文，不会暴露 key 字符串。
export const SUPPORTED_LANGS = ["zh", "en", "ja"] as const
export type Lang = (typeof SUPPORTED_LANGS)[number]

export const DEFAULT_LANG: Lang = "zh"

// 语言选择器里显示的各语言自称（不随当前语言翻译）。
export const LANG_LABELS: Record<Lang, string> = {
  zh: "中文",
  en: "English",
  ja: "日本語",
}

const LANG_STORAGE_KEY = "teahouse-lang"

interface LangState {
  lang: Lang
  setLang: (l: Lang) => void
}

/**
 * 语言偏好 store。持久化到 localStorage（teahouse-lang），与 i18next 双向联动：
 * setLang 同时 changeLanguage；启动时由 initI18n 读取一次同步 i18next。
 */
export const useLangStore = create<LangState>()(
  persist(
    (set) => ({
      lang: DEFAULT_LANG,
      setLang: (l) => {
        void i18next.changeLanguage(l)
        set({ lang: l })
      },
    }),
    { name: LANG_STORAGE_KEY }
  )
)

// Convenience hooks
export function useCurrentLang(): Lang {
  return useLangStore((s) => s.lang)
}

export function getStoredLang(): Lang {
  return useLangStore.getState().lang
}

// 直接使用 i18next 全局单例（而非 createInstance）：
// react-i18next 的 useTranslation()（不带 i18n 参数）和代码内经
// import i18n from "@/i18n/config" 的 i18n.t() 都指向同一个已初始化的
// 实例，保证 hook 组件与 class/模块函数在切换语言时同步变更。
const instance = i18next

// 必须 use(initReactI18next)，否则 React 里的 useTranslation hook 拿不到
// 有效实例，t() 会原样返回 key 而不是取资源翻译。
instance.use(initReactI18next)

export async function initI18n(): Promise<typeof instance> {
  // 初始语言以 useLangStore（persist 反水合后）为准，而非裸读 localStorage——
  // 裸读拿到的是 zustand persist 的 JSON 包装串，读不出真正的语言值，
  // 会导致切到 en 后刷新又回到默认值。
  const initialLang: Lang = getStoredLang() && SUPPORTED_LANGS.includes(getStoredLang())
    ? getStoredLang()
    : DEFAULT_LANG

  await instance.init({
    resources: {
      // resourceZh / resourceEn / resourceJa 是命名空间映射：{ [namespace]: {...} }
      // 组件统一 useTranslation("<namespace>")，如 useTranslation("chat")。
      zh: resourceZh,
      en: resourceEn,
      ja: resourceJa,
    },
    lng: initialLang,
    // fallbackLng: "zh" —— en 缺失的 key 回退中文而不是暴露 key 字符串，
    // 保证切换英文时界面仍可读（翻译补齐前以中文兜底）。
    fallbackLng: "zh",
    interpolation: { escapeValue: false },
  })
  return instance
}

export default instance
