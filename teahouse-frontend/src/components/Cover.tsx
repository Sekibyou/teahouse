import { useEffect, useState } from "react"
import { cn } from "@/lib/utils"
import { instancesApi, prototypesApi } from "@/lib/api"
import type { CoverResponse } from "@/lib/types"
import { useTranslation } from "react-i18next"

/**
 * Deterministic warm gradient palettes, keyed by a name hash. Mirrors the
 * "茶馆书架" feel: muted earth/tea tones rather than neon, with enough
 * separation that adjacent cards read as distinct.
 */
const GRADIENTS = [
  "from-amber-800 to-stone-900",
  "from-teal-800 to-slate-900",
  "from-orange-800 to-neutral-900",
  "from-rose-800 to-zinc-900",
  "from-emerald-800 to-slate-900",
  "from-red-900 to-stone-900",
]

function hashName(name: string): number {
  let h = 0
  for (let i = 0; i < name.length; i++) {
    h = (h * 31 + name.charCodeAt(i)) >>> 0
  }
  return h
}

function toDataUri(c: CoverResponse): string {
  return `data:${c.mime};base64,${c.data}`
}

/**
 * Clamp a width/height ratio to the [3:4, 4:3] band (w/h in [0.75, 1.333]).
 * Too-wide or too-tall images zoom/crop (object-cover) to fit; images inside the
 * band keep their natural ratio. Returns a CSS aspect-ratio value.
 */
const MIN_RATIO = 3 / 4
const MAX_RATIO = 4 / 3
function clampRatio(w: number, h: number): string {
  if (!w || !h) return "3 / 4"
  const r = Math.min(MAX_RATIO, Math.max(MIN_RATIO, w / h))
  return `${r} / 1`
}

/**
 * Cover image rendered to a fixed aspect box.
 *
 * Clamping: within the [3:4, 4:3] band the box uses the natural ratio; outside
 * it the box clamps to the band edge and the image is object-cover cropped.
 * With no real cover it falls back to a deterministic gradient placeholder.
 *
 * `aspect` (default "3 / 4") is the target box ratio.
 */
export function Cover({
  name,
  src,
  alt,
  aspect = "3 / 4",
  driven = "width",
  className,
  imgClassName,
}: {
  /** Name used for the gradient placeholder initial + hash. */
  name: string
  /** Data URI when a real cover exists, else null/undefined → placeholder. */
  src?: string | null
  alt?: string
  /** CSS aspect-ratio for the fixed box. Defaults to book-ish 3:4. */
  aspect?: string
  /**
   * Which dimension is fixed.
   * - "width" (default): box is full-width; height = width / ratio (card grid).
   * - "height": box fills its parent's height; width = height × ratio (wide
   *   screens, image scales with available height).
   */
  driven?: "width" | "height"
  className?: string
  imgClassName?: string
}) {
  const { t } = useTranslation("misc")
  const grad = GRADIENTS[hashName(name) % GRADIENTS.length]
  const box = driven === "height" ? "h-full w-auto" : "w-full"
  return (
    <div
      className={cn("relative overflow-hidden select-none bg-gradient-to-br", box, grad, className)}
      style={{ aspectRatio: aspect }}
    >
      {src ? (
        <img
          src={src}
          alt={alt ?? name}
          loading="lazy"
          className={cn("absolute inset-0 w-full h-full object-cover", imgClassName)}
        />
      ) : (
        <span className="absolute inset-0 flex items-center justify-center text-white/90">
          <span className="text-[3em] font-serif leading-none">{name.trim().charAt(0) || t("cover.placeholderChar")}</span>
        </span>
      )}
    </div>
  )
}

/**
 * Cover that wires fetching to an instance or prototype and clamps its aspect
 * ratio to the [3:4, 4:3] band. Render at the clamped ratio so masonry cards
 * stay neat (no extreme tall/wide cards) while cropped content is centered.
 */
export function CoverWithFetch({
  kind,
  id,
  name,
  driven = "width",
  className,
  imgClassName,
}: {
  kind: "instance" | "prototype"
  id: string
  name: string
  /** See Cover.driven. Defaults to "width". */
  driven?: "width" | "height"
  className?: string
  imgClassName?: string
}) {
  const [state, setState] = useState<{ url: string; size: [number, number] | null } | null>(null)

  useEffect(() => {
    let cancelled = false
    const api = kind === "instance" ? instancesApi : prototypesApi
    void api.getCover(id).then((res) => {
      if (cancelled) return
      if (res.ok && res.data) {
        setState({ url: toDataUri(res.data), size: res.data.size ?? null })
      } else {
        setState(null)
      }
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, id])

  const aspect = state?.size ? clampRatio(state.size[0], state.size[1]) : "3 / 4"
  return <Cover name={name} src={state?.url ?? null} aspect={aspect} driven={driven} className={className} imgClassName={imgClassName} />
}
