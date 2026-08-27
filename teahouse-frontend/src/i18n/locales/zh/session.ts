export const zhSession = {
  // 品牌副标题（移动端头部）
  subtitle: "基于 Harness 的交互式小说创作引擎",
  menu: "菜单",
  logout: "退出登录",
  themeToggle: "主题切换",

  // 实例卡片 / 空态
  newInstance: "新建实例",
  empty: {
    title: "还没有实例",
    desc: "从书架挑一个故事，开始你的第一段冒险",
  },
  floorsLabel: "{{count}} 楼",
  quickStart: "快速开始",
  source: "来源：{{name}}",
  start: "开始",

  // 创建实例
  create: {
    fail: "创建失败",
    failRetry: "创建失败，请重试",
    submit: "创建实例",
    submitShort: "创建",
    created: "已创建「{{name}}」",
  },

  // 复制实例
  copy: {
    title: "复制实例",
    submit: "复制",
    suffix: "{{name}} 副本",
    copied: "已复制为新实例「{{name}}」",
    fail: "复制失败",
    desc: "将「{{name}}」复制为一个完整快照副本（新实例、独立 git）。常用于打包原型前保留试玩数据。",
    nameLabel: "新实例名称",
    namePh: "为副本命名",
  },

  // 重命名
  rename: {
    title: "改名",
    renamed: "已重命名",
    fail: "重命名失败",
  },

  // 导入 / 导出
  import: {
    title: "导入原型",
    success: "原型导入成功",
    duplicate: "此原型已存在，无需重复导入",
    fail: "导入失败",
  },
  download: "下载",

  // 删除确认
  deleteProto: {
    title: "确认删除原型",
    message: "确定要删除原型 \"{{name}}\" 吗？此操作不可撤销。",
  },
  deleteInstance: {
    title: "确认删除实例",
    message: "确定要删除实例 \"{{name}}\" 吗？此操作将永久删除该实例的所有数据。",
  },

  // 详情页
  noReadmeProto: "该原型没有 README 介绍。",
  noReadmeInstance: "此实例没有关联的原型介绍。",
  builtin: "内置",
  manageSkills: "管理 Skill（从你的 Skill 库启用）",
  manageSkillsShort: "管理 Skill",
  managePackages: "管理提示词包（从你的包库启用）",
  managePackagesShort: "管理提示词包",
  packagesShort: "提示词包",
  instanceNameLabel: "给这个新实例起个名字",
  instanceNamePh: "实例名称",

  // 书架
  shelfTitle: "书架 · 选择故事",
  shelfHint: "挑一本，开始一段新的故事。点击封面查看介绍，点「创建」开始。",
  shelfEmpty: "书架空空如也",
  closeShelf: "关闭书架",
  backShelf: "返回书架",

  // Skill 管理
  skill: {
    manage: "Skill 管理",
    enableFor: "为「{{name}}」启用或移除 Skill",
    enabledTitle: "该实例已启用的 Skill",
    noEnabled: "尚未启用任何 Skill",
    addFrom: "从你的 Skill 库添加",
    libEmpty: "你的 Skill 库还是空的，可先在设置页「Skill 管理」导入，或在实例里导出。",
    enable: {
      fail: "启用失败",
    },
    remove: {
      title: "移除 Skill",
      message: "确定移除「{{name}}」吗？这只会从该实例删除，你的 Skill 库里仍保留。",
      fail: "移除失败",
    },
  },

  // 提示词包管理
  pkg: {
    manage: "提示词包管理",
    enableFor: "为「{{name}}」启用或移除提示词包",
    enabledTitle: "该实例已启用的提示词包",
    noEnabled: "尚未启用任何提示词包",
    addFrom: "从你的提示词包库添加",
    libEmpty: "你的提示词包库还是空的，可先在设置页「提示词包」导入，或在实例里导出。",
    uninstall: "卸载",
    enable: {
      fail: "启用失败",
    },
    remove: {
      title: "卸载提示词包",
      message: "确定卸载「{{name}}」吗？这只会从该实例包库删除，你的提示词包库里仍保留。",
      fail: "移除失败",
    },
  },

  // 状态词
  remove: "移除",
  enabled: "已启用",
  inInstance: "已在实例中",
  enableAdd: "启用",
}
