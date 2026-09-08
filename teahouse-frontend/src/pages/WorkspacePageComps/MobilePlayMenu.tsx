import { useTranslation } from "react-i18next"
import { GitBranch, Moon, Sun, X } from "lucide-react"

interface MobilePlayMenuProps {
  isDark: boolean
  onExitPlay: () => void
  onOpenGit: () => void
  onToggleTheme: () => void
  onClose: () => void
}

/** 游玩层悬浮球的极简菜单：退出游玩 / 版本控制 / 主题切换。 */
export function MobilePlayMenu({ isDark, onExitPlay, onOpenGit, onToggleTheme, onClose }: MobilePlayMenuProps) {
  const { t } = useTranslation("workspace")
  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div className="absolute right-0 top-full mt-1 z-50 bg-background border border-border rounded-md shadow-lg py-1 min-w-[160px]">
        <button className="w-full flex items-center gap-2 px-3 py-2.5 text-sm hover:bg-muted" onClick={onExitPlay}>
          <X className="h-4 w-4" />
          {t("homePlayExit")}
        </button>
        <button className="w-full flex items-center gap-2 px-3 py-2.5 text-sm hover:bg-muted" onClick={onOpenGit}>
          <GitBranch className="h-4 w-4" />
          {t("versionControl")}
        </button>
        <button className="w-full flex items-center gap-2 px-3 py-2.5 text-sm hover:bg-muted" onClick={onToggleTheme}>
          {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          {t("themeToggle")}
        </button>
      </div>
    </>
  )
}
