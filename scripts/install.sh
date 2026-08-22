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
# 默认直接解压到「当前目录」——用户先 cd 到自己想放的地方再跑命令即可，不额外套一层
# Teahouse/ 子文件夹（避免嵌套）。想装进别的目录用 TEAHOUSE_DIR=/opt/teahouse bash ...。
INSTALL_DIR="${TEAHOUSE_DIR:-.}"

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
  # 解压到临时目录，再把包顶层 `Teahouse/` 的内容平移到目标——确保结构恒为
  # `目标/Teahouse`(可执行)+`_internal/`+`dist.zip`+`dist.hash`，不依赖 tar 是否支持
  # --strip-components，也避免预建同名目录造成三重嵌套。
  local TMPD; TMPD="$(mktemp -d)"
  tar -xzf "$INSTALL_DIR/$PKG" -C "$TMPD"
  local BIN="$INSTALL_DIR/Teahouse"
  [ -f "$TMPD/Teahouse/Teahouse" ] || { rm -rf "$TMPD"; die "解压包结构异常，未找到 Teahouse/Teahouse"; }
  # 平移到目标（先备份旧 Teahouse 目录以防同名冲突）
  if [ -e "$BIN" ]; then mv -f "$BIN" "$INSTALL_DIR/.Teahouse.old" 2>/dev/null || rm -rf "$BIN"; fi
  rm -rf "$INSTALL_DIR/.Teahouse.old"
  shopt -s dotglob && mv "$TMPD/Teahouse"/* "$INSTALL_DIR/" && shopt -u dotglob
  rm -rf "$TMPD"
  rm -f "$INSTALL_DIR/$PKG"
  chmod +x "$BIN"

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
