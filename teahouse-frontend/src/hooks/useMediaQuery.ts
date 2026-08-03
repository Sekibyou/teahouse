import { useState, useEffect } from "react"

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => {
    if (typeof window !== "undefined") {
      return window.matchMedia(query).matches
    }
    return false
  })

  useEffect(() => {
    const mql = window.matchMedia(query)
    const handler = (e: MediaQueryListEvent) => setMatches(e.matches)
    mql.addEventListener("change", handler)
    setMatches(mql.matches)
    return () => mql.removeEventListener("change", handler)
  }, [query])

  return matches
}

// Layout mode is locked once at session start: a window dragged across the
// 1080px breakpoint mid-use would otherwise force desktop<->mobile re-layout
// (tearing down & recreating Monaco etc.), which is both janky and crash-prone.
// Real usage never needs mid-session switching, so snapshot once and never listen.
let _isMobileLocked: boolean | null = null

/** True when viewport is < 1081px (mobile/narrow), locked for the whole session. */
export function useIsMobile(): boolean {
  const [mobile] = useState(() => {
    if (_isMobileLocked !== null) return _isMobileLocked
    const mql = typeof window !== "undefined"
      ? window.matchMedia("(max-width: 1080px)")
      : null
    _isMobileLocked = mql ? mql.matches : false
    return _isMobileLocked
  })
  return mobile
}
