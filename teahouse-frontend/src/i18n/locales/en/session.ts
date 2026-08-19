export const enSession = {
  // 品牌副标题（移动端头部）
  subtitle: "A Harness-based interactive fiction creation engine",
  menu: "Menu",
  logout: "Log out",
  themeToggle: "Toggle theme",

  // 实例卡片 / 空态
  newInstance: "New instance",
  empty: {
    title: "No instances yet",
    desc: "Pick a story from the shelf and begin your first adventure",
  },
  floorsLabel: "{{count}} floors",
  quickStart: "Quick start",
  source: "Source: {{name}}",
  start: "Start",

  // 创建实例
  create: {
    fail: "Create failed",
    failRetry: "Create failed, please retry",
    submit: "Create instance",
    submitShort: "Create",
    created: "\"{{name}}\" created",
  },

  // 复制实例
  copy: {
    title: "Copy instance",
    submit: "Copy",
    suffix: "{{name}} copy",
    copied: "Copied as a new instance \"{{name}}\"",
    fail: "Copy failed",
    desc: "Copy \"{{name}}\" into a full snapshot (new instance, independent git). Often used before packaging a prototype to preserve playtest data.",
    nameLabel: "New instance name",
    namePh: "Name the copy",
  },

  // 重命名
  rename: {
    title: "Rename",
    renamed: "Renamed",
    fail: "Rename failed",
  },

  // 导入 / 导出
  import: {
    title: "Import prototype",
    success: "Prototype imported successfully",
    duplicate: "This prototype already exists; no need to import again",
    fail: "Import failed",
  },
  download: "Download",

  // 删除确认
  deleteProto: {
    title: "Confirm deleting prototype",
    message: "Delete prototype \"{{name}}\"? This action cannot be undone.",
  },
  deleteInstance: {
    title: "Confirm deleting instance",
    message: "Delete instance \"{{name}}\"? This permanently deletes all data of this instance.",
  },

  // 详情页
  noReadmeProto: "This prototype has no README introduction.",
  noReadmeInstance: "This instance has no associated prototype introduction.",
  builtin: "Built-in",
  manageSkills: "Manage Skills (enable from your skill library)",
  manageSkillsShort: "Manage Skills",
  managePackages: "Manage prompt packages (enable from your package library)",
  managePackagesShort: "Manage prompt packages",
  packagesShort: "Prompt packages",
  instanceNameLabel: "Give this new instance a name",
  instanceNamePh: "Instance name",

  // 书架
  shelfTitle: "Shelf · Choose a story",
  shelfHint: "Pick one and start a new story. Click the cover to view the introduction, click \"Create\" to begin.",
  shelfEmpty: "The shelf is empty",
  closeShelf: "Close shelf",
  backShelf: "Back to shelf",

  // Skill 管理
  skill: {
    manage: "Skill management",
    enableFor: "Enable or remove skills for \"{{name}}\"",
    enabledTitle: "Skills enabled for this instance",
    noEnabled: "No skills enabled yet",
    addFrom: "Add from your skill library",
    libEmpty: "Your skill library is still empty — import in Settings > \"Skill management\" first, or export from an instance.",
    enable: {
      fail: "Enable failed",
    },
    remove: {
      title: "Remove skill",
      message: "Remove \"{{name}}\"? This only removes it from this instance; it remains in your skill library.",
      fail: "Remove failed",
    },
  },

  // 提示词包管理
  pkg: {
    manage: "Prompt package management",
    enableFor: "Enable or remove prompt packages for \"{{name}}\"",
    enabledTitle: "Prompt packages enabled for this instance",
    noEnabled: "No prompt packages enabled yet",
    addFrom: "Add from your prompt package library",
    libEmpty: "Your prompt package library is still empty — import in Settings > \"Prompt packages\" first, or export from an instance.",
    uninstall: "Uninstall",
    enable: {
      fail: "Enable failed",
    },
    remove: {
      title: "Uninstall prompt package",
      message: "Uninstall \"{{name}}\"? This only removes it from this instance's package library; it remains in your prompt package library.",
      fail: "Remove failed",
    },
  },

  // 状态词
  remove: "Remove",
  enabled: "Enabled",
  inInstance: "In instance",
  enableAdd: "Enable",
}
