# 实例目录结构（固定，只改内容、不挪结构）

Teahouse 实例根目录是**扁平化、语义化**的固定结构。以下目录与文件的**路径是引擎约定死的**——对创作者而言，可编辑的是**这些位置里的内容**，而不是结构的本身。类比"代码写进 `src/`"：把文件放对地方，导演、沙盒、正文生成、总结、打包才能按约定找到它们。

```
实例根/
  teahouse.md           实例配置：工作内容定义 + Skill 路由。始终实时注入导演上下文。
  README.md             实例说明文档（对创作者/玩家）。
  cover.jpg             封面图（可选，根目录取名即被识别）。
  .gitignore            常见 `.sessions/` `temp/`（不入 git）；随实例提交。
  prototype.json        原型包元数据（引擎打包/导入时生成与读取的 JSON，根目录）。

  runtime/              游戏运行时 —— 直接影响游玩的一切
    floors/             floor-N.md（定稿）/ floor-N-draft.md（半正式稿）正文历史
    sandbox/            UI / 场景脚本 *.js *.css（input-bar.js、page-bar.js、var-editor/ 等组件）
    assets/             二进制资源（封面/背景/字体/音频等），沙盒 用 readAsset 读
    runtime_vars.jsonl  变量「文件即状态」：一变量一行 jsonl，SetRuntimeVar 写、GetRuntimeVars 读
    text-style-rules.yaml 文本样式着色规则（符号着色，导演经 richtext skill 编辑）

  settings/             作者设定与组装
    assemble.md         正文生成组装器（中转承载设定与生成要求，yaml 整文件引用它）
    dyn_settings/       动态设定：随剧情变动的中短期文字状态，入 git，总结产出
    static_settings/    静态设定：长期稳定背景（世界观、模板），入 git，只读引用
    key-vars.md         作者维护的变量清单示例：正文 AI 需要看到并维护的变量

  generate-config/      正文生成 / 正文补全的配置文件（薄壳，引用 {{settings/assemble.md}}）
    generate.yaml       生成下一章的 Payload 配置
    continue.yaml       续写补全草稿的 Payload 配置

  summary/              总结区
    sum-*.md            总结流水账（导演回溯参考，不进正文 Bot 上下文）
    index.json          归档界索引（summarized_through，由后端 GitCommit 自动维护）
    summarize-prompt.md 总结子会话任务提示词（被 input-bar 经 readText 读取）

  skills/               实例自建 Skill（提示词包，同名覆盖系统内置 skill）
  temp/                 （不入 git）草稿/中间文件，子会话 Report 只写这里
  building/             （永不进原型包）打包期元工作区：点子/checklist/设计笔记
```

## 被引用的文件（引用关系图谱）

引擎**按路径直接引用**的文件，名字固定为英文，改文件名会断开对接：

| 文件 | 谁引用它 | 引用方式 |
|---|---|---|
| `runtime/sandbox/*.js` 与 `*.css` | 前端沙盒 iframe | `*.js` 追加挂载、`*.css` 注入 `<head>`；bootstrap.js 由引擎注入，勿自建 |
| `runtime/sandbox/input-bar.js` | 前端（页面挂载） | 底部输入条组件 |
| `runtime/sandbox/var-editor/important-vars.json` | `var-editor.js` | readText 读取重要变量清单 |
| `runtime/floors/floor-N.md` / `floor-N-draft.md` | 前端 + 正文生成 | 文件中间数字排序展示；Generate 落盘草稿、commitDraft 转正 |
| `runtime/runtime_vars.jsonl` | 引擎 SetRuntimeVar / GetRuntimeVars | 文件即状态，权威变量源 |
| `runtime/text-style-rules.yaml` | 前端 renderRichText | 符号着色 |
| `generate-config/generate.yaml` | `runtime/sandbox/input-bar.js` | `source_file` 直接指向；Generate 读它组织正文请求 |
| `generate-config/continue.yaml` | `runtime/sandbox/input-bar.js` | `CONT_YAML` 常量指向；续写补全 |
| `generate-config/generate.yaml` 与 `continue.yaml` | 二者内部 | `{{settings/assemble.md}}` 整文件引用组装器 |
| `settings/assemble.md` | 两个 generate-config yaml | `{{settings/assemble.md}}` 展开 |
| `settings/assemble.md` 内部 | | `{{settings/static_settings/chapter-requirements.md}}`、`{{settings/static_settings/world.md}}`、`{{settings/dyn_settings/characters.md}}`；变量维护（注释内）`{{settings/static_settings/variable-ops.md}}`、`{{settings/key-vars.md}}` |
| `summary/summarize-prompt.md` | `runtime/sandbox/input-bar.js` | `SUMMARIZE_PROMPT` 常量，经 `Teahouse.readText()` 读取后派发总结子会话 |
| `summary/index.json` | 后端 `GitCommit(type="summary")` | 自动维护归档界；总结子会话 Read 它确认起点 |
| `teahouse.md` | 引擎 | 始终注入导演系统提示词 |

> 占位符 `{{path|切片}}` 是**后端解析面**（Generate 发送前、导演 Write/Edit 写文件时展开），路径一律相对实例根目录。
> 沙盒脚本里的运行时读文件用 **`Teahouse.readText(path)` / `readAsset(path)`**（相对实例根，任意路径），不是 `{{}}`。

## 语义边界（哪些归谁）

- **游玩会直接反映的改动**（改完立刻影响画面/剧情）→ `runtime/`（沙盒、楼层、变量、着色规则）。
- **支撑游玩但不定格在某个画面**的改动 → `settings/`（设定与其引用关系）。
- **正文模型怎么组织上下文** → `generate-config/`（薄壳）+ `settings/assemble.md`（组装器）。
- **引擎静默维护、创作者只读或经工具改** → `summary/index.json`、`runtime/runtime_vars.jsonl` 的写、`prototype.json`。

> ⚠️ 被上面表格引用的文件改名 = 破坏引擎对接；同理 `runtime/`、`settings/`、`generate-config/`、`summary/`、`skills/` 这些顶层目录名不可改。要定制作品，请**改这些位置里的内容**。
