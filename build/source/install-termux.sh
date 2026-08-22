#!/data/data/com.termux/files/usr/bin/bash
# Teahouse Termux 一键安装：装依赖 → 拉最新源码一键包 → 解压 → 运行。
# 用法：
#   bash install-termux.sh           安装并运行（--update 会在首次之后升级到最新）
# 说明：脚本会申请存储权限并创建 Teahouse 目录；需要网络下载。首次运行较久（装 Python 依赖）。
set -euo pipefail

VERSION_FILE="VERSION"
REPO_OWNER="Sekibyou"
REPO_NAME="teahouse"
RELEASE_API="https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases"
DEST_DIR="${HOME}/teahouse"

echo "==> 检查/安装依赖（git / python / rust / 编译库）..."
command -v git >/dev/null 2>&1 || pkg install -y git
command -v python >/dev/null 2>&1 || pkg install -y python
# Termux 现实：Python = aarch64+android(bionic)，PyPI 上无 android wheel——
# manylinux_aarch64 是 glibc，Termux 用不了，故编译型依赖无法靠 pip 抓 wheel。
# 对策：
#   - cryptography / bcrypt：用 Termux pkg 预编译的 bionic 版（python-cryptography / python-bcrypt），
#     装进系统 python 的 site-packages，vev 用 --system-site-packages 复用，pip 不再重装。
#   - pydantic-core / uvloop / httptools / pyyaml：无 pkg 且无 android wheel → 源码编译，须装 Rust
#     （cargo/maturin）工具链。首次编译较慢（分钟级），此后 venv 不再重装。
command -v rustc >/dev/null 2>&1 || command -v cargo >/dev/null 2>&1 || pkg install -y rust
pkg install -y python-cryptography python-bcrypt 2>/dev/null || echo "!! python-cryptography/python-bcrypt 安装warning(可忽略，pip 会尝试编译)"

echo "==> 获取最新 release 版本…"
LATEST_TAG="$(curl -s "${RELEASE_API}" | python -c 'import sys,json;d=json.load(sys.stdin);print(d[0]["tag_name"] if d else "")')"
if [ -z "${LATEST_TAG}" ]; then
    echo "!! 获取最新版本失败（网络/API 限流？）"
    exit 1
fi
PKG="teahouse-${LATEST_TAG#v}-source.zip"
PKG_URL="https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/download/${LATEST_TAG}/${PKG}"

# 解压目录：若已存在且非空，当作工作目录复用（不重复下包，保持干净可只跑 ./Teahouse）
mkdir -p "${DEST_DIR}"
cd "${DEST_DIR}"
if [ ! -f "${VERSION_FILE}" ] || [ ! -f "Teahouse" ]; then
    echo "==> 下载 ${PKG} 到 ${DEST_DIR} …"
    # 临时 zip 放下工作区（Termux 的 /tmp 常不可写，mktemp /tmp 会 Permission denied），
    # 下载后立即解压、删除，工作区保持只有一键包内容，不残留临时文件。
    TMP_ZIP="${DEST_DIR}/.teahouse-download.zip"
    curl -fL -o "${TMP_ZIP}" "${PKG_URL}" || {
        rm -f "${TMP_ZIP}"
        echo "!! 下载失败：${PKG_URL}"
        exit 1
    }
    unzip -o "${TMP_ZIP}" -d "${DEST_DIR}"
    rm -f "${TMP_ZIP}"
fi

echo "==> 运行 Teahouse（首次会克隆源码 + 装依赖 + 自愈前端，请耐心）…"
chmod +x "./Teahouse"
if [ "${1:-}" = "--update" ]; then
    exec "./Teahouse" --update
else
    exec "./Teahouse"
fi
