import { create } from "zustand"
import { gitApi } from "@/lib/api"
import type { GitStatus } from "@/lib/types"

export interface GitState {
  gitStatus: GitStatus | null
  fileStatuses: Map<string, string>  // path -> status char
  fetchGitStatus: (instanceId: string) => Promise<void>
}

// Git status refresh is coalesced here (rather than at each call site) because
// many independent triggers call fetchGitStatus — SSE bursts, local file ops,
// the tree poll, ChatPanel status sync. A single structural op (rename/commit)
// can fan out into several of these within ~1s; without coalescing each would
// fire its own /refresh. This keeps at most one immediate call per window plus
// one trailing call after activity settles. Module-level so it's shared across
// the single store instance.
const GIT_THROTTLE_MS = 600
let _gitTimer: ReturnType<typeof setTimeout> | null = null
let _gitLastRun = 0

function fetchGitStatusNow(instanceId: string): void {
  gitApi.refresh(instanceId).then((res) => {
    if (!res.ok || !res.data) return
    const d = res.data
    const m = new Map<string, string>()
    if (d.file_statuses) {
      for (const f of d.file_statuses) {
        m.set(f.path, f.status)
      }
    }
    useGitStore.setState({
      gitStatus: d.git ?? null,
      fileStatuses: m,
    })
  })
}

function scheduleThrottledFetch(instanceId: string): void {
  if (_gitTimer) return // trailing call already pending
  const now = Date.now()
  if (now - _gitLastRun >= GIT_THROTTLE_MS) {
    _gitLastRun = now
    fetchGitStatusNow(instanceId)
    return
  }
  _gitTimer = setTimeout(() => {
    _gitTimer = null
    _gitLastRun = Date.now()
    fetchGitStatusNow(instanceId)
  }, GIT_THROTTLE_MS)
}

export const useGitStore = create<GitState>()(() => ({
  gitStatus: null,
  fileStatuses: new Map(),

  fetchGitStatus: async (instanceId: string) => {
    scheduleThrottledFetch(instanceId)
  },
}))
