#!/usr/bin/env bash
# Teahouse Linux 一键安装（aarch64 / proot-Debian / Ubuntu / 任一 glibc Linux）。
# 用法（在目标 Linux 里）：
#   bash <(curl -Ls https://github.com/Sekibyou/teahouse/releases/latest/download/install-linux.sh)
# 或下载本脚本执行。可选参数 --update 传给 ./Teahouse 升级到最新。
#
# 为什么这条路顺：glibc 环境下 pip 直接抓 manylinux_aarch64 预编译 wheel，
# pydantic-core / cryptography / pyyaml / uvloop 全免编译——不碰 uv、不用编译工具链。
# （Termux bionic 才需要 rust/clang 源码编译，本脚本面向非 Termux 的 glibc 环境。）
set -euo pipefail

REPO_OWNER="Sekibyou"
REPO_NAME="teahouse"
RELEASE_API="https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases"
DEST_DIR="${HOME}/teahouse"
VERSION_FILE="VERSION"

echo "==> 安装基础依赖（git / python3 / venv / curl / unzip）..."
if command -v apt-get >/dev/null 2>&1; then
    apt-get update -y || true
    DEBIAN_FRONTEND=noninteractive apt-get install -y git python3 python3-venv curl unzip
elif command -v apk >/dev/null 2>&1; then
    apk add --no-cache git python3 py3-pip curl unzip
else
    echo "!! 未识别的包管理器，请手动安装 git python3 curl unzip 后重试。"
    exit 1
fi

echo "==> 获取最新 release 版本…"
if ! command -v python3 >/dev/null 2>&1; then
    echo "!! 缺少 python3，无法解析版本。"
    exit 1
fi
LATEST_TAG="$(curl -s "${RELEASE_API}" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d[0]["tag_name"] if d else "")')"
if [ -z "${LATEST_TAG}" ]; then
    echo "!! 获取最新版本失败（网络/API 限流？）"
    exit 1
fi
PKG="teahouse-${LATEST_TAG#v}-source.zip"
PKG_URL="https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/download/${LATEST_TAG}/${PKG}"

mkdir -p "${DEST_DIR}"
cd "${DEST_DIR}"
if [ ! -f "${VERSION_FILE}" ] || [ ! -f "Teahouse" ]; then
    echo "==> 下载 ${PKG} …"
    TMP_ZIP="${DEST_DIR}/.teahouse-download.zip"
    curl -fL -o "${TMP_ZIP}" "${PKG_URL}" || { rm -f "${TMP_ZIP}"; echo "!! 下载失败"; exit 1; }
    unzip -o "${TMP_ZIP}" -d "${DEST_DIR}"
    rm -f "${TMP_ZIP}"
fi

echo "==> 运行 Teahouse（首次自动 clone 源码 + venv + 装依赖 + 自愈前端）…"
chmod +x "./Teahouse"
if [ "${1:-}" = "--update" ]; then
    exec "./Teahouse" --update
else
    exec "./Teahouse"
fi
