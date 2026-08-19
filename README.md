# Teahouse

基于 Harness Engineering 思想的小说创作 / 即时文字冒险引擎。

创作者从「原型」出发，实例化出独立的「实例」存档，导演（Director）驱动 LLM 逐楼层写作，产出正文与沙盒渲染，并为每个实例内置 git 版本控制与剧情分支。

## 技术栈

**后端**
- Python 3.11+，FastAPI + SSE（Server-Sent Events）流式 / 事件广播
- SQLite + aiosqlite 异步数据库
- JWT 认证（bcrypt + HS256），LLM API key 用 Fernet 加密存储

**前端**
- Vite + React 19 + TypeScript
- shadcn/ui（基于 Radix + Tailwind CSS v4）
- Zustand 状态管理 + React Router
- 桌面（≥1081px）与移动端（≤1080px）两套布局

## 目录结构

```
teahouse/                主仓库
├── src/teahouse/        后端（FastAPI 应用 + 导演引擎 + 插件运行时）
├── teahouse-frontend/   前端（Vite + React）
├── plugins/             全局插件模板
├── docs/                文档
├── data/                运行期生成的实例数据（gitignore）
└── *.bat                启动脚本
```

## 环境准备

- **后端**：Python 3.11+，创建虚拟环境并安装依赖

  ```bash
  python -m venv .venv
  .venv\Scripts\activate        # Windows；macOS/Linux 用 source .venv/bin/activate
  pip install -e ".[dev]"
  ```

- **前端**：Node.js + pnpm（**严禁混用 npm**）

  ```bash
  cd teahouse-frontend
  pnpm install
  ```

## 启动

首次运行会自动生成 `teahouse.yaml`（JWT secret / master key / 超级管理员密码）。超级管理员用户名固定为 `admin`，密码唯一记录在 `teahouse.yaml` 的 `auth.admin_password`（首次随机生成，启动时以 yaml 为准覆盖库中密码），默认不开启注册（`auth.allow_registration`）。

### 生产模式（单端口，推荐）

后端托管已构建的前端。默认只绑定 `127.0.0.1`（本机访问，更安全）；需要局域网 / 手机访问时，把 `teahouse.yaml` 的 `server.host` 改为 `0.0.0.0`：

```bash
run-server.bat          # 用现有 dist 启动
run-server.bat --build  # 先构建前端再启动
```

### 开发模式（前后端分离）

两个终端分别启动：

```bash
dev-backend.bat         # 后端（--reload），默认 8888
dev-frontend.bat        # 前端 Vite dev 服务器，5173 端口
```

## 使用流程

1. 用 `teahouse.yaml` 中 `auth.admin_password` 的超级管理员密码登录账号 `admin`，前往「设置」配置 LLM API key 与模型。
2. 在首页导入或创建**原型**，或直接基于原型**实例化**出一个实例。
3. 进入实例开始**游玩**：导演驱动 LLM 写作，逐楼层推进；左侧「返回大厅」随时退出。
4. 楼层完成可触发 git 提交，支持分支切换实现剧情分叉存档。

## 文档

- `CLAUDE.md` — 项目内部约定、核心概念（原型 / 实例 / Skill / 总结）、占位符语法、移动端适配规范
- `docs/plugin-ui-guide.md` — 插件声明式配置 UI 指南
- `plugins/README.md` — 插件模板结构与安装方式
