import { create } from "zustand"
import { gitApi } from "@/lib/api"
import type { GitStatus } from "@/lib/types"

export interface GitState {
  gitStatus: GitStatus | null
  fileStatuses: Map<string, string>  // path -> status char
  fetchGitStatus: (instanceId: string) => Promise<void>
}

export const useGitStore = create<GitState>()((set) => ({
  gitStatus: null,
  fileStatuses: new Map(),

  fetchGitStatus: async (instanceId: string) => {
    const [statusRes, fileRes] = await Promise.all([
      gitApi.getStatus(instanceId),
      gitApi.fileStatus(instanceId),
    ])
    const m = new Map<string, string>()
    if (fileRes.ok && fileRes.data?.files) {
      for (const f of fileRes.data.files) {
        m.set(f.path, f.status)
      }
    }
    set({
      gitStatus: statusRes.ok ? statusRes.data! : null,
      fileStatuses: m,
    })
  },
}))
