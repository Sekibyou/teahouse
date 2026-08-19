export const jaWorkspace = {
  // 模式 / 主菜单
  language: "言語",
  "mode.play": "プレイモード",
  director: "監督",
  versionControl: "バージョン管理",
  fileList: "ファイル一覧",
  userManagement: "ユーザー管理",
  themeToggle: "テーマ切り替え",
  exitToHome: "ホームへ戻る",

  // 顶部栏 / 编辑器
  fileTreeTitle: "ファイルツリー",
  menuTitle: "メニュー",
  noFileSelected: "ファイル未選択",
  unsaved: "未保存",
  savedToDisk: "ディスクに保存しました",
  previewMarkdown: "Markdown をプレビュー",
  backToCodeEdit: "コード編集に戻る",
  preview: "プレビュー",
  code: "コード",
  image: "画像",
  selectFileMobileHint: "左上のファイルボタンをタップしてファイルを選択",
  selectFileDesktopHint: "左側からファイルを選択して編集",
  ctrlSHint: "Ctrl+S で保存",
  uploadToRoot: "ファイルをルートにアップロード",
  uploadToHere: "ファイルをここにアップロード",
  expandDirector: "監督パネルを展開",
  location: "場所：{{path}}",

  // 新建
  create: {
    titleFile: "新規ファイル",
    titleFolder: "新規フォルダ",
    filePh: "ファイル名",
    folderPh: "フォルダ名",
    submit: "作成",
    fileTitle: "新規ファイル",
    folderTitle: "新規フォルダ",
  },

  // 重命名
  rename: {
    title: "名前を変更",
    ph: "新しい名前",
  },

  // 删除确认
  deleteConfirm: {
    title: "削除の確認",
    message: "\"{{path}}\" を削除しますか？この操作は取り消せません。",
  },

  // 导出类型切换
  export: {
    titleBar: "プロトタイプ / Skill としてエクスポート",
    type: {
      prototype: "プロトタイプをエクスポート",
      skill: "Skill をエクスポート",
      package: "プロンプトパッケージをエクスポート",
    },
    prototype: {
      title: "プロトタイプとしてエクスポート",
      desc: "現在のインスタンスを再利用可能なプロトタイプとしてパックします（building/ などの内部ディレクトリは除外）。先にインスタンスでテストデータを整理（フロア、変数、teahouse.md の一般化）してからエクスポートしてください。",
      name: "プロトタイプ名",
      namePh: "プロトタイプに名前を付ける",
      descLabel: "紹介",
      maxChars: "（最大 50 文字）",
      descPh: "プロトタイプ一覧に表示される簡単な説明",
      author: "作者",
      optional: "（任意）",
      authorPh: "作者名",
    },
    package: {
      title: "プロンプトパッケージをパッケージライブラリにエクスポート",
      desc: "現在のインスタンスの packages/ からプロンプトパッケージを選び、プロンプトパッケージライブラリへ複製します（設定ページ「プロンプトパッケージ」で管理でき、他のインスタンスでも有効化できます）。",
      select: "プロンプトパッケージを選択",
      empty: "このインスタンスにはプロンプトパッケージとしてエクスポートできる項目がありません。",
      ph: "プロンプトパッケージを選択",
      submit: "ライブラリへエクスポート",
    },
    skill: {
      title: "Skill を skill ライブラリにエクスポート",
      desc: "現在のインスタンスから skill を選び、skill ライブラリへ複製します（設定ページ「Skill 管理」で管理でき、他のインスタンスでも有効化できます）。",
      select: "skill を選択",
      empty: "このインスタンスには skill としてエクスポートできる項目がありません。",
      ph: "skill を選択",
      submit: "ライブラリへエクスポート",
    },
    submit: "エクスポート",
  },

  // 覆盖确认
  overwrite: {
    "title.package": "プロンプトパッケージを上書き",
    "title.skill": "skill を上書き",
    lib: {
      package: "プロンプトパッケージライブラリ",
      skill: "skill ライブラリ",
    },
    message: "あなたの{{lib}}に同名の「{{name}}」が既にあります。上書きするとライブラリ内の旧バージョンを削除し、現在のインスタンスのもので置き換えます。他のインスタンスに複製済みのコピーには影響しません。上書きしますか？",
    confirm: "上書き",
  },

  // 错误回退文案
  exportFail: "エクスポートに失敗",
  skillLoadFail: "skill 一覧の読み込みに失敗",
  packageLoadFail: "プロンプトパッケージ一覧の読み込みに失敗",
}
