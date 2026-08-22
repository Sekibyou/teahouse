#!/usr/bin/env bash
#
# Teahouse 一键安装脚本 — Linux（含手机 Termux proot Debian，aarch64）
#
# 用法：
#   curl -fsSL https://raw.githubusercontent.com/Sekibyou/teahouse/main/scripts/install.sh | bash
#   # 或先下载再执行：wget ... -O install.sh && bash install.sh
#
# 自动完成：探测架构 → 取最新版本号 → 装运行依赖 → 下载解压 → 启动
set -euo pipefail

REPO="Sekibyou/teahouse"
RAW="https://raw.githubusercontent.com/$REPO/main/scripts/install.sh"
# 默认装在「当前目录下新建的 Teahouse 文件夹」——用户先 cd 到自己想要的目录再跑命令即可。
# 例子：cd ~/apps 后执行 → 装到 ~/apps/Teahouse；用 TEAHOUSE_DIR 可完全自定义路径。
INSTALL_DIR="${TEAHOUSE_DIR:-./Teahouse}"

step()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
die()   { printf '\033[1;31m[错误] %s\033[0m\n' "$*" >&2; exit 1; }
have()  { command -v "$1" >/dev/null 2>&1; }

# ---- 1. 探测架构 -----------------------------------------------------------
arch() {
  local m; m="$(uname -m)"
  case "$m" in
    aarch64|arm64)  echo "aarch64" ;;
    x86_64|amd64)   echo "x86-64" ;;
    *) die "不支持的架构: $m（可选: aarch64 / x86-64）。若手机是 32 位 armv7l 暂不支持。" ;;
  esac
}

# ---- 主流程 ----------------------------------------------------------------
main() {
  step "1/5 探测架构"
  local ARCH; ARCH="$(arch)"
  echo "架构 → $ARCH"

  step "2/5 获取最新版本号"
  have curl || have wget || die "需要 curl 或 wget，请先安装。"
  local TAG VER
  if have curl; then
    TAG="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -n1)"
  else
    TAG="$(wget -qO- "https://api.github.com/repos/$REPO/releases/latest" | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -n1)"
  fi
  [ -n "$TAG" ] || die "无法获取最新版本号（网络？）。可手动指定：TEAHOUSE_VER=<tag> bash install.sh"
  VER="${TEAHOUSE_VER:-${TAG#v}}"
  echo "最新版本 → $TAG (包版本 $VER)"

  step "3/5 安装运行依赖（libpython 共享库）"
  install_deps

  step "4/5 下载并解压 $ARCH 包"
  local PKG="Teahouse-$VER-Linux-$ARCH.tar.gz"
  local URL="https://github.com/$REPO/releases/download/$TAG/$PKG"
  mkdir -p "$INSTALL_DIR"
  echo "下载 → $URL"
  if have curl; then
    curl -fL --retry 3 -o "$INSTALL_DIR/$PKG" "$URL"
  else
    wget -O "$INSTALL_DIR/$PKG" "$URL"
  fi
  tar -xzf "$INSTALL_DIR/$PKG" -C "$INSTALL_DIR"
  rm -f "$INSTALL_DIR/$PKG"
  local BIN="$INSTALL_DIR/Teahouse"
  [ -x "$BIN" ] || die "解压后未找到可执行文件: $BIN"
  echo "解压完成 → $INSTALL_DIR/Teahouse"

  step "5/5 启动"
  echo "已就绪，启动 Teahouse ...（浏览器会自动打开；Ctrl+C 停止）"
  exec "$BIN"
}

# ---- 依赖安装（探测发行版）-------------------------------------------------
install_deps() {
  local pyver
  pyver="$(python3 -c 'import sys;print("%d.%d"%sys.version_info[:2])' 2>/dev/null || true)"
  if [ -z "$pyver" ]; then
    echo "未检测到 python3，尝试安装……"
  fi

  if have apt-get; then
    echo "检测到 apt 系（Debian/Ubuntu），安装 libpython-${pyver}-dev"
    if [ "$(id -u)" -eq 0 ]; then
      apt-get update -y && apt-get install -y "libpython${pyver}-dev"
    elif have sudo; then
      sudo apt-get update -y && sudo apt-get install -y "libpython${pyver}-dev"
    else
      echo "未 root 也未装 sudo，跳过依赖安装；若启动报缺库请手动：apt-get install libpython${pyver}-dev"
    fi
  elif have dnf; then
    echo "检测到 dnf 系（Fedora），安装 python3-devel"
    if [ "$(id -u)" -eq 0 ]; then
      dnf install -y python3-devel
    elif have sudo; then
      sudo dnf install -y python3-devel
    fi
  else
    echo "未知包管理器，跳过依赖安装；启动报缺库时请自行补装 libpython 共享库。"
  fi
}

main "$@"
