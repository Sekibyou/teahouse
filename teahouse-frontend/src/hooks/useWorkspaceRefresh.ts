import { useCallback, useRef } from "react"
import { instancesApi, gitApi } from "@/lib/api"

export interface RefreshOptions {
  /** Reload file tree. Default true. */
  fileTree?: boolean
  /** If a file is open in editor, re-read disk + git HEAD content. Default true. */
  editor?: boolean
  /** Reset editor dirty flag. Default true. */
  clearDirty?: boolean
}

interface UseWorkspaceRefreshParams {
  instId: string | undefined
  selectedFileRef: React.MutableRefObject<string | null>
  loadFileTree: () => Promise<void>
  setFileContent: (v: string) => void
  setEditedContent: (v: string) => void
  setGitHeadContent: (v: string) => void
  setIsDirty: (v: boolean) => void
  setSelectedFile: (v: string | null) => void
}

/**
 * Unified refresh hook for the workspace.
 *
 * Centralises the refresh logic so save handlers and SSE events
 * trigger consistent reloads of file tree and editor.
 * Git status is managed by useGitStore, not this hook.
 */
export function useWorkspaceRefresh({
  instId,
  selectedFileRef,
  loadFileTree,
  setFileContent,
  setEditedContent,
  setGitHeadContent,
  setIsDirty,
  setSelectedFile,
}: UseWorkspaceRefreshParams) {
  const paramsRef = useRef({
    instId,
    loadFileTree,
    setFileContent,
    setEditedContent,
    setGitHeadContent,
    setIsDirty,
    setSelectedFile,
  })
  paramsRef.current = {
    instId,
    loadFileTree,
    setFileContent,
    setEditedContent,
    setGitHeadContent,
    setIsDirty,
    setSelectedFile,
  }

  const refresh = useCallback(async (options?: RefreshOptions) => {
    const {
      fileTree = true,
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

    // Wait for file tree to finish before refreshing editor
    if (fileTree) {
      await Promise.all(promises)
    }

    const currentFile = selectedFileRef.current
    if (editor && currentFile) {
      const [fileRes, headRes] = await Promise.all([
        instancesApi.readText(id, currentFile),
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
      } else {
        // File no longer exists — clear editor state
        p.setSelectedFile(null)
        p.setFileContent("")
        p.setEditedContent("")
        p.setGitHeadContent("")
        p.setIsDirty(false)
      }
    } else if (clearDirty) {
      p.setIsDirty(false)
    }
  }, [selectedFileRef])

  return refresh
}
