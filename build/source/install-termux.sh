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

echo "==> 检查/安装依赖（git / python / uv）..."
command -v git >/dev/null 2>&1 || pkg install -y git
command -v python >/dev/null 2>&1 || pkg install -y python
if ! command -v uv >/dev/null 2>&1; then
    echo "==> 安装 uv ..."
    curl -LsSf https://astral.sh/uv/install.sh | sh || {
        echo "!! uv 安装失败，尝试 pip 安装…"
        python -m pip install uv
    }
fi
# 脚本内 PATH 补全 uv（install.sh 装到 ~/.local/bin）
export PATH="${HOME}/.local/bin:${PATH}"

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
    TMP_ZIP="$(mktemp /tmp/teahouse-XXXX.zip)"
    curl -fL -o "${TMP_ZIP}" "${PKG_URL}" || { echo "!! 下载失败"; rm -f "${TMP_ZIP}"; exit 1; }
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
