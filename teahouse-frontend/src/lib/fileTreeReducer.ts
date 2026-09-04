import type { FileTreeNode } from "@/lib/types"
import { ROOT } from "@/lib/api"

/**
 * Deterministic structural updates to the instance file tree, driven by
 * backend `file_changed` events that carry a change `type`.
 *
 * The tree here is the shape held in state / returned by `instancesApi.listFiles`
 * — i.e. every node path is in FRONTEND form ("root/...", root itself is "root").
 * The reducer is pure: it never mutates input nodes, returns a new tree, and
 * reports "could not reconcile" via `null` so the caller falls back to a full
 * reload (listFiles) — that reload is the convergence backstop, not the norm.
 * deletes/moves whose target is already absent return the SAME tree (idempotent
 * no-op for our own optimistic edits echoed back); only creates that can't find
 * their parent directory return null.
 *
 * Node-shape mirrors backend `list_file_tree` (workspaces.py:339) which exposes
 * every entry including hidden dirs; the render layer independently hides `.git`
 * (WorkspacePage). Sibling ordering mirrors list_file_tree too: directories
 * first, then files, each group alphabetical by lowercased name — so a locally
 * inserted node matches what a fresh list would return (avoids the poll
 * self-heal firing a spurious re-sync).
 */

export type FileChangeType = "created" | "modified" | "deleted" | "moved"

export interface FileChangeEvent {
  type?: string
  path: string
  prevPath?: string
  /** For "created": "file" | "directory". Unknown → file. A wrong guess for a
   * directory realigns via the poll self-heal once a child event lands. */
  nodeType?: "file" | "directory"
}

const sep = "/"

function parentPath(p: string): string {
  const i = p.lastIndexOf(sep)
  return i <= 0 ? ROOT : p.slice(0, i)
}

function basename(p: string): string {
  const i = p.lastIndexOf(sep)
  return i === -1 ? p : p.slice(i + 1)
}

/** A node exists in the tree whose .path === path. */
function hasNode(nodes: FileTreeNode[], path: string): boolean {
  return nodes.some((n) => n.path === path)
}

/** Build a standalone leaf/dir node (frontend path form). */
function makeNode(path: string, type: "file" | "directory"): FileTreeNode {
  return { name: basename(path), path, type }
}

/** Comparator mirroring backend list_file_tree ordering (dirs first, then alpha by lower name). */
function compareSiblings(a: FileTreeNode, b: FileTreeNode): number {
  if (a.type !== b.type) return a.type === "directory" ? -1 : 1
  const an = a.name.toLowerCase()
  const bn = b.name.toLowerCase()
  return an < bn ? -1 : an > bn ? 1 : 0
}

/**
 * Immutably remove subtree at `path` (self + descendants). Returns null when the
 * target (or a directory on its path) is not present — out of sync → reload.
 */
export function removeSubtree(tree: FileTreeNode[], path: string): FileTreeNode[] | null {
  const rec = (nodes: FileTreeNode[]): FileTreeNode[] | null => {
    let removed = false
    const next: FileTreeNode[] = []
    for (const n of nodes) {
      if (n.path === path) {
        removed = true
        continue
      }
      if (n.type === "directory" && n.path && path.startsWith(n.path + sep)) {
        const kids = rec(n.children ?? [])
        if (kids === null) return null
        next.push({ ...n, children: kids })
      } else {
        next.push(n)
      }
    }
    return removed ? next : null
  }
  return rec(tree)
}

/** Remove subtree at `path` and return both pruned tree and the detached node. Null if absent. */
function detachNode(tree: FileTreeNode[], path: string): { tree: FileTreeNode[]; subtree: FileTreeNode } | null {
  for (let i = 0; i < tree.length; i++) {
    const n = tree[i]
    if (n.path === path) {
      return { tree: [...tree.slice(0, i), ...tree.slice(i + 1)], subtree: n }
    }
    if (n.type === "directory" && n.path && path.startsWith(n.path + sep)) {
      const inner = detachNode(n.children ?? [], path)
      if (inner) {
        const next = tree.slice()
        next[i] = { ...n, children: inner.tree }
        return { tree: next, subtree: inner.subtree }
      }
    }
  }
  return null
}

/** Insert `node` under directory at `dirPath` (ROOT = top level), preserving order. Null if dir missing. */
function insertInto(tree: FileTreeNode[], dirPath: string, node: FileTreeNode): FileTreeNode[] | null {
  const sorted = (list: FileTreeNode[], item: FileTreeNode): FileTreeNode[] => {
    const next = list.slice()
    const idx = next.findIndex((c) => compareSiblings(c, item) > 0)
    next.splice(idx === -1 ? next.length : idx, 0, item)
    return next
  }
  if (dirPath === ROOT) return sorted(tree, node)

  for (let i = 0; i < tree.length; i++) {
    const n = tree[i]
    if (n.type !== "directory" || !n.path) continue
    if (n.path === dirPath) {
      const next = tree.slice()
      next[i] = { ...n, children: sorted(n.children ?? [], node) }
      return next
    }
    if (dirPath.startsWith(n.path + sep)) {
      const inner = insertInto(n.children ?? [], dirPath, node)
      if (inner) {
        const next = tree.slice()
        next[i] = { ...n, children: inner }
        return next
      }
    }
  }
  return null
}

/**
 * Apply one structural change event to the tree.
 *
 * Returns the updated tree, or:
 *  - the SAME array reference when nothing structural should change
 *    (type "modified", unknown/missing type) — the caller then skips any tree
 *    refresh entirely (content edits do not change tree shape);
 *  - null when the event cannot be reconciled against the current tree
 *    (missing parent / already-deleted target) — the caller must full-reload.
 */
export function applyFileChange(tree: FileTreeNode[], evt: FileChangeEvent): FileTreeNode[] | null {
  const type = evt.type
  const path = evt.path
  if (!path || !type || type === "modified") return tree

  switch (type) {
    case "created": {
      // Already present (e.g. echo of a local create we applied optimistically)
      // → idempotent no-op. Backend can't tell us file-vs-dir on the SSE, but
      // the REST layer knows; SSE events default to a file leaf, and the poll
      // self-heal realigns a directory once a child event lands.
      if (hasNode(tree, path)) return tree
      const parent = parentPath(path)
      const node = makeNode(path, evt.nodeType === "directory" ? "directory" : "file")
      return insertInto(tree, parent, node)
    }
    case "deleted":
      // Idempotent: a delete of something already gone (e.g. our own optimistic
      // delete echoed back) is a no-op — return the same tree, not null. Only a
      // genuine absence that leaves the tree dirty would warrant a reload.
      return removeSubtree(tree, path) ?? tree
    case "moved": {
      if (!evt.prevPath) return tree // no source given → cannot move; treat as no-op
      const detached = detachNode(tree, evt.prevPath)
      // Source already gone (echo of our own optimistic move) → idempotent no-op.
      if (!detached) return tree
      const subtree: FileTreeNode = {
        ...detached.subtree,
        path,
        name: basename(path),
      }
      return insertInto(detached.tree, parentPath(path), subtree)
    }
    default:
      return tree
  }
}
