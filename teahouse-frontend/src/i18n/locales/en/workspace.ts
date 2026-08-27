export const enWorkspace = {
  // 模式 / 主菜单
  language: "Language",
  "mode.play": "Play mode",
  director: "Director",
  versionControl: "Version control",
  fileList: "File list",
  userManagement: "Users",
  themeToggle: "Toggle theme",
  exitToHome: "Exit to home",

  // 顶部栏 / 编辑器
  fileTreeTitle: "File tree",
  menuTitle: "Menu",
  noFileSelected: "No file selected",
  unsaved: "Unsaved",
  savedToDisk: "Saved to disk",
  previewMarkdown: "Preview Markdown",
  backToCodeEdit: "Back to code editing",
  preview: "Preview",
  code: "Code",
  image: "Image",
  selectFileMobileHint: "Tap the file button in the top-left to select a file",
  selectFileDesktopHint: "Select a file from the left to edit",
  ctrlSHint: "Ctrl+S to save",
  uploadToRoot: "Upload file to root",
  uploadToHere: "Upload file here",
  moveToRoot: "Release to move into the instance root",
  expandDirector: "Expand director panel",
  location: "Location: {{path}}",

  // 新建
  create: {
    titleFile: "New file",
    titleFolder: "New folder",
    filePh: "File name",
    folderPh: "Folder name",
    submit: "Create",
    fileTitle: "New file",
    folderTitle: "New folder",
  },

  // 重命名
  rename: {
    title: "Rename",
    ph: "New name",
  },

  // 删除确认
  deleteConfirm: {
    title: "Confirm deletion",
    message: "Delete \"{{path}}\"? This action cannot be undone.",
  },

  // Right-click menu · clipboard
  clipboard: {
    copyPath: "Copy path",
    copy: "Copy",
    cut: "Cut",
    paste: "Paste",
    copiedPath: "Instance path copied",
    copied: "Copied \"{{name}}\"",
    pasted: "Pasted/moved \"{{name}}\"",
    copySuffix: " (copy)",
    cutActive: "Cut \"{{name}}\" — right-click a target to paste",
  },
  // Drag-and-drop upload status
  dropUpload: {
    done: "Uploaded {{count}} file(s)",
    fail: "Failed to upload: {{names}}",
  },

  // 导出类型切换
  export: {
    titleBar: "Export as Prototype / Skill",
    type: {
      prototype: "Export prototype",
      skill: "Export Skill",
      package: "Export prompt package",
    },
    prototype: {
      title: "Export as prototype",
      desc: "Package the current instance as a reusable prototype (excludes internal directories such as building/). Clean up test data in the instance first (floors, variables, generalize teahouse.md), then export.",
      name: "Prototype name",
      namePh: "Give the prototype a name",
      descLabel: "Description",
      maxChars: "(Max 50 characters)",
      descPh: "Brief description shown in the prototype list",
      author: "Author",
      optional: "(Optional)",
      authorPh: "Author name",
    },
    package: {
      title: "Export a prompt package to the library",
      desc: "Pick one prompt package from the current instance's packages/ and copy it to your prompt package library (manageable in Settings > \"Prompt packages\", also enable-able in other instances).",
      select: "Select a prompt package",
      empty: "This instance has no entry that can be exported as a prompt package.",
      ph: "Select a prompt package",
      submit: "Export to library",
    },
    skill: {
      title: "Export a Skill to the skill library",
      desc: "Pick one skill from the current instance and copy it to your skill library (manageable in Settings > \"Skill management\", also enable-able in other instances).",
      select: "Select a skill",
      empty: "This instance has no entry that can be exported as a skill.",
      ph: "Select a skill",
      submit: "Export to library",
    },
    submit: "Export",
  },

  // 覆盖确认
  overwrite: {
    "title.package": "Overwrite prompt package",
    "title.skill": "Overwrite skill",
    lib: {
      package: "Prominent package library",
      skill: "Skill library",
    },
    message: "Your{{lib}} already contains a \"{{name}}\" with the same name. Overwriting deletes the old version in the library and replaces it with the one from the current instance; copies already added to other instances are unaffected. Confirm overwrite?",
    confirm: "Overwrite",
  },

  // 错误回退文案
  exportFail: "Export failed",
  skillLoadFail: "Failed to load skill list",
  packageLoadFail: "Failed to load prompt package list",
}
