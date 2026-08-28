import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select"
import { Languages } from "lucide-react"
import { cn } from "@/lib/utils"
import { SUPPORTED_LANGS, LANG_LABELS, type Lang } from "@/i18n/config"
import { useCurrentLang, useLangStore } from "@/i18n/config"

interface LangSwitcherProps {
  className?: string
}

/** 全局语言切换入口：Languages 图标按钮（如同主题切换按钮，不显示当前语言文案）+ 下拉。 */
export function LangSwitcher({ className }: LangSwitcherProps) {
  const currentLang = useCurrentLang()
  const setLang = useLangStore((s) => s.setLang)
  return (
    <Select value={currentLang} onValueChange={(v) => setLang(v as Lang)}>
      <SelectTrigger
        aria-label="Switch language"
        className={cn(
          "w-8 px-0 justify-center hover:bg-accent hover:text-accent-foreground data-[state=open]:bg-accent",
          className,
        )}
      >
        <Languages className="h-4 w-4" />
      </SelectTrigger>
      <SelectContent>
        {SUPPORTED_LANGS.map((l) => (
          <SelectItem key={l} value={l}>
            {LANG_LABELS[l]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
