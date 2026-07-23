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
