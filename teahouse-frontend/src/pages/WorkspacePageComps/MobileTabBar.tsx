import { useTranslation } from "react-i18next"
import { Home, Files, MessageCircle } from "lucide-react"
import { cn } from "@/lib/utils"
import { useMobileLayoutStore, type MobileTab } from "@/stores/mobileLayoutStore"

const TABS: { key: MobileTab; icon: typeof Home; labelKey: string }[] = [
  { key: "home", icon: Home, labelKey: "mobileHomeTab" },
  { key: "files", icon: Files, labelKey: "mobileFilesTab" },
  { key: "director", icon: MessageCircle, labelKey: "mobileDirectorTab" },
]

/** 移动端实例外层的 QQ 式底部三 Tab 常驻栏：首页 / 文件 / 导演。 */
export function MobileTabBar() {
  const { t } = useTranslation("workspace")
  const mobileTab = useMobileLayoutStore((s) => s.mobileTab)
  const setMobileTab = useMobileLayoutStore((s) => s.setMobileTab)

  return (
    <nav className="shrink-0 border-t border-border bg-background flex pb-safe">
      {TABS.map(({ key, icon: Icon, labelKey }) => {
        const active = mobileTab === key
        return (
          <button
            key={key}
            className={cn(
              "flex-1 flex flex-col items-center justify-center gap-0.5 h-14 active:bg-muted transition-colors",
              active ? "text-primary" : "text-muted-foreground"
            )}
            onClick={() => setMobileTab(key)}
            aria-current={active ? "page" : undefined}
          >
            <Icon className="h-5 w-5" />
            <span className="text-[10px] leading-none">{t(labelKey)}</span>
          </button>
        )
      })}
    </nav>
  )
}
