// Shared types for prototypes, instances, and file tree

export interface User {
  user_id: string
  username: string
  display_name: string
}

export interface Prototype {
  id: string
  user_id: string | null
  name: string
  description: string
  source_path: string
  is_builtin: number
  created_at: number
  updated_at: number
}

export interface Instance {
  id: string
  user_id: string
  prototype_id: string
  name: string
  dir_path: string
  floor_count: number
  status: string
  created_at: number
  updated_at: number
}

export interface FileTreeNode {
  name: string
  path: string
  type: "file" | "directory"
  children?: FileTreeNode[]
}

export interface ActiveSession {
  instance: {
    id: string
    name: string
    dir_path: string
  } | null
}

export interface LLMConfig {
  id: string
  user_id: string
  label: string
  api_url: string
  api_key: string
  api_format: string
  model_name: string
  max_tokens: number
  temperature: number
  is_default: number
  is_enabled: number
  created_at: number
  updated_at: number
}

export interface ChatMessage {
  role: "user" | "assistant" | "system"
  content: string
}

// Git types
export interface GitBranch {
  name: string
  is_current: boolean
  commit_hash: string
  commit_message: string
}

export interface GitCommitResult {
  commit_hash: string
  branch: string
  files_changed: string[]
  message?: string
}

export interface GitBranchResult {
  action: string
  branches?: GitBranch[]
  name?: string
  current_branch?: string
  message?: string
}

export interface GitStatus {
  git_initialized: boolean
  current_branch?: string
  branches?: GitBranch[]
  recent_commits?: { hash: string; author: string; date: string; message: string }[]
  has_uncommitted?: boolean
  error?: string
}

export interface GitLogEntry {
  hash: string
  author: string
  date: string
  message: string
}
