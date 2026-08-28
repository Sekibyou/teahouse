import type { Ref } from "react"
import type { LucideIcon } from "lucide-react"

/**
 * 设置界面的"滚动锚点 section"外壳。
 * 每个设置 tab 一个 section，整张设置列表按 DOM 顺序从上到下堆叠，
 * 侧边栏据此做滚动定位与进度高亮。
 * 顶部渲染模块标题（icon + 大字 + 分界线），children 为对应的自包含 Panel。
 */
export function SettingsSection({ title, Icon, sectionRef, children }: {
  title: string
  Icon: LucideIcon
  sectionRef?: Ref<HTMLElement>
  children: React.ReactNode
}) {
  return (
    <section ref={sectionRef} className="scroll-mt-1">
      <header className="flex items-center gap-2.5 px-6 pt-6 pb-3">
        <Icon className="h-5 w-5 text-primary shrink-0" />
        <h2 className="text-base font-semibold text-foreground">{title}</h2>
      </header>
      <div className="border-b border-border" />
      {children}
    </section>
  )
}

/** 内联字段助手：label + 子控件，垂直排布 */
export function Field({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={`space-y-1 ${className || ""}`}>
      <label className="text-xs text-muted-foreground">{label}</label>
      {children}
    </div>
  )
}

/** 插件 / Skill / 提示词包三个库页共用的空状态 */
export function LibraryEmptyState({ icon: Icon, title, lines }: { icon: LucideIcon; title: string; lines: string[] }) {
  return (
    <div className="text-center text-muted-foreground py-12">
      <Icon className="h-12 w-12 mx-auto mb-3 opacity-20" />
      <p className="text-sm">{title}</p>
      <div className="mt-2 space-y-1.5 max-w-md mx-auto">
        {lines.map((line, i) => (
          <p key={i} className="text-xs opacity-60 leading-relaxed">{line}</p>
        ))}
      </div>
    </div>
  )
}
