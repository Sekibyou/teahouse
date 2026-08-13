import { useCallback } from "react"

interface UseWorkspaceRefreshParams {
  instId: string | undefined
  loadFileTree: () => Promise<void>
}

/**
 * Thin helper to reload the file tree for the current instance.
 *
 * Editor content is intentionally NOT reloaded here — the Monaco editor is
 * uncontrolled and only (re)loads content via WorkspacePage's `openFile`
 * (file switch) and `reloadOpenFile` (external change), which remount the
 * editor through a `key` bump.
 */
export function useWorkspaceRefresh({ instId, loadFileTree }: UseWorkspaceRefreshParams) {
  const refresh = useCallback(async () => {
    if (!instId) return
    await loadFileTree()
  }, [instId, loadFileTree])

  return refresh
}
