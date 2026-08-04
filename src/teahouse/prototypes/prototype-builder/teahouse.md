# 实例配置

## 工作内容定义

你的主要任务是理解并细化用户的小说设定，依照用户要求修改前端沙盒代码及 CSS 样式，所有产出直接写入 `_prototype/` 目录，最终打包为一个新的原型。

## 核心工作流

1. 工作进度追踪文件为 `temp/milestones.yaml`，跨会话后先读此文件恢复进度
2. 与用户讨论细化设定，临时草稿和测试数据放入 `temp/`（根目录下唯一允许修改的目录）
3. 确认后，直接写入 `_prototype/` 下对应的目标文件
4. 修改沙盒代码时，直接在 `_prototype/.teahouse/output/sandbox/` 现有文件上修改
5. 前端渲染靠文件落盘（见下），测试数据从 `temp/` 写入 `_prototype/.teahouse/output/floors/` 的草稿文件即可预览
6. 打包前检查 `_prototype/` 下是否有未清理的无用占位符文件

## _prototype/ 目录

`_prototype/` 是一个完整可用的基础原型，即使不做任何修改也能打包使用。所有产出直接写入此目录。

```
_prototype/
├── teahouse.md                   ← 目标实例的配置文件
├── .teahouse/
│   ├── output/                   ← 正文 + 沙盒代码（文件系统驱动的唯一内容源）
│   │   ├── sandbox/              ← 沙盒渲染代码：bootstrap.js 最先、*.css、其余 *.js
│   │   │   ├── bootstrap.js
│   │   │   ├── page-bar.js
│   │   │   └── theme.css
│   │   └── floors/               ← 初始楼层：floor-001.md（开场白占位）
│   ├── runtime_vars.jsonl         ← 变量系统（文件即状态，SetVar/GetSandboxVars）
│   └── text-style-rules.yaml     ← 文本样式着色规则
├── settings/                     ← 设定文件：静态设定 + 动态设定（占位）
│   ├── characters.yaml
│   └── world.yaml
├── summary/                      ← 总结摘要（初始空）
├── temp/                         ← （原型内，预留）
├── assets/                       ← 静态资源
└── .gitignore
```

## 工作进度追踪

`temp/milestones.yaml` 是本实例的**活文档**，分为两部分：

1. **工作进度记录（tasks）**：由 AI 和用户在实际工作中动态维护。
   - 记录用户需求、当前进度、下一步计划、产生的临时文件等
   - 跨会话后，先读此文件恢复工作进度
   - 条目 status：`pending | in_progress | done | skipped | blocked`
   - 建议在 `files` 字段中记录关联的 `temp/` 临时文件，方便追溯

2. **建议工作流（suggested_workflow）**：参考性的原型搭建阶段列表。
   - 不应盲目按顺序执行，而应根据用户需求灵活调整
   - 实际执行顺序和内容由用户和 AI 自行决定

在开始任何工作前，先 Read `temp/milestones.yaml`。完成阶段性工作后更新 tasks 区域。

## 楼层配置

原型创作阶段无需此配置。

## 总结规则

原型创作阶段无需此配置。

## 正文展示与归档界

- **正文历史位于 `_prototype/.teahouse/output/floors/`**，靠文件名中间数字排序（`floor-5.md`、`floor-5-draft.md`），前端/沙盒自动按数字升序渲染，无需 label 概念。
- 半正式稿 `floor-N-draft.md` 即刻可见，满意后重命名 `floor-N.md` 定稿；每层唯一，返工就地覆盖。
- **章节标题放正文里**（`# 第X章 · 标题`），不再有 note 字段。
- 归档界 `summarized_to` 记录在 `_prototype/teahouse.md` 全局变量区，配合 `{{glob:output/floors/floor-*.md:lastN}}` 取上下文窗口。
- 旧的 `ep{N}` label 与 `.teahouse/output-blocks.jsonl` 已废弃，不要使用。

## 用户意图 → Skill 路由

当识别到用户以下意图时，使用 SkillRead 加载对应 skill 获取完整 SOP：

- 用户要求做前端 UI/修改沙盒/自定义界面 → `teahouse-sandbox-builder`
- 参考 BBCode 特效或管理文本样式着色来美化前端渲染 → `teahouse-sandbox-richtext-render`
- 用户要求导出原型/打包模板 → `teahouse-export-prototype`

## 创作 SOP

### 阶段 1：设定细化

1. 与用户对话，深入了解：故事类型、世界观框架、核心角色、叙事风格
2. 在 `temp/` 下创建草稿文件，记录讨论内容
3. 反复迭代直到用户满意
4. 在 `temp/milestones.yaml` 的 tasks 区域记录完成状态和产生的草稿文件路径

### 阶段 2：设定归纳

1. 阅读 `_prototype/settings/characters.yaml` 和 `_prototype/settings/world.yaml` 的注释了解格式规范
2. 将 `temp/` 下的草稿提炼为结构化的设定文件：
   - 字段需解耦，方便导演用占位符切片引用（`{{path|from="## section"|to="## next_section"}}`）
   - 字段值分行书写，方便 WriteLine 工具精确修改
3. 写入 `_prototype/settings/characters.yaml` 和 `_prototype/settings/world.yaml`
4. 在 `temp/milestones.yaml` 的 tasks 区域记录完成状态

### 阶段 3：变量系统确认

1. 明确本故事的变量载体统一在 `.teahouse/runtime_vars.jsonl`（文件即状态），由导演 `SetVar` 写、`GetSandboxVars` 读、沙盒 `setVar` 写。**不存在 `variables/` 目录**。
2. 与用户确认需要追踪的**变量**——仅限高度精炼、会频繁变动的数值/重要值（金币、修为、好感度、主角名等）。核心变量会注入导演系统提示词（no cache），导演与沙盒共享这份状态。
3. 明确如何划分**变量 vs 设定**：
   - **变量** → SetVar 管理。
   - **静态设定**（长期不变，如兄妹关系）→ `settings/`。
   - **动态设定**（中短期文字，如二人闹别扭、任务进展）→ 也放 `settings/`，靠后续工作流提示词区分、就地更新。
4. 在打包前，用 prototype-builder 的沙盒写入预设变量到 `.teahouse/runtime_vars.jsonl`（builder 的价值：打包前先写预设变量，运行时导演/沙盒直接读，无需运行时注入）。
5. 在 `temp/milestones.yaml` 的 tasks 区域记录完成状态

### 阶段 4：teahouse.md 编写

1. 阅读 `_prototype/teahouse.md` 了解格式，基于已确认的设定和变量系统进行修改：
   - 定义导演身份（描述为某种类型故事的导演，如"资深科幻小说家"）
   - 填写楼层配置（字数目标等）
   - 填写总结规则
   - 说明正文展示与归档界（`.teahouse/output/floors/` 文件名排序 + `summarized_to` 全局变量）
   - 填写 Generate Payload 配置文件的用法说明和工作流约定
   - 确认 skill 路由完整
2. 确保 `_prototype/settings/generate-config-default.yaml` 存在并根据故事类型调整模板内容
3. 在 `temp/milestones.yaml` 的 tasks 区域记录完成状态

### 阶段 5：前端自定义（可选）

1. 询问用户是否需要自定义前端界面
2. 如需要：
   - 参考 `teahouse-sandbox-builder` skill，直接在 `_prototype/.teahouse/output/sandbox/` 现有文件上修改
   - 把 `temp/` 下的测试数据写入 `_prototype/.teahouse/output/floors/` 的草稿文件，前端自动读取预览效果
   - `bootstrap.js` 是基础设施，一般不需要大改
   - `theme.css` 可按用户审美调整配色、字体、气泡样式
   - 如有特殊需求可创建额外的 `*.js` 组件
3. 如不需要，跳过此阶段
4. 在 `temp/milestones.yaml` 的 tasks 区域记录完成状态

### 阶段 6：文本样式规则（可选）

1. 确认是否需要符号着色（书名号、引号等）
2. 如需，在 `_prototype/.teahouse/text-style-rules.yaml` 中配置
3. 如不需要，跳过此阶段
4. 在 `temp/milestones.yaml` 的 tasks 区域记录完成状态

### 阶段 7：打包前检查

1. 确认 `_prototype/` 目录结构完整，所有必要文件就位
2. 检查并清理无用的占位符文件（如未被替换的模板文字、未使用的空文件等）
3. 建议用户用此原型创建一个新实例，跑通流程：
   - 加载设定是否正常
   - 变量系统是否按预期工作
   - 沙盒渲染是否正常
4. 发现问题则回到对应阶段修复
5. 在 `temp/milestones.yaml` 的 tasks 区域记录完成状态

### 阶段 8：打包导出

1. 使用 `teahouse-export-prototype` skill 将 `_prototype/` 导出为 .teabrew
2. 在 `temp/milestones.yaml` 的 tasks 区域记录完成状态

## 重要规则

### Git 版本管理

合理使用 git 进行版本管理：
- **沙盒代码迭代前先 commit**，验证通过后再 commit 锁定，改坏可回退
- **设定文件大规模调整前先 commit**
- **每完成一个阶段 commit 一次**，在 milestones tasks 中记录 commit hash
- 提交类型使用 `other`，message 内加前缀区分：`style:` / `feat:` / `fix:`（沙盒代码）、`content:`（设定）、`vars:`（变量）

### 目录访问权限

| 目录 | 权限 | 说明 |
|---|---|---|
| `temp/` | 读写 | 唯一允许修改的根目录，存放草稿、测试数据、进度文件 |
| `_prototype/` | 读写 | 所有产出直接写入此目录 |
| 其他根目录文件 | 只读 | 不可修改 |

### 路径基准说明

- **沙盒代码路径**：`_prototype/.teahouse/output/sandbox/*.js|*.css`，渲染器按文件名分派（bootstrap.js 最先、*.css 注入 head、其余 *.js 追加）。
- **初始楼层路径**：`_prototype/.teahouse/output/floors/floor-001.md`，导出后成为新实例的正文历史起点。
- **出后实例的正文/设定占位符**：`{{glob:output/floors/floor-*.md:lastN}}`、`{{settings/characters.yaml|from=...}}`（相对新实例根目录）。
- **打包时**：`_prototype/` 内的路径保持不变，`temp/` 下的测试数据不打包。

### 注意事项

- 设定文件字段需解耦，方便导演用占位符切片引用
- 变量值分行书写，方便 WriteLine 工具精确修改
- 所有产出直接写入 `_prototype/`，无需先在根目录草稿再复制
- `temp/` 仅用于创作过程中的临时草稿和测试数据
- `_prototype/` 下的占位符文件在打包前需检查清理
