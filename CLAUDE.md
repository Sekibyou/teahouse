# Teahouse

基于 Harness Engineering 思想的小说创作/即时文字冒险引擎。

> **⚠️ 禁止自动启动服务**
> 禁止 Claude 自动启动前端或后端服务。用户有自己的运行环境。
> 如果需要测试、查看日志或验证功能，请直接要求用户参与测试或提供 log。

## 工作语言

与用户沟通时请使用简体中文

## 技术栈

### 后端
- Python 3.x, venv 虚拟环境
- FastAPI + SSE (Server-Sent Events) 对外广播
- SQLite + aiosqlite（异步数据库）
- JWT 认证（bcrypt + HS256）
- YAML 配置文件，jwt-secret / master-key 首次运行自动生成

### 前端
- **Vite + React 19** 构建
- **shadcn/ui** 组件库（基于 Radix + Tailwind CSS v4）
- **Zustand** 状态管理 + persist 中间件
- **React Router** 路由（布局层路由守卫）
- **Tailwind CSS v4** + OKLCH 色彩空间 + 暗黑模式
- **pnpm** 进行包管理，严禁混用npm
- **⚠️ 禁止使用浏览器原生弹窗**（`alert`、`confirm`、`prompt`），一律使用 `ConfirmDialog` 组件（`@/components/ConfirmDialog`）

## 项目定位

可嵌入库（核心逻辑封装为库，同时也提供独立服务模式入口）。

## 核心概念

| 概念 | 说明 |
|---|---|
| **原型 (Prototype)** | 创作者设计的 `.teabrew` 包，本质是zip压缩文件，类似酒馆的角色卡。**导出源 = 实例根本身**：在实例上就地清理测试数据后打包（自动排除 `building/`、`.git/`、`sessions/` 等内部目录），而非维护某个 `_prototype/` 镜像目录 |
| **实例 (Instance)** | 原型解压后独立运行的存档 |
| **building/** | 实例内的**打包期元工作区**（讨论点子、checklist、设计笔记）。导出自动排除、不进原型包；目录树中默认隐藏。首页「复制实例」可生成完整快照副本，用作就地清理打包前的保底 |
| **Skill** | 提示词包（方法论），引用 teahouse.md 的配置 |
| **楼层 (Floor)** | 独立内容单元，对应 `.md` 文件，完成后 git commit |
| **总结 (Summary)** | 触发 git commit + 上下文重组，不计入楼层。产出：更新 `settings/` 设定 + `runtime_vars.jsonl` 变量 + 根 `summary/sum-N-M.md` 流水账（导演回溯用，不进正文 Bot 上下文）。**归档界（已总结到第几章）由后端在 `GitCommit(type="summary", start, end)` 时自动写入根 `summary/index.json` 的 `summarized_through`**，导演无需手改 `teahouse.md` |
| **导演 (Director)** | 执行编排流程的 AI 主体，通过工具集操作文件系统 |
| **teahouse.md** | 每个实例一份的配置，始终实时注入导演上下文 |
| **变量 (Runtime Var)** | `.teahouse/runtime_vars.jsonl` 里每行一个变量，文件即状态。导演 `SetRuntimeVar` 写、`GetRuntimeVars` 读；核心变量注入导演系统提示词（no cache） |
| **`.teahouse/` 目录** | **引擎内部 + 沙盒运行时** 目录。存放与运行、展示、状态相关的引擎内容：`output/`（`floors/` 正文历史、`sandbox/` 沙盒渲染代码）、`runtime_vars.jsonl`、`text-style-rules.yaml` 等。**区别于** `settings/`（yaml 内容设定，非代码）、`floors/`（已提交正文归档）。**输出即状态**：放文件进 `output/sandbox/`（bootstrap.js / \*.css / \*.js）即作为玩家可见的沙盒渲染，放 `output/floors/` 即作为正文历史。沙盒「确定批处理」用 `runTool(steps)`——内联工具数组、**即发即返**（返回 `run_uuid`，在后台串行执行，每步经 `tool_run` 事件广播结果与成败，组件按 `run_uuid` 数 `index` 判完成），不依赖脚本文件；产出落地经 `file_changed` → `output.refresh` 刷新楼层。**`Generate` 流式在生成中不落盘**，仅经 `generate_progress` 事件广播累计进度（含 diff），结束/中断/报错才落盘并广播一次 `file_changed`。导演侧若要引用 `.jsonl` 流程可用 `BatchExecute`。 |

## 占位符语法

实例配置/提示词/工具内容里使用四种占位符，语义互不混淆：

| 语法 | 含义 | 在哪里解析为值 |
|---|---|---|
| `{{path\|切片}}` | **文件切片**（复制/搬运，不修改内容），如 `{{settings/characters.yaml\|from="## 秦悠"}}`、`{{glob:output/floors/floor-*.md:last30}}` | Write/Edit/WriteLine 显式 `resolve_placeholders=true`；系统提示词/预设模板（lenient，文档示例保持字面量） |
| `${name}` | **普通变量引用**（沙盒变量），如 `${金币}`、`${user_name}` | 导演系统提示词组装 + Generate 发送给正文 AI 前（酒馆式展开为值）；沙盒内手动 `Teahouse.replacePlaceholders()` 替换 |
| `${ if...: return... }` | **条件切片**（代码块），按变量值就地选一段返回，如 `${ if dice == 6: return "{{room1}}" else: return "{{room2}}" }` | 所有 AI 表面（导演系统提示词组装 + Generate），解析阶段就地选分支；块内可用白名单函数 `roll("1d6")` / `random(lo, hi)`；坏块回退字面量不报错 |
| `${teahouse.xxx}` | **系统内部值**，如 `${teahouse.behavior}`、`${teahouse.tools_usage}`、`${teahouse.file_tree}`、`${teahouse.available_skills}` | 仅导演系统提示词预设模板组装时临时注入；其余场景因不在变量文件里，走"不存在→原样"天然不泄露 |

规则：
- `${}` 严格匹配 `\${...}`；裸 `$` 不处理。**变量不存在 → 原样显示**（不报错、不删）。
- `teahouse.` 前缀为系统保留命名空间，setVar/SetRuntimeVar 禁止用其命名（会告警忽略）。
- 喂给 AI（系统提示词、Generate）的内容替换 `${}` + 展开 `{{}}`；`Write/Edit/WriteLine`（文件编辑）只做 `{{}}` 切片、不解变量。
- **变量名禁止空白**（空格/tab/换行）：代码块用 `if dice == 6` 引用变量需作合法 Python 标识符，写含空白变量名会被 SetRuntimeVar / 沙盒 setVar 拒绝。



## 认证

API 请求需携带 `Bearer <JWT>` token。首次运行自动创建默认管理员账号 `admin / teahouse2025+.Aa`。
用户可通过 `/api/auth/login` 获取 token，用于后续请求。
LLM API key 加密存储（Fernet）在数据库中，与用户绑定。`teahouse.yaml` 只存储 JWT signing key 和加密用的 master key。

## 核心工作流

```
用户输入
  │
  ▼
[后端组织上下文]
  ├─ 导演判断需要引用哪些设定
  ├─ 加载正文 skill
  ├─ 加载变量
  └─ 调用正文 skill 写作
        │
        ▼
[正文 skill 创建/编辑楼层文件]
        │
        ▼
[导演写入 output/floors / output/sandbox 触发渲染]
        │
        ▼
[前端渲染 output/ 内容]
        │
        ▼
用户选择:
  ├─ "修改此楼"
  │     ├─ 用户提出调整要求（补全、修复、重写）
  │     ├─ 导演重新调用正文 skill + 附上要求
  │     ├─ 正文 skill 对当前楼层文件执行 Edit
  │     └─ 导演再次写入 output/ 触发新内容渲染
  │     └─ 前端重新渲染
  │     └─ 可循环多次，直到用户满意
  │
  └─ "下一楼层"
        ├─ 楼层完成 → git commit
        ├─ 楼层计数 +1
        ├─ 导演回到准备阶段：
        │   ├─ 判断需不需要补设定
        │   ├─ 判断哪些设定可移除（不再需要）
        │   └─ 生成新的楼层
        └─ ...
```

## 输出机制（文件即状态）

玩家可见的输出**放入实例的 `.teahouse/output/` 目录，文件即状态**：

- `output/sandbox/`（bootstrap.js / \*.css / \*.js）—— 沙盒渲染，放进去即生效
- `output/floors/`（floor-N.md 等）—— 正文历史

第三方前端可通过 API 自由选择显示策略（比如 QQ 桥接只转发 floor 文本，游戏引擎接入则处理 `output/sandbox/` 的沙盒渲染）。

## 前端

自带 React + Vite 前端，提供：
- API key / secret key / LLM models 管理
- 原型和实例管理
- 游玩界面 —— 只渲染 `output/`（沙盒/正文）内容，显示原始或渲染后文本
- 调试界面 —— 显示工具调用详情与 LLM 思考过程（类似 Claude Code CLI 的 VSCode 插件模式）
- "修改此楼" / "下一楼层" 按钮，明确指示导演当前意图

第三方可通过 API 自行编写前端（QQ 桥接、Web 前端、游戏引擎接入等）。

## 移动端 / 窄屏适配

前端同时支持**桌面宽屏（≥1081px）**和**窄屏（≤1080px，含竖屏平板/笔记本）**两套布局。

### 核心约定

- **顶层变量切换**：用 `useIsMobile()`（`@/hooks/useMediaQuery`，基于 `(max-width: 1080px)`）在 JS 层面分支，而非纯 CSS 断点。交互差异大，很多组件需写两份渲染（`isMobile ? <MobileVariant /> : <DesktopVariant />`）。
- **移动端无全局顶栏**：`MainLayout` 在 `isMobile` 时只渲染纯背景壳，不渲染桌面顶栏。所有导航/操作入口转移到具体页面的悬浮球或菜单。
- **全屏面板模式**：设置、导演栏、Git 版本控制等桌面端的侧栏/弹窗，在移动端改为**全屏页面**，带自己的导航栏（`h-10`）+ 返回按钮（`ChevronLeft` 图标）。此类全屏面板须用 `absolute inset-0 z-50` 容器包裹，并常驻挂载以保持 SSE 连接。
- **SSE 连接**：游玩（OutputPanel）与导演（ChatPanel）的面板**始终挂载**，非活跃时用 CSS `display:none` 隐藏，不能卸载。

### 各页面布局要点

**MainLayout.tsx**：`isMobile` 时仅渲染 `<main class="flex-1 overflow-auto"><Outlet context={{ isMobile, toggleTheme }} /></main>`，通过 Outlet context 向下传递 `isMobile` 和 `toggleTheme`，子页面用 `useOutletContext()` 读取。

**WorkspacePage.tsx（核心）**：移动端用悬浮球替代常驻面板——
- 主区域：游玩模式显示 `OutputPanel`（沙盒）全屏；后台模式显示**简化 textarea 编辑器**（不用 Monaco，无 diff 追踪）。
- **左上悬浮球**（仅后台模式，File 图标）：点开半屏文件树浮层（左侧 `w-[75%] max-w-[320px]`，点击右侧空白关闭）。文件树 `FileTreeView` 传 `isMobile` prop 加大触控目标（`py-3`）。
- **右上悬浮球**（常驻，模式名 + 汉堡菜单）：下拉菜单含 游玩/后台 Switch、版本控制、设置、主题切换、退出到主页。
- **左下悬浮球**（常驻，MessageCircle 图标）：触发**全屏导演栏**（ChatPanel 全屏 + 导航栏返回）。
- 全屏面板状态用 `fullscreenPanel: "director" | "settings" | "git" | null` 管理。

**SessionSelectPage.tsx**：移动端顶部 "原型/实例" tab 切换 + 全宽列表 → 选中进入**全屏详情页**（`MobileProtoDetail` / `MobileInstanceDetail`，带返回按钮），类似 master-detail。底部放操作按钮（开始会话/继续会话）。

**SettingsPage.tsx / PluginsSettingsPage.tsx**：移动端为全屏页面，`h-10` 导航栏 + `ChevronLeft` 返回。tab 栏加 `overflow-x-auto` 允许横向滚动。LLM 管理弹窗（`LLMManagementDialog`）在移动端用 `absolute inset-0` 全屏容器包裹。

**ChatPanel.tsx**：结构不变，移动端在全屏容器内渲染即可。发送按钮注意触控尺寸（≥44px）。

### 桌面拖拽手柄

ChatPanel 的拖拽调整已从 `mousemove`/`mouseup` 改为 `pointermove`/`pointerup` + `touch-action: none`，兼顾触控设备。

### 全局 CSS（globals.css）

- `html, body, #root { overscroll-behavior: none }` — 阻止移动端下拉刷新
- `.pb-safe` / `.pt-safe` — 处理 iPhone 刘海屏安全区，加到全屏面板底部

### 约定

**新增或修改页面时**：若涉及两套布局，优先用 `useIsMobile()` 分支而非仅加 CSS class；新 UI 触发按键必须 ≥44px 触控目标；不要卸载会建立 SSE 的面板。

## 实例版本控制 (Git)

每个实例创建时自动执行 `git init` + 初始 commit。实例是一个独立的 git 仓库，与主仓库隔离。

### Git 工具

导演可通过 `GitCommit` 和 `GitBranch` 两个工具操作版本控制：

- **GitCommit(message)**：`git add -A && git commit`，锁定实例所有文件状态。楼层完成/总结结束时自动调用（通过提示词约定）。
- **GitBranch(action, name?)**：分支管理。`list` 列出所有分支，`create` 创建新分支，`switch` 切换分支，`delete` 删除分支。

### 调用时机

- **楼层完成时**：导演调用 `GitCommit("floor-NNN: 简单描述")`
- **总结完成时**：导演调用 `GitCommit("summary-NNN: 描述")`
- **用户手动**：用户可通过前端按钮或对话要求提交
- **分支操作**：由用户手动控制（前端 UI 或对话中要求导演执行）

### 切换分支的特殊说明

`GitBranch switch` 切换分支时会改变实例目录下所有被 git 追踪的文件（`floors/`、`.teahouse/runtime_vars.jsonl`、`settings/` 等）。切换后：
1. 当前对话的上下文（messages）保留在前端 localStorage 中，导演不会失忆
2. 下一次系统提示词组装时会自动读取目标分支的文件状态
3. 如需查看旧分支的楼层文件，可用 `Read` 工具加路径前缀（如果能拿到具体路径），或者切回去查看

### 技术约束

- **依赖 git**：运行环境必须安装 git 并可在 PATH 中访问
- **不需要 merge**：分支是 AVG 式的剧情分支存档，不做合并
- **sessions/ 不纳入版本控制**：对话历史由前端 localStorage 管理

## 提示词组装

导演（Director）的系统提示词由 `director_system.py` 的 `assemble_system_prompt()` 动态组装，包含以下组件：

```
1. 实例 teahouse.md               — 直接注入（角色定义、配置、Skill 路由）
2. director-system/behavior.md   — 行为准则
3. tools.json usage 文本          — 由调用方从 tools.json 生成后传入
4. 实例目录树                      — 动态扫描，所有目录只显示一行（不展开），floors/ 有特殊统计信息
5. Skill 列表                      — 扫描系统 skills + 实例 skills，解析每个 SKILL.md 的 name + description；实例 skills 可覆盖同名系统 skill
```

**注意**：顺序是固定的——teahouse.md 在最前面，是创作者的主要定制入口。

### tools.json — 工具定义的唯一数据源

`director-system/tools.json` 是所有导演工具的**唯一数据源**，同时驱动两套输出：

| 输出 | 函数 | 用途 |
|---|---|---|
| OpenAI function calling schema | `load_tools()` (tools.py) | 传给 LLM API 作为可调用工具列表 |
| 自然语言使用指南 | `load_tools_usage()` (tools.py) | 生成文本后传入 `assemble_system_prompt()`，注入导演系统提示词 |

每个 tool 条目包含：
- `name` / `description` / `parameters` — 标准 function calling schema
- `usage`（可选）— 额外的使用指南、最佳实践、注意事项，注入系统提示词

**添加或修改工具时只需编辑 `tools.json`**，两套输出会自动同步。工具执行器（executor）仍需在 `tools.py` 中注册到 `TOOL_EXECUTORS` 字典。

## 实例目录结构

每个实例在 `data/<user>/instances/<id>/` 下，结构如下：

```
teahouse.md          实例配置文件，始终实时注入导演上下文
settings/            设定文件夹（角色、世界观等）
  characters.yaml
  world.yaml
building/            打包期元工作区（讨论点子、checklist、设计笔记）——永不进原型包
skills/              Skill 包，每个子目录一个 Skill
  <skill-name>/
    SKILL.md          Skill 元数据 + 完整指令（Load 阶段读取）
    examples/         可选，示例文件
    references/       可选，参考文档
    scripts/          可选，可执行脚本
.teahouse/            引擎内部目录
  runtime_vars.jsonl   变量系统（文件即状态，SetRuntimeVar/GetRuntimeVars，一变量一行 jsonl，可带 note/change_log）
  output/
    floors/           正文历史（floor-N.md 定稿 / floor-N-draft.md 半正式稿）
    sandbox/          沙盒渲染资源
      bootstrap.js    沙盒基础设施脚本
      *.js            场景/UI 脚本
      *.css           样式文件
  text-style-rules.yaml  文本样式着色规则
floors/              正文楼层 + 总结（归档，commit 后不可变）
  floor-001.md        正文楼层，编号递增
  sum-001.md          总结归档（与楼层编号独立）
summary/             汇总流水账（导演回溯参考，不进正文 Bot 上下文）
  sum-1-7.md          覆盖第 1~7 章的流水账（覆盖 x~y 章 → sum-x-y.md；单章 → sum-x.md）
  index.json          归档界索引（代码自动维护：summarized_through + entries）
temp/                临时文件夹，存放草稿等中间文件
  draft.md            未完成草稿（续写用）
assets/              静态资源（图片、字体、音频等）
```

**导出为原型 = 打包实例根本身**：导出前在实例上就地清理测试数据（楼层只留开场楼、变量裁成开局子集、泛化 teahouse.md），后端打包时自动排除 `building/`、`.git/`、`sessions/` 等内部目录。这是**业务判断**，不由代码自动过滤。若想把当前进展留作可继续玩的存档，先在首页对实例点「复制」生成完整快照副本，再在副本上清理打包。

### 目录树显示规则

系统提示词中通过 `_scan_tree()` 动态注入目录树，规则如下：

- 所有目录都**只显示一行目录名**（不展开），如 `├── settings/`、`├── skills/`
- `floors/` 显示特殊统计信息，如 `floors/  (Latest floor: 009 (9 floors); Last summary covered floors 1~5; 4 floors unsummarized)`
- 根目录文件逐行列出
- 排除 `.git`、`__pycache__`、`sessions`、`building` 等内部/元工作目录

需要深入探索时通过 Glob 工具按需查看。
