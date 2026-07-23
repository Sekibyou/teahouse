# Teahouse

基于 Harness Engineering 思想的小说创作/即时文字冒险引擎。

> **⚠️ 禁止自动启动服务**
> 禁止 Claude 自动启动前端或后端服务。用户有自己的运行环境。
> 如果需要测试、查看日志或验证功能，请直接要求用户参与测试或提供 log。

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

## 项目定位

可嵌入库（核心逻辑封装为库，同时也提供独立服务模式入口）。

## 核心概念

| 概念 | 说明 |
|---|---|
| **原型 (Prototype)** | 创作者设计的 `.zip` 包，类似酒馆的角色卡 |
| **实例 (Instance)** | 原型解压后独立运行的存档 |
| **Skill** | 提示词包（方法论），引用 teahouse.md 的配置 |
| **楼层 (Floor)** | 独立内容单元，对应 `.md` 文件，完成后 git commit |
| **总结 (Summary)** | 触发 git commit + 上下文重组，不计入楼层 |
| **导演 (Director)** | 执行编排流程的 AI 主体，通过工具集操作文件系统 |
| **teahouse.md** | 每个实例一份的配置，始终实时注入导演上下文 |
| **fc("输出")** | 输出 fc，指定文件内容作为玩家可见的输出 |

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
[导演调用 fc("输出") 输出楼层内容]
        │
        ▼
[前端渲染输出内容]
        │
        ▼
用户选择:
  ├─ "修改此楼"
  │     ├─ 用户提出调整要求（补全、修复、重写）
  │     ├─ 导演重新调用正文 skill + 附上要求
  │     ├─ 正文 skill 对当前楼层文件执行 Edit
  │     ├─ 导演再次 fc("输出") 新内容
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

## fc("输出") 机制

所有 function call 都会通过 SSE 广播给前端。前端决定显示策略：

- **游玩模式**：只处理 `fc("输出")`，渲染其指定的文件内容（纯文本，不特殊渲染）
- **调试模式**：显示所有 fc——Read 了什么文件、Edit 了什么文件、Write 了什么文件、fc("输出") 了什么内容，以及 LLM 思考过程等

第三方前端可通过 API 自由选择显示策略（比如 QQ 桥接只转发输出内容，游戏引擎接入则可能处理富文本）。

## 前端

自带 React + Vite 前端，提供：
- API key / secret key / LLM models 管理
- 原型和实例管理
- 游玩界面 —— 只处理 `fc("输出")`，显示原始文本
- 调试界面 —— 显示所有 fc 详情、LLM 思考过程（类似 Claude Code CLI 的 VSCode 插件模式）
- "修改此楼" / "下一楼层" 按钮，明确指示导演当前意图

第三方可通过 API 自行编写前端（QQ 桥接、Web 前端、游戏引擎接入等）。

## 文档

详细设计文档见 [docs/](docs/) 目录。
