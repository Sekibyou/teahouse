import { SlidersHorizontal, Server, Link2, Sliders, FileText, Puzzle, BookOpen, Package, Users } from "lucide-react"
import type { LucideIcon } from "lucide-react"

export type TabKey = "models" | "profiles" | "presets" | "slots" | "general" | "plugins" | "skills" | "packages" | "users"

export interface TabItem {
  key: TabKey
  Icon: LucideIcon
  label: string
  adminOnly?: boolean
}

export const TAB_ITEMS: TabItem[] = [
  { key: "general", Icon: SlidersHorizontal, label: "tab.general" },
  { key: "models", Icon: Server, label: "tab.models" },
  { key: "slots", Icon: Link2, label: "tab.slots" },
  { key: "profiles", Icon: Sliders, label: "tab.profiles" },
  { key: "presets", Icon: FileText, label: "tab.presets" },
  { key: "plugins", Icon: Puzzle, label: "tab.plugins" },
  { key: "skills", Icon: BookOpen, label: "tab.skills" },
  { key: "packages", Icon: Package, label: "tab.packages" },
  { key: "users", Icon: Users, label: "tab.users", adminOnly: true },
]

export const permLabels: Record<string, string> = {
  tool: "perm.tool",
  frontend: "perm.frontend",
  network: "perm.network",
  file_read: "perm.file_read",
  file_write: "perm.file_write",
}
