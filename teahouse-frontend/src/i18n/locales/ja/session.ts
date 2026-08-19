export const jaSession = {
  // 品牌副标题（移动端头部）
  subtitle: "Harness を基盤とした対話型小説創作エンジン",
  menu: "メニュー",
  logout: "ログアウト",
  themeToggle: "テーマ切り替え",

  // 实例卡片 / 空态
  newInstance: "インスタンスを作成",
  empty: {
    title: "まだインスタンスがありません",
    desc: "本棚から物語を選んで、最初の冒険を始めましょう",
  },
  floorsLabel: "{{count}} フロア",
  quickStart: "クイックスタート",
  source: "出典：{{name}}",
  start: "開始",

  // 创建实例
  create: {
    fail: "作成に失敗",
    failRetry: "作成に失敗しました。もう一度お試しください",
    submit: "インスタンスを作成",
    submitShort: "作成",
    created: "「{{name}}」を作成しました",
  },

  // 复制实例
  copy: {
    title: "インスタンスを複製",
    submit: "複製",
    suffix: "{{name}} の複製",
    copied: "新しいインスタンス「{{name}}」として複製しました",
    fail: "複製に失敗",
    desc: "「{{name}}」を完全なスナップショットの複製（新インスタンス、独立した git）として作成します。主にプロトタイプをパックする前にプレイテストデータを保持する目的で使用します。",
    nameLabel: "新インスタンス名",
    namePh: "複製に名前を付ける",
  },

  // 重命名
  rename: {
    title: "名前を変更",
    renamed: "名前を変更しました",
    fail: "名前の変更に失敗",
  },

  // 导入 / 导出
  import: {
    title: "プロトタイプをインポート",
    success: "プロトタイプをインポートしました",
    duplicate: "このプロトタイプは既に存在し、再インポートは不要です",
    fail: "インポートに失敗",
  },
  download: "ダウンロード",

  // 删除确认
  deleteProto: {
    title: "プロトタイプの削除を確認",
    message: "プロトタイプ \"{{name}}\" を削除しますか？この操作は取り消せません。",
  },
  deleteInstance: {
    title: "インスタンスの削除を確認",
    message: "インスタンス \"{{name}}\" を削除しますか？この操作はこのインスタンスのすべてのデータを永久的に削除します。",
  },

  // 详情页
  noReadmeProto: "このプロトタイプには README の紹介がありません。",
  noReadmeInstance: "このインスタンスに関連付けられたプロトタイプの紹介はありません。",
  builtin: "内蔵",
  manageSkills: "Skill を管理（あなたの skill ライブラリから有効化）",
  manageSkillsShort: "Skill を管理",
  managePackages: "プロンプトパッケージを管理（あなたのパッケージライブラリから有効化）",
  managePackagesShort: "プロンプトパッケージを管理",
  packagesShort: "プロンプトパッケージ",
  instanceNameLabel: "この新しいインスタンスに名前を付けてください",
  instanceNamePh: "インスタンス名",

  // 书架
  shelfTitle: "本棚 · 物語を選択",
  shelfHint: "1 冊選んで、新しい物語を始めましょう。カバーをクリックで紹介を表示、「作成」で開始します。",
  shelfEmpty: "本棚は空です",
  closeShelf: "本棚を閉じる",
  backShelf: "本棚へ戻る",

  // Skill 管理
  skill: {
    manage: "Skill 管理",
    enableFor: "「{{name}}」の skill を有効化または削除",
    enabledTitle: "このインスタンスで有効化されている skill",
    noEnabled: "skill はまだ有効化されていません",
    addFrom: "あなたの skill ライブラリから追加",
    libEmpty: "skill ライブラリはまだ空です。まず設定ページ「Skill 管理」でインポートするか、インスタンス内でエクスポートしてください。",
    enable: {
      fail: "有効化に失敗",
    },
    remove: {
      title: "skill を削除",
      message: "「{{name}}」を削除しますか？このインスタンスから削除されるだけで、skill ライブラリには残ります。",
      fail: "削除に失敗",
    },
  },

  // 提示词包管理
  pkg: {
    manage: "プロンプトパッケージ管理",
    enableFor: "「{{name}}」のプロンプトパッケージを有効化または削除",
    enabledTitle: "このインスタンスで有効化されているプロンプトパッケージ",
    noEnabled: "プロンプトパッケージはまだ有効化されていません",
    addFrom: "あなたのプロンプトパッケージライブラリから追加",
    libEmpty: "プロンプトパッケージライブラリはまだ空です。まず設定ページ「プロンプトパッケージ」でインポートするか、インスタンス内でエクスポートしてください。",
    uninstall: "アンインストール",
    enable: {
      fail: "有効化に失敗",
    },
    remove: {
      title: "プロンプトパッケージをアンインストール",
      message: "「{{name}}」をアンインストールしますか？このインスタンスのパッケージライブラリから削除されるだけで、プロンプトパッケージライブラリには残ります。",
      fail: "削除に失敗",
    },
  },

  // 状态词
  remove: "削除",
  enabled: "有効",
  inInstance: "インスタンス内",
  enableAdd: "有効化",
}
