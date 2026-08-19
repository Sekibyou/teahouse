export const zhWorkspace = {
  // 模式 / 主菜单
  language: "语言",
  "mode.play": "游玩模式",
  director: "导演",
  versionControl: "版本控制",
  fileList: "文件清单",
  userManagement: "用户管理",
  themeToggle: "主题切换",
  exitToHome: "退出到主页",

  // 顶部栏 / 编辑器
  fileTreeTitle: "文件树",
  menuTitle: "菜单",
  noFileSelected: "未选择文件",
  unsaved: "未保存",
  savedToDisk: "已保存到磁盘",
  previewMarkdown: "预览 Markdown",
  backToCodeEdit: "返回代码编辑",
  preview: "预览",
  code: "代码",
  image: "图片",
  selectFileMobileHint: "点击左上角文件按钮选择文件",
  selectFileDesktopHint: "从左侧选择文件进行编辑",
  ctrlSHint: "Ctrl+S 保存",
  uploadToRoot: "上传文件到根目录",
  uploadToHere: "上传文件到此处",
  expandDirector: "展开导演面板",
  location: "位置：{{path}}",

  // 新建
  create: {
    titleFile: "新建文件",
    titleFolder: "新建文件夹",
    filePh: "文件名",
    folderPh: "文件夹名称",
    submit: "创建",
    fileTitle: "新建文件",
    folderTitle: "新建文件夹",
  },

  // 重命名
  rename: {
    title: "重命名",
    ph: "新名称",
  },

  // 删除确认
  deleteConfirm: {
    title: "确认删除",
    message: "确定删除 \"{{path}}\" 吗？此操作不可撤销。",
  },

  // 导出类型切换
  export: {
    titleBar: "导出为原型 / Skill",
    type: {
      prototype: "导出原型",
      skill: "导出 Skill",
      package: "导出提示词包",
    },
    prototype: {
      title: "导出为原型",
      desc: "将当前实例打包为可复用的原型（排除 building/ 等内部目录）。请先在实例上清理测试数据（楼层、变量、泛化 teahouse.md），再导出。",
      name: "原型名称",
      namePh: "为原型起个名字",
      descLabel: "简介",
      maxChars: "(最多50字)",
      descPh: "简要描述，用于原型列表展示",
      author: "作者",
      optional: "(可选)",
      authorPh: "作者名",
    },
    package: {
      title: "导出提示词包到包库",
      desc: "选取当前实例 packages/ 里的一个提示词包，复制到你的提示词包库（可在设置页「提示词包」中管理，也可到其他实例里启用）。",
      select: "选择提示词包",
      empty: "该实例没有可作为提示词包导出的条目。",
      ph: "选择一个提示词包",
      submit: "导出到库里",
    },
    skill: {
      title: "导出 Skill 到 skill 库",
      desc: "选取当前实例里的一个 skill，复制到你的 skill 库（可在设置页「Skill 管理」中管理，也可到其他实例里启用）。",
      select: "选择 skill",
      empty: "该实例没有可作为 skill 导出的条目。",
      ph: "选择一个 skill",
      submit: "导出到库里",
    },
    submit: "导出",
  },

  // 覆盖确认
  overwrite: {
    "title.package": "覆盖提示词包",
    "title.skill": "覆盖 skill",
    lib: {
      package: "提示词包库",
      skill: "skill 库",
    },
    message: "你的{{lib}}中已有同名「{{name}}」。覆盖会删除库里已有的旧版本并用当前实例里的覆盖，已复制进其它实例的副本不受影响。确认覆盖？",
    confirm: "覆盖",
  },

  // 错误回退文案
  exportFail: "导出失败",
  skillLoadFail: "加载 skill 列表失败",
  packageLoadFail: "加载提示词包列表失败",
}
