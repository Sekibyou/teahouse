// Shared types for prototypes, instances, and file tree

export interface CoverResponse {
  mime: string
  data: string
  /** [width, height] for images, null otherwise. Drives masonry layout. */
  size: [number, number] | null
}

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
  prototype_id: string | null
  name: string
  dir_path: string
  floor_count: number
  status: string
  created_at: number
  updated_at: number
  prototype_name?: string | null
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

// New LLM model system types
export interface LLMProvider {
  id: string
  user_id: string
  name: string
  api_url: string
  api_key: string
  api_format: "openai" | "openai_strict" | "anthropic"
  model_fetch_url: string
  is_enabled: number
  created_at: number
  updated_at: number
}

export interface LLMModel {
  id: string
  user_id: string
  name: string
  provider_id: string
  model_name: string
  profile_id: string | null
  is_enabled: number
  created_at: number
  updated_at: number
  // Joined from provider:
  provider_name?: string
  provider_api_format?: string
  provider_api_url?: string
}

export interface ModelProfile {
  id: string
  user_id: string
  name: string
  is_builtin: number
  match_pattern: string | null
  temperature: number
  max_tokens: number
  max_context: number
  top_p: number | null
  frequency_penalty: number | null
  presence_penalty: number | null
  created_at: number
  updated_at: number
}

export interface SlotBindings {
  director: SlotBinding
  writer: SlotBinding
}

export interface SlotBinding {
  model_id: string | null
  profile_id: string | null
  prompt_preset_id: string | null  // director slot only
}

export interface DirectorPromptPreset {
  id: string
  user_id: string
  name: string
  is_builtin: number
  match_pattern: string | null
  template_yaml: string
  created_at: number
  updated_at: number
}

export interface AppSettings {
  max_retries: number
  max_tool_rounds: number
}

export interface AvailableModel {
  id: string
  name: string
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

export interface GitCommitRequest {
  type: "floor" | "summary" | "other"
  number?: number
  start?: number
  end?: number
  message: string
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
  recent_commits?: GitLogEntry[]
  has_uncommitted?: boolean
  error?: string
}

export interface GitLogEntry {
  hash: string
  hash_full: string
  parents: string[]
  parents_full: string[]
  author: string
  date: string
  message: string
  refs: string
}

export interface GitFileStatus {
  path: string
  status: string  // M A D ? R
  staged: boolean
}

// Text style rules for symbol-based coloring
export interface TextStyleRule {
  start_symbol: string
  end_symbol: string
  start_html: string
  end_html: string
  enabled: boolean
  order: number
}

// Floors stats from SSE floors_changed event
export interface FloorsStats {
  latest_floor: number | null
  total_confirmed: number
  total_drafts: number
  total_floors: number
  last_summary_start: number | null
  last_summary_end: number | null
  unsummarized: number
  instance_id: string
}
