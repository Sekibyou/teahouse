import { useEffect, useRef, useState, useCallback } from "react"
import { useTranslation } from "react-i18next"
import { Cpu, X, ChevronLeft, Check } from "lucide-react"
import { useSettingsDialogStore } from "@/stores/settingsDialogStore"
import { useIsMobile } from "@/hooks/useMediaQuery"
import { useDialogBackClose } from "@/hooks/useDialogBackClose"
import { useAuth, isAdminRole } from "@/stores/authStore"
import { SettingsSection } from "@/components/SettingsDialogComps/SettingsSection"
import { TAB_ITEMS } from "@/components/SettingsDialogComps/types"
import type { TabKey } from "@/components/SettingsDialogComps/types"
import { ModelsPanel } from "@/components/SettingsDialogComps/ModelsPanel"
import { ProfilesPanel } from "@/components/SettingsDialogComps/ProfilesPanel"
import { PresetsPanel } from "@/components/SettingsDialogComps/PresetsPanel"
import { SlotsPanel } from "@/components/SettingsDialogComps/SlotsPanel"
import { GeneralPanel } from "@/components/SettingsDialogComps/GeneralPanel"
import { PluginsPanel } from "@/components/SettingsDialogComps/PluginsPanel"
import { SkillsPanel } from "@/components/SettingsDialogComps/SkillsPanel"
import { PackagesPanel } from "@/components/SettingsDialogComps/PackagesPanel"
import { UsersPanel } from "@/components/SettingsDialogComps/UsersPanel"

interface SettingsDialogProps {
  open?: boolean
  onClose?: () => void
  defaultTab?: TabKey
}

export function SettingsDialog({ open: openProp, onClose: onCloseProp, defaultTab: defaultTabProp }: SettingsDialogProps) {
  const storeOpen = useSettingsDialogStore((s) => s.open)
  const storeDefaultTab = useSettingsDialogStore((s) => s.defaultTab)
  const closeSettings = useSettingsDialogStore((s) => s.closeSettings)

  const open = openProp ?? storeOpen
  const onClose = onCloseProp ?? closeSettings
  const defaultTab = (defaultTabProp ?? storeDefaultTab) as TabKey | undefined

  const { t } = useTranslation("settings")
  const isMobile = useIsMobile()
  useDialogBackClose(open, onClose)

  const { user: currentUser } = useAuth()
  const visibleTabs = TAB_ITEMS.filter((item) => !item.adminOnly || isAdminRole(currentUser?.role))

  const [tabMenuOpen, setTabMenuOpen] = useState(false)
  const [activeSection, setActiveSection] = useState<TabKey>("general")

  // 右侧滚动容器 + 各 section 锚点 ref
  const scrollRef = useRef<HTMLDivElement>(null)
  const sectionRefs = useRef<Partial<Record<TabKey, HTMLElement | null>>>({})

  // 高亮跟随策略：
  // - 点击定位（侧边栏/菜单/defaultTab）：立即高亮点击项（即时反馈）。
  // - 手动滚动：滚动事件只触发「去抖重算」，滚动停止 ~150ms 后才按进度算高亮。
  //   这样平滑滚动期间永不重算（不会因位置经过中间 section 而闪高亮），停稳后再算；
  //   点击定位停稳后重算结果与点击项一致，二者不竞争。
  const activeSectionRef = useRef<TabKey>("general")
  const scrollDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 越顶判定的容差（px）：scrollIntoView({ block:"start" }) 受 section 的 scroll-mt-1(4px) 影响，
  // 目标 section 顶部会落在容器顶下方 4px 处，加上亚像素取整，不能拿「==容器顶」当越顶边界，
  // 否则目标 section 刚定位到位时会被误判为未越过（显示上一项）。取略大于 4px 的值。
  const CROSS_TOP_TOLERANCE = 8

  const computeActiveByScroll = useCallback(() => {
    const container = scrollRef.current
    if (!container) return
    const rect = container.getBoundingClientRect()
    const containerTop = rect.top

    // 兜底：滚到底时选中最后一个可见 section（其顶部未必能过容器顶，如较矮的提示词包/用户管理）
    if (container.scrollTop + container.clientHeight >= container.scrollHeight - 1) {
      activeSectionRef.current = visibleTabs[visibleTabs.length - 1].key
    } else {
      let current: TabKey = visibleTabs[0].key
      for (const item of visibleTabs) {
        const el = sectionRefs.current[item.key]
        if (el && el.getBoundingClientRect().top <= containerTop + CROSS_TOP_TOLERANCE) current = item.key
      }
      activeSectionRef.current = current
    }
    setActiveSection(activeSectionRef.current)
  }, [visibleTabs])

  const scrollToSection = useCallback((key: TabKey) => {
    const el = sectionRefs.current[key]
    if (!el) return
    // 点击定位：立即高亮点击项
    activeSectionRef.current = key
    setActiveSection(key)
    // 取消进行中的去抖，避免平滑滚动停稳前触发重算
    if (scrollDebounceRef.current) clearTimeout(scrollDebounceRef.current)
    scrollDebounceRef.current = null
    el.scrollIntoView({ behavior: "smooth", block: "start" })
  }, [])

  // 手动滚动：去抖重算高亮（滚动停止 150ms 后）
  const handleScroll = useCallback(() => {
    if (scrollDebounceRef.current) clearTimeout(scrollDebounceRef.current)
    scrollDebounceRef.current = setTimeout(() => {
      computeActiveByScroll()
    }, 150)
  }, [computeActiveByScroll])

  useEffect(() => () => {
    if (scrollDebounceRef.current) clearTimeout(scrollDebounceRef.current)
  }, [])

  // 打开时：若指定了 defaultTab，滚动到对应 section（scrollToSection 会即时高亮目标）
  useEffect(() => {
    if (open) {
      const target = defaultTab || "general"
      setTabMenuOpen(false)
      // 等一帧让 section 挂载后再滚动
      requestAnimationFrame(() => scrollToSection(target))
    }
  }, [open, defaultTab, scrollToSection])

  if (!open) return null

  // 各模块内容组件，按顺序堆叠为整张长列表；图标/标题复用侧边栏的 TAB_ITEMS
  const SECTIONS: { key: TabKey; Panel: () => React.JSX.Element }[] = [
    { key: "general", Panel: GeneralPanel },
    { key: "models", Panel: ModelsPanel },
    { key: "slots", Panel: SlotsPanel },
    { key: "profiles", Panel: ProfilesPanel },
    { key: "presets", Panel: PresetsPanel },
    { key: "plugins", Panel: PluginsPanel },
    { key: "skills", Panel: SkillsPanel },
    { key: "packages", Panel: PackagesPanel },
    { key: "users", Panel: UsersPanel },
  ]
  const sectionMeta = (key: TabKey) => visibleTabs.find((item) => item.key === key)!
  const visibleKeys = new Set(visibleTabs.map((item) => item.key))
  const visibleSections = SECTIONS.filter((s) => visibleKeys.has(s.key))

  return (
    <>
      <div
        className={`fixed inset-0 z-50 ${isMobile ? "bg-background" : "bg-black/50 backdrop-blur-sm flex items-center justify-center"}`}
        onClick={onClose}
      >
        <div
          className={`flex flex-col overflow-hidden ${isMobile
            ? "h-full w-full"
            : "bg-card border border-border rounded-xl shadow-2xl"
          }`}
          style={
            isMobile
              ? undefined
              : { width: "min(92vw, 1100px)", height: "min(88vh, 760px)", maxWidth: 1100, maxHeight: 760 }
          }
          onClick={e => e.stopPropagation()}
        >
          {/* Header */}
          {isMobile ? (
            <div className="relative h-10 border-b border-border flex items-center justify-center shrink-0 z-10">
              <button
                className="absolute left-2 p-2 rounded hover:bg-muted flex items-center justify-center"
                onClick={onClose}
                aria-label={t("common:back")}
              >
                <ChevronLeft className="h-5 w-5" />
              </button>
              <span className="font-semibold text-sm">{t("title")}</span>
              {/* Right: tab dropdown — 点击只滚动到对应 section */}
              <div className="absolute right-1">
                <button
                  className="p-2 rounded hover:bg-muted flex items-center gap-1 text-sm"
                  onClick={() => setTabMenuOpen((v) => !v)}
                  aria-label={t("ariaSwitchTab")}
                >
                  {(() => { const cur = visibleTabs.find((item) => item.key === activeSection); return cur ? <cur.Icon className="h-4 w-4" /> : null })()}
                </button>
                {tabMenuOpen && (
                  <>
                    <div className="fixed inset-0 z-40" onClick={() => setTabMenuOpen(false)} />
                    <div className="absolute right-1 top-full mt-1 z-50 bg-background border border-border rounded-md shadow-lg py-1 min-w-[150px] max-h-[70vh] overflow-auto">
                      {visibleTabs.map(({ key, Icon, label }) => (
                        <button
                          key={key}
                          className={`w-full flex items-center gap-2 px-3 py-2.5 text-sm text-left hover:bg-muted ${
                            activeSection === key ? "text-primary font-medium" : "text-foreground"
                          }`}
                          onClick={() => { scrollToSection(key); setTabMenuOpen(false) }}
                        >
                          <Icon className="h-4 w-4 shrink-0" />
                          <span className="flex-1">{t(label)}</span>
                          {activeSection === key && <Check className="h-4 w-4 shrink-0" />}
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-between px-6 py-3 border-b border-border shrink-0">
              <div className="flex items-center gap-2">
                <Cpu className="h-4 w-4 text-primary" />
                <span className="font-semibold">{t("title")}</span>
              </div>
              <button className="p-1 rounded hover:bg-muted" onClick={onClose}>
                <X className="h-4 w-4" />
              </button>
            </div>
          )}

          {/* Body: sidebar + content */}
          <div className="flex flex-1 overflow-hidden">
            {/* Left sidebar (desktop only) — 滚动进度指示 + 点击跳转 */}
            {!isMobile && (
              <div className="w-44 shrink-0 border-r border-border flex flex-col bg-muted/10">
                <div className="flex flex-col gap-0.5 p-2">
                  {visibleTabs.map(({ key, Icon, label }) => (
                    <button
                      key={key}
                      className={`flex items-center gap-2 px-3 py-2.5 text-xs rounded-md transition-colors text-left whitespace-nowrap ${
                        activeSection === key ? "bg-accent text-accent-foreground font-medium" : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
                      }`}
                      onClick={() => scrollToSection(key)}
                    >
                      <Icon className="h-4 w-4 shrink-0" />
                      {t(label)}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Right content: 一整张纵向滚动的设置列表 */}
            <div
              ref={scrollRef}
              onScroll={handleScroll}
              className="flex-1 overflow-y-auto"
            >
              {visibleSections.map(({ key, Panel }) => {
                const meta = sectionMeta(key)
                return (
                  <SettingsSection
                    key={key}
                    title={t(meta.label)}
                    Icon={meta.Icon}
                    sectionRef={(el) => { sectionRefs.current[key] = el }}
                  >
                    <Panel />
                  </SettingsSection>
                )
              })}
            </div>
          </div>
        </div>
      </div>
    </>
  )
}
