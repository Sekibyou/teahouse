# Teahouse — Release Build

幂等构建：一条命令，从任意状态（干净/半成品）重建出可交付的 `dist/Teahouse/`。

## 快速开始（推荐直接调 python 脚本）

```bat
.venv\Scripts\python.exe build\build_release.py
```

`build\build_release.bat` 只是**给本人双击方便**的薄触发器（定位 venv python、转发参数、结束 `pause` 停留窗口）；文档/CI/脚本等直接调 `.py` 即可，等价：

```bat
build\build_release.bat          @ 等价于 python build\build_release.py
```

## 分步执行（可选步骤参数）

`build_release` 支持**只跑某些步骤**，其余跳过：

```bat
build\build_release.bat --check             只查前置
build\build_release.bat --frontend          只 build 前端
build\build_release.bat --backend           只打包后端
build\build_release.bat --assets            把前端算 hash + 压成 dist.zip + 写 dist.hash
build\build_release.bat --verify            只校验产物
build\build_release.bat --frontend --backend --assets  组合
```

| 参数 | 作用 |
|---|---|
| `--check` | 校验 venv python / pyinstaller / pnpm / `build\mingit_tmp` 齐备 |
| `--frontend` | `teahouse-frontend\pnpm build` |
| `--backend` | `pyinstaller --clean --noconfirm teahouse.spec` |
| `--assets` | 前端→自愈安装源：算 dir hash → 压 `dist.zip`（顶层 `dist/`）→ 写 `dist.hash`（zip+dir 双 hash）|
| `--verify` | 检查 exe/_internal/git/dist.zip 齐备 + dist.hash 与 dist.zip 自洽 |
| `--zip` | 打两个发布 zip（见下「双 zip 产物」） |

无参数 = 全跑（含 `--zip`）；带一个或多个 `--xxx` = 只跑指定步骤。

> ⚠️ **`--zip` 不重编代码**：它只是"用当前 `dist\Teahouse` 直接打包"。改过前端/后端代码后必须先 `--frontend`/`--backend`（或直接无参数全跑），再 `--zip`；否则产出的 zip 是旧代码。发布请直接无参数全跑。

## 双 zip 产物

`--zip` 在 `dist\` 生成两个包（版本号单源 = `pyproject.toml`，排除 yaml/data），并额外产出**跨架构源码一键包**与独立前端 asset：

- `dist\Teahouse-<ver>-with-git.zip` —— **内置 git**，新用户全量安装用
- `dist\Teahouse-<ver>.zip` —— **不含 git**，老用户更新用（体积小，MinGit 不重复下）
- `dist\teahouse-<ver>-source.zip` —— **源码一键包（不经 PyInstaller，跨架构）**：`Teahouse` 引导脚本 + `dist.zip` + `dist.hash` + `VERSION`。给 aarch64/Termux/任一 Linux 原生用（PyInstaller 产物绑定宿主架构，x86 打包在 ARM 跑不了）
- `dist\frontend-dist-<ver>.zip` + `dist\dist.hash` —— 独立前端 asset，源码一键包/Termux 缺前端时从 release 拉取（`--assets` 产出）

## 前置要求（仅构建机）

| 依赖 | 说明 |
|---|---|
| Python 3.11+ venv | `.venv\Scripts\python.exe`，含 `pyinstaller`（`pip install pyinstaller`） |
| pnpm + Node | 前端构建 |
| 解压好的 MinGit | `build\mingit_tmp\cmd\git.exe`（先手动解压一次 MinGit release zip 到 `build\mingit_tmp`） |

> 不再要求 `tests\` 下有 MinGit zip——`build\mingit_tmp` 里已解压的版本就是装配源。首次准备：把 `MinGit-<ver>-64-bit.zip` 解压到 `build\mingit_tmp`，之后脚本直接用它，不用再动。

## 脚本结构（两步）

- **`build_release.bat`**：纯触发器——定位 venv python、转发参数到 py、结束后 `pause` 停留窗口。逻辑简单不易错。
- **`build_release.py`**：承载全部构建逻辑（幂等、分步）。用 argparse 解析 `--xxx` 参数，跨平台 `subprocess` 调用（自动用 `cmd /c` 跑 pnpm 这类 `.cmd` shim）。

逻辑详情：
1. **check**：校验 venv python / pyinstaller / pnpm / `build\mingit_tmp\cmd\git.exe`，缺失即停并提示。
2. **frontend**：`teahouse-frontend\pnpm build` → `teahouse-frontend\dist`。
3. **backend**：`pyinstaller --clean --noconfirm teahouse.spec`。`--clean` 清中间产物，COLLECT 自带清 `dist/Teahouse`，故可重复执行。
4. **assets**：把前端自愈安装源写进发布目录——对 `teahouse-frontend\dist` 算 dir hash → 压成 `dist.zip`（顶层 `dist/`）→ 写 `dist.hash`（内含 zip + dir 两枚 sha256）。顺序严格"先算 hash、再打 zip、后写 hash"确保同源，并对 zip 内部解压复核一次防错位。
5. **verify**：检查 `dist\Teahouse` 下 exe/_internal/git/dist.zip 齐备，并复核 `dist.hash` 里的 zip hash 与当前 `dist.zip` 自洽。
6. **zip**：打两个发布 zip，并组装源码一键包 `teahouse-<ver>-source.zip`（`build/source/Teahouse` + `OUT/dist.zip` + `OUT/dist.hash` + `VERSION`）。

> **源码一键包（`build/source/Teahouse`）**：跨架构引导脚本（shebang Python，非 PyInstaller）。运行它 = `git clone --branch v<ver>` 源码 → `uv venv` + `uv pip install -e .`（抓 aarch64 预编译 wheel）→ 把包内 dist.zip/dist.hash 种进 `.teahouse-dist/` 自愈 → `python -m teahouse`。`--update` 下载最新 release Source code（不走 git pull）+ 依赖。需要目标机有 git/python3/uv。脚本与 `frontend_install.py` 源码态分支（B1 默认自愈）配套，前端副作用（`.teahouse-dist/`、`teahouse-frontend/dist`）均已 gitignore。

任一步失败即打印原因并**停留窗口**（bat 层 `pause`），不会闪退；成功同样停留。

> ⚠️ **bat 必须 CRLF 行尾**：用文本编辑器改 `build_release.bat` 时保持 CRLF（不要用 LF），否则 cmd 解析 `REM`/`if` 会报 `. was unexpected`。

## 每次改代码后怎么重建

改了**后端 src/** 或 **前端 teahouse-frontend/** 任意代码：

```bat
build\build_release.bat
```

它会重新 build 前端 + 重新打包后端，产出新的干净 dist。**无需手动清理任何东西**。

> ⚠️ 前端 PWA 版本号：CLAUDE.md 约定部署前手动 `+1` `teahouse-frontend/public/sw.js` 的 `CACHE_NAME`（`teahouse-v2`→`v3`…）。构建脚本**不自动**改它——这是发布判断，由人决定。发布前记得检查。

## 产物是干净的交付物

```
dist/Teahouse/
  Teahouse.exe   双击入口（启动时先做前端自愈，再起后端服务）
  _internal/     Python 运行时 + 打包资源
  git/           捆绑 MinGit（用户无需安装 git）
  dist.zip       前端压缩包（覆盖式）
  dist.hash      前端自愈状态（zip+dir 双 sha256，覆盖式）
  (dist/         运行时解压生成：按 dist.hash 校验后从 dist.zip 解压/复用）
  (teahouse.yaml / data/  首次运行自动生成）
```

- **`dist/` 不再直接发布**：release 只带 `dist.zip` + `dist.hash`，`dist/` 是目标机器启动时由 `frontend_install.py` 自愈的运行时产物。这样 v1.00→v1.01 前端文件不用逐名比对——未变则复用、变了才重解压，覆盖更新绝不叠两份。
- **不含** `teahouse.yaml` / `data/` —— 首启自动生成（含随机 super admin 密码），每个使用者拿到独立的一份。
- **不含** PyInstaller 中间目录 `build/teahouse`、前端 node_modules、测试文件 —— 全被 `.gitignore` 忽略。
- **可重复**：同一份源码跑 N 次，产出结构一致（exe 哈希除外，bootloader 每次重建）。

## 本目录（build/）说明

```
build/
  build_release.py     幂等构建逻辑（步骤选择、subprocess、校验、一键包组装）
  build_release.bat    薄触发器（定位 venv python、转发参数、pause 停留）
  README_BUILD.md      本文档
  mingit_tmp/          MinGit 解压目录（保留，脚本直接装配它；删了需重新解压）
  teahouse/            PyInstaller 中间产物（可删，--clean 会重建）
  source/
    Teahouse           源码一键包引导脚本（跨架构，Tag 打包/一键包必用）
    install-termux.sh  Termux 一键安装（装依赖 → 拉最新一键包 → ./Teahouse）
```

`build/`、`dist/`、`tests/` 均被 `.gitignore` 忽略，不入库。

## 手动重建（不跑脚本）

```bat
cd w:\teahouse
.venv\Scripts\pyinstaller.exe --clean --noconfirm teahouse.spec  # 后端
.venv\Scripts\python.exe build\build_release.py --frontend        # 或只 build 前端
```
（打包源 MinGit 已解压在 `build\mingit_tmp`，手动重建前确保它存在。）

## 发布到 GitHub（用户明确要求时才执行）

> ⚠️ **发布是受控操作**：只有在项目主明确说「打包/发布 vX.Y.Z」时才执行下述链路。不得自动跑 build、push、打 tag、创建 release。

完整发布链：

```bat
REM 1) 先手动 +1 前端 PWA 缓存版本（teahouse-frontend/public/sw.js 的 CACHE_NAME；发布判断，人负责）
REM    必须在 build 前改，否则改完不重编、进不了包。

REM 2) 重 build 并出双 zip（含最新代码）——必须【无参数全跑】，会重编前端+后端再打包
REM    ⚠️ 不要只传 --zip：那只是用当前 dist/Teahouse 直接打包，不重编代码，会打出旧代码
.venv\Scripts\python.exe build\build_release.py

REM 3) 提交源码改动（build/ 与 dist/ 不入库）
git add <src...> teahouse-frontend/... CLAUDE.md
git commit -m "..."
git push origin main

REM 4) 打 tag + 创建 release，上传两个 zip + 源码一键包 + 独立前端 asset
gh release create v<VER> "dist\Teahouse-<VER>-with-git.zip" "dist\Teahouse-<VER>.zip" "dist\teahouse-<VER>-source.zip" "dist\frontend-dist-<VER>.zip" "dist\dist.hash" --title "..." --notes "<...>"
```

release 说明要点（给玩家）：
- **新用户**下 `-with-git.zip`；**老用户升级**下裸名包。
- 升级步骤：解压新版 → 覆盖 `Teahouse.exe` / `_internal/` / `dist.zip` / `dist.hash`（都是同名覆盖式更新，绝不叠文件）→ **保留 `teahouse.yaml` 和 `data/`**（配置与存档）→ 重新双击。
- **前端自动对齐**：旧 `dist/` 不用手动管——启动时程序会对照 `dist.hash` 判断：前端没变就直接复用旧 `dist/`（零成本），前端有更新则自动解压新版。

> `gh` 需已登录：`gh auth login`（网页授权一次）。

