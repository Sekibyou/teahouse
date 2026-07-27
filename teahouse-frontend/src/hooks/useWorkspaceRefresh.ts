import { useCallback, useRef } from "react"
import { instancesApi, gitApi } from "@/lib/api"

export interface RefreshOptions {
  /** Reload file tree. Default true. */
  fileTree?: boolean
  /** Reload git status + per-file statuses. Default true. */
  gitStatus?: boolean
  /** If a file is open in editor, re-read disk + git HEAD content. Default true. */
  editor?: boolean
  /** Reset editor dirty flag. Default true. */
  clearDirty?: boolean
}

interface UseWorkspaceRefreshParams {
  instId: string | undefined
  selectedFileRef: React.MutableRefObject<string | null>
  loadFileTree: () => Promise<void>
  loadGitStatus: () => Promise<void>
  loadFileStatuses: () => Promise<void>
  setFileContent: (v: string) => void
  setEditedContent: (v: string) => void
  setGitHeadContent: (v: string) => void
  setIsDirty: (v: boolean) => void
  setContentReady: (v: boolean) => void
}

/**
 * Unified refresh hook for the workspace.
 *
 * Centralises the refresh logic so ChatPanel (after AI tool calls),
 * GitDialog (after user git operations), and save handlers all
 * trigger consistent reloads of file tree, git status, and editor.
 */
export function useWorkspaceRefresh({
  instId,
  selectedFileRef,
  loadFileTree,
  loadGitStatus,
  loadFileStatuses,
  setFileContent,
  setEditedContent,
  setGitHeadContent,
  setIsDirty,
  setContentReady,
}: UseWorkspaceRefreshParams) {
  const paramsRef = useRef({
    instId,
    loadFileTree,
    loadGitStatus,
    loadFileStatuses,
    setFileContent,
    setEditedContent,
    setGitHeadContent,
    setIsDirty,
    setContentReady,
  })
  paramsRef.current = {
    instId,
    loadFileTree,
    loadGitStatus,
    loadFileStatuses,
    setFileContent,
    setEditedContent,
    setGitHeadContent,
    setIsDirty,
    setContentReady,
  }

  const refresh = useCallback(async (options?: RefreshOptions) => {
    const {
      fileTree = true,
      gitStatus = true,
      editor = true,
      clearDirty = true,
    } = options ?? {}

    const p = paramsRef.current
    const id = p.instId
    if (!id) return

    const promises: Promise<unknown>[] = []

    if (fileTree) {
      promises.push(p.loadFileTree())
    }

    if (gitStatus) {
      p.loadGitStatus()
      p.loadFileStatuses()
    }

    // Wait for file tree to finish before refreshing editor
    if (fileTree) {
      await Promise.all(promises)
    }

    const currentFile = selectedFileRef.current
    if (editor && currentFile) {
      const [fileRes, headRes] = await Promise.all([
        instancesApi.readFile(id, currentFile),
        gitApi.showFile(id, currentFile),
      ])
      if (fileRes.ok) {
        p.setFileContent(fileRes.data!.content)
        p.setEditedContent(fileRes.data!.content)
        const headContent =
          headRes.ok && headRes.data?.content != null ? headRes.data.content : ""
        p.setGitHeadContent(headContent)
        if (clearDirty) {
          p.setIsDirty(false)
        }
      }
    } else if (clearDirty) {
      p.setIsDirty(false)
    }
  }, [selectedFileRef])

  return refresh
}
