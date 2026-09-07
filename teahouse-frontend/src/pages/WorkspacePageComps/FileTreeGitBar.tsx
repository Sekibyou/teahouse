import { GitBranch as GitBranchIcon, Edit3 } from "lucide-react"

interface ChangeCounts {
  added: number
  modified: number
  deleted: number
}

interface FileTreeGitBarProps {
  currentBranch: string
  latestCommitMsg?: string
  changeCounts: ChangeCounts
  onClick: () => void
  title?: string
}

// 文件树底部固定 Git 栏:分支名 + 最近 commit + 变更徽章,整栏点击打开 GitDialog。
// 纯展示组件,数据由调用方(WorkspacePage)从 useGitStore 派生后传入。
export function FileTreeGitBar({ currentBranch, latestCommitMsg, changeCounts, onClick, title }: FileTreeGitBarProps) {
  return (
    <button
      className="w-full shrink-0 flex items-center gap-1.5 border-t border-border px-2.5 py-1.5 hover:bg-muted/60 transition-colors cursor-pointer"
      onClick={onClick}
      title={title}
    >
      <GitBranchIcon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
      <span className="text-xs font-mono bg-muted px-1 py-0.5 rounded text-muted-foreground truncate shrink-0 max-w-[90px]">
        {currentBranch}
      </span>
      {latestCommitMsg && (
        <span className="text-xs text-muted-foreground truncate min-w-0">
          {latestCommitMsg.length > 30 ? latestCommitMsg.slice(0, 30) + "…" : latestCommitMsg}
        </span>
      )}
      {changeCounts.deleted > 0 && (
        <span className="text-xs bg-red-500/15 text-red-600 dark:text-red-400 font-medium px-1 py-0.5 rounded leading-none shrink-0">
          -{changeCounts.deleted}
        </span>
      )}
      {changeCounts.modified > 0 && (
        <span className="text-xs bg-yellow-500/15 text-yellow-600 dark:text-yellow-400 font-medium px-1 py-0.5 rounded leading-none shrink-0">
          ~{changeCounts.modified}
        </span>
      )}
      {changeCounts.added > 0 && (
        <span className="text-xs bg-green-500/15 text-green-600 dark:text-green-400 font-medium px-1 py-0.5 rounded leading-none shrink-0">
          +{changeCounts.added}
        </span>
      )}
      <Edit3 className="h-3 w-3 text-muted-foreground shrink-0 ml-auto" />
    </button>
  )
}
