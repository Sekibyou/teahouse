import type { FileTreeNode, TreeNodeRef } from "./types"

// 递归收集整棵树全部条目（目录 + 文件，不含渲染层过滤的根 .git）。
// Ctrl+A 全选用：不依赖"当前展开可见"的行，直接遍历完整 fileTree。
export function collectAllEntries(nodes: FileTreeNode[]): TreeNodeRef[] {
  const out: TreeNodeRef[] = []
  const walk = (list: FileTreeNode[]) => {
    for (const n of list) {
      if (n.name === ".git") continue
      out.push({ path: n.path, type: n.type, name: n.name })
      if (n.children) walk(n.children)
    }
  }
  walk(nodes)
  return out
}

// 多选集去重：去掉互为祖先的重叠项（如同时选了目录与其内文件），避免
// 复制/剪切/删除时对同一子树重复操作（move/delete 子树后再碰其内项会失败）。
export function pruneNestedItems(items: TreeNodeRef[]): TreeNodeRef[] {
  const res: TreeNodeRef[] = []
  for (const it of items) {
    const hasAncestor = res.some((r) => it.path === r.path || it.path.startsWith(r.path + "/"))
    if (hasAncestor) continue
    res.push(it)
  }
  return res
}

// 判断某活动元素是否是可编辑目标（Monaco 隐藏 textarea / 原生 textarea /
// input / contentEditable）。命中时文件树键盘快捷键应让位文本剪贴板。
export function isEditableTarget(ae: Element | null): boolean {
  if (!ae) return false
  if (ae === document.body) return false
  const el = ae as HTMLElement
  if (el.isContentEditable) return true
  const tag = el.tagName?.toLowerCase()
  if (tag === "textarea" || tag === "input") return true
  return !!el.closest?.(".monaco-editor")
}
