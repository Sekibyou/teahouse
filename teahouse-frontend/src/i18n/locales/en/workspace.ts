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

  // 移动端实例内 · 底部三 Tab 外层 / 独立游玩层
  mobileHomeTab: "Home",
  mobileFilesTab: "Files",
  mobileDirectorTab: "Director",
  homeSectionPlayTitle: "Enter the story here",
  homeEnterPlay: "Enter play",
  homeSettingsTitle: "Quick settings",
  homeFontSize: "Font size",
  homeView: "View",
  homeSectionBackTitle: "Exit instance",
  homeBackToHome: "Back to instance list",
  homeGoBack: "Back",
  homePlayExit: "Exit play",

  // Mobile exit-instance confirmation dialog
  confirmExit: {
    title: "Exit instance",
    message: "Leave this instance and return to the instance list?",
    confirm: "Exit",
    proceed: "Exit anyway",
  },

  // 顶部栏 / 编辑器
  fileTreeTitle: "File tree",
  menuTitle: "Menu",
  noFileSelected: "No file selected",
  unsaved: "Unsaved",
  savedToDisk: "Saved to disk",
  mdRead: "Markdown reader",
  payload: "Payload reader",
  viewSource: "View source",
  currentFile: "Current file:",
  image: "Image",
  // Leaving a file with unsaved changes: three-option guard (save & leave / discard & leave / cancel)
  dirtyLeave: {
    save: "Save & leave",
    discard: "Discard & leave",
    closeTitle: "Close file",
    closeMessage: "\"{{path}}\" has unsaved changes. Save before closing, or discard them and close?",
    switchTitle: "Switch file",
    switchMessage: "\"{{path}}\" has unsaved changes. Save before switching, or discard them and switch?",
    exitTitle: "Leave file",
    exitMessage: "\"{{path}}\" has unsaved changes. Save before leaving, or discard them and leave?",
  },
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
    message: "Delete \"{{path}}\"? It moves to trash and can be undone with Ctrl+Z.",
    messageMany: "Delete the {{count}} selected item(s)? They move to trash and can be undone with Ctrl+Z.",
  },

  // Right-click menu · clipboard
  clipboard: {
    copyPath: "Copy path",
    copy: "Copy",
    cut: "Cut",
    paste: "Paste",
    copiedPath: "Instance path copied",
    copied: "Copied \"{{name}}\"",
    copiedMany: "Copied {{count}} item(s)",
    pasted: "Pasted/moved \"{{name}}\"",
    copySuffix: " (copy)",
    cutActive: "Cut \"{{name}}\" — right-click a target to paste",
    cutActiveMany: "Cut {{count}} item(s) — right-click a target to paste",
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
      title: "Export a Skill to the Skill library",
      desc: "Pick one Skill from the current instance and copy it to your Skill library (manageable in Settings > \"Skill management\", also enable-able in other instances).",
      select: "Select a Skill",
      empty: "This instance has no entry that can be exported as a Skill.",
      ph: "Select a Skill",
      submit: "Export to library",
    },
    submit: "Export",
  },

  // 覆盖确认
  overwrite: {
    "title.package": "Overwrite prompt package",
    "title.skill": "Overwrite Skill",
    lib: {
      package: "Prominent package library",
      skill: "Skill library",
    },
    message: "Your{{lib}} already contains a \"{{name}}\" with the same name. Overwriting deletes the old version in the library and replaces it with the one from the current instance; copies already added to other instances are unaffected. Confirm overwrite?",
    confirm: "Overwrite",
  },

  // 错误回退文案
  exportFail: "Export failed",
  skillLoadFail: "Failed to load Skill list",
  packageLoadFail: "Failed to load prompt package list",
}
