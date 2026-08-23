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
├── data/                用户数据根（实例/DB 等运行期数据，gitignore；位置由 teahouse.yaml 的 workspace_base 指定，支持绝对路径放别处）
└── *.bat                启动脚本
```

## 从 Release 安装（预构建产物，无需源码 / 编译）

不想搭开发环境的普通用户，直接下载 GitHub Release 的预构建小包即可：

- **包皆为便携式**：解压后即可运行，不写系统路径、不装服务、不动注册表。
- **版本号**：以下示例用当前 `v1.01`。发布页（<https://github.com/Sekibyou/teahouse/releases>）可看到更新的 tag，把命令里的 `v1.01` 换成最新 tag 即可。
- **检查电脑/手机架构**：`uname -m`（Windows 用 `echo %PROCESSOR_ARCHITECTURE%`）。通常 amd64/aarch64；选错架构的包启动不了。

### Windows

1. 下载 `Teahouse-1.01-Windows-with-git.zip`（全新用户，内含 git）——若是升级旧版，用 `Teahouse-1.01-Windows.zip`（不含 git，体积更小）。
2. 解压到任一目录（如 `D:\Teahouse`）。
3. 双击 `Teahouse.exe` 即启动，浏览器会自动打开游玩界面。
4. 首次运行会自动生成 `teahouse.yaml`（含随机 super admin 密码，见控制台输出）与 `data/`。

**更新**：新版号出了，下载同名 zip 解压，把 `Teahouse.exe` / `_internal/` / `dist.zip` / `dist.hash` 四个文件**覆盖**到旧目录即可。**不要删** `teahouse.yaml` 与 `data/`（你的密码、原型、实例全在里面）。启动时前端会按 `dist.hash` 自动校验并复用/重建 `dist/`，无需手动处理。

### Linux（含 ARM 服务器 / 树莓派等）

**一键安装**（自动探测架构 + 取最新版本 + 下载解压 + 启动；精简版，不装运行依赖——PyInstaller 包已捆绑完整运行时，绝大多数环境开箱即跑）：

```bash
curl -fsSL https://raw.githubusercontent.com/Sekibyou/teahouse/main/scripts/install-lite.sh | bash
```

> 没 curl 先 `apt install -y curl`。脚本默认直接解压到**当前目录**（不额外套一层 Teahouse/ 子文件夹）——先 `cd` 到自己想放的地方（建议 `mkdir -p ~/apps && cd ~/apps`）再跑命令；想装进别的目录用 `TEAHOUSE_DIR=/opt/teahouse bash ...`；想指定版本 `TEAHOUSE_VER=1.01 bash ...`。装完自动 `exec ./Teahouse`，Ctrl+C 停止；想后台跑：`nohup ./Teahouse > server.log 2>&1 &`。
>
> 若启动报缺库（罕见，多见于精简 ARM 环境），改用完整版脚本会额外安装 glibc 运行库：`curl -fsSL https://raw.githubusercontent.com/Sekibyou/teahouse/main/scripts/install.sh | bash`。

**手动方式**（不引脚本时，Linux 全架构通用）：

```bash
ARCH=aarch64   # 或 x86-64（uname -m 确认）
VER=1.01
wget "https://github.com/Sekibyou/teahouse/releases/download/v$VER/Teahouse-$VER-Linux-$ARCH.tar.gz"
tar -xzf "Teahouse-$VER-Linux-$ARCH.tar.gz"
cd Teahouse
apt install -y libpython$(python3 -c 'import sys;print("%d.%d"%sys.version_info[:2])')-dev   # Debian/Ubuntu；Fedora 用 dnf install python3-devel
chmod +x Teahouse
./Teahouse
```

**更新**：下新版 tar.gz，解压覆盖 `Teahouse` / `_internal/` / `dist.zip` / `dist.hash` 即可，保留 `teahouse.yaml` 与 `data/`。

### 手机（Termux + proot Debian，推荐方案）

无 root 也能跑。**手机端先准备 proot 环境（一次性），真正安装进 Debian 后用上面的 Linux 一键脚本**，两者复用同一条 `install-lite.sh`。

Step 0 — 前置：手机已装 [Termux](https://termux.com)，并能联网。

Step 1 — Termux 层，装 proot-distro 并进入 Debian：

```bash
pkg install proot-distro

uname -m            # 确认架构：aarch64 为手机主流；x86 平板会显示 x86_64（脚本自动识别）
proot-distro install debian
proot-distro login debian   # 进入 Debian 环境，此后所有命令都在这一层
```

Step 2 — Debian 层，一键安装（与桌面 Linux 完全同一命令）：

```bash
apt update && apt install -y curl
curl -fsSL https://raw.githubusercontent.com/Sekibyou/teahouse/main/scripts/install-lite.sh | bash
```

装完自动启动。浏览器访问入口 / 局域网共享见下。

**启动后访问**：`./Teahouse` 常驻前台，默认绑 `127.0.0.1`。想用手机浏览器或局域网电脑访问，改 `teahouse.yaml` 的 `server.host` 为 `0.0.0.0` 后重启，经 `手机局域网IP:端口` 访问。

**更新**：`proot-distro login debian` 后再跑一遍 Debian 层的一键脚本即可，脚本会自动下载新版覆盖安装。保留 `teahouse.yaml` 与 `data/`。

> 想从源码跑开发模式？见下「环境准备」。普通使用用上面的 Release 即可。

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
