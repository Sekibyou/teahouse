import { useTranslation } from "react-i18next"
import { motion, useReducedMotion } from "motion/react"
import { Play, Hash, Clock, Plus, BookOpen } from "lucide-react"
import { CoverWithFetch } from "@/components/Cover"
import { formatDateShort } from "./formatDateShort"
import { SetupGateEmpty } from "./SetupGate"
import type { Instance } from "@/lib/types"

// ============================================================================
// Desktop main — instance-centric waterfall (global top bar lives in MainLayout)
// ============================================================================
export function DesktopMain({
  instances, onOpenInstance, onQuickStart, onNew,
}: {
  instances: Instance[]
  onOpenInstance: (i: Instance) => void
  onQuickStart: (i: Instance) => void
  onNew: () => void
}) {
  return (
    <div className="h-full flex flex-col overflow-hidden">
      <div className="flex-1 overflow-y-auto min-h-0">
        {instances.length === 0 ? (
          <SetupGateEmpty onNew={onNew}>
            <DesktopEmptyState onNew={onNew} />
          </SetupGateEmpty>
        ) : (
          <div className="p-8 pt-6">
            <InstanceWaterfall instances={instances} onOpenInstance={onOpenInstance} onQuickStart={onQuickStart} onNew={onNew} />
          </div>
        )}
      </div>
    </div>
  )
}

function DesktopEmptyState({ onNew }: { onNew: () => void }) {
  const { t } = useTranslation("session")
  return (
    <div className="h-full flex flex-col items-center justify-center text-center gap-4 py-24">
      <div className="text-muted-foreground">
        <BookOpen className="h-12 w-12 mx-auto mb-4 opacity-40" />
        <p className="text-sm mb-1">{t("empty.title")}</p>
        <p className="text-xs text-muted-foreground/80">{t("empty.desc")}</p>
      </div>
      <button
        onClick={onNew}
        className="inline-flex items-center justify-center gap-2 h-10 px-4 rounded-xl border-2 border-dashed border-border text-muted-foreground hover:border-primary hover:text-primary transition-colors"
      >
        <Plus className="h-4 w-4" />
        {t("newInstance")}
      </button>
    </div>
  )
}

// ============================================================================
// Instance waterfall (masonry) — image-led cards + a leading "new instance" card
// ============================================================================
function InstanceWaterfall({
  instances, onOpenInstance, onQuickStart, onNew,
}: {
  instances: Instance[]
  onOpenInstance: (i: Instance) => void
  onQuickStart: (i: Instance) => void
  onNew: () => void
}) {
  const reduced = useReducedMotion()
  return (
    <motion.div
      className="columns-2 lg:columns-3 xl:columns-4 2xl:columns-5 gap-6"
      initial={reduced ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
    >
      <NewInstanceCard onNew={onNew} />
      {instances.map((inst) => (
        <InstanceMasonCard key={inst.id} instance={inst} onOpen={onOpenInstance} onQuickStart={onQuickStart} />
      ))}
    </motion.div>
  )
}

/** Leading card in the waterfall: same content-driven shape as instance cards, with a dashed box + plus. */
export function NewInstanceCard({ onNew }: { onNew: () => void }) {
  const { t } = useTranslation("session")
  return (
    <button
      onClick={onNew}
      className="mb-4 break-inside-avoid flex flex-col rounded-xl overflow-hidden border border-border bg-card hover:border-primary/50 cursor-pointer w-full
        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring card-hover-glow"
      aria-label={t("newInstance")}
    >
      <div className="shrink-0 p-3">
        <div className="aspect-square w-full flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-muted-foreground/30 hover:border-primary/60 transition-colors text-center">
          <span className="flex items-center justify-center h-12 w-12 rounded-full bg-muted text-muted-foreground">
            <Plus className="h-6 w-6" />
          </span>
          <span className="font-medium text-muted-foreground">{t("newInstance")}</span>
          <span className="px-6 text-xs text-muted-foreground/70 leading-relaxed">{t("empty.desc")}</span>
        </div>
      </div>
    </button>
  )
}

function InstanceMasonCard({ instance, onOpen, onQuickStart }: { instance: Instance; onOpen: (i: Instance) => void; onQuickStart: (i: Instance) => void }) {
  const { t } = useTranslation("session")
  return (
    <div
      className="mb-4 break-inside-avoid flex flex-col rounded-xl overflow-hidden border border-border bg-card shadow-sm cursor-pointer
        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring card-hover-glow group"
      onClick={() => onOpen(instance)}
    >
      <div className="shrink-0 p-3 pb-0">
        <div className="aspect-square w-full overflow-hidden rounded-lg bg-muted">
          <CoverWithFetch
            kind="instance"
            id={instance.id}
            name={instance.name}
            className="transition-transform duration-300 ease-out group-hover:scale-[1.06]"
          />
        </div>
      </div>
      <div className="flex items-center gap-3 p-3">
        {/* Left: text stack (title over meta) */}
        <div className="flex-1 min-w-0 flex flex-col">
          <div className="font-semibold text-base leading-snug line-clamp-2">
            {instance.prototype_name ? `${instance.prototype_name} - ${instance.name}` : instance.name}
          </div>
          <div className="flex items-center gap-3 mt-1.5 text-xs text-muted-foreground">
            <span className="flex items-center gap-1">
              <Hash className="h-3.5 w-3.5" />
              {t("floorsLabel", { count: instance.floor_count })}
            </span>
            <span className="flex items-center gap-1">
              <Clock className="h-3.5 w-3.5" />
              {formatDateShort(instance.updated_at)}
            </span>
          </div>
        </div>
        {/* Right: square play icon — 快速进入会话 */}
        <button
          className="shrink-0 w-10 h-10 flex items-center justify-center rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 cursor-pointer
            transition-colors duration-150 active:scale-90"
          onClick={(e) => { e.stopPropagation(); onQuickStart(instance) }}
          title={t("quickStart")}
          aria-label={t("quickStart")}
        >
          <Play className="h-4 w-4" />
        </button>
      </div>
    </div>
  )
}
