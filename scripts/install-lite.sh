#!/usr/bin/env bash
#
# Teahouse 精简版一键安装脚本 — Linux（含手机 Termux proot Debian，aarch64）
#
# 与 install.sh 的唯一区别：不做任何运行依赖安装（PyInstaller 包已捆绑完整运行时，
# 绝大多数环境开箱即跑）。若启动时报缺库，再用完整版 install.sh 或手动补装。
#
# 用法：
#   curl -fsSL https://raw.githubusercontent.com/Sekibyou/teahouse/main/scripts/install-lite.sh | bash
#   # 或先下载再执行：wget ... -O install-lite.sh && bash install-lite.sh
#
# 自动完成：探测架构 → 取最新版本号 → 下载解压 → 启动
set -euo pipefail

REPO="Sekibyou/teahouse"
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
  step "1/4 探测架构"
  local ARCH; ARCH="$(arch)"
  echo "架构 → $ARCH"

  step "2/4 获取最新版本号"
  have curl || have wget || die "需要 curl 或 wget，请先安装（手机端: apt install -y curl）。"
  local TAG VER
  if have curl; then
    TAG="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -n1)"
  else
    TAG="$(wget -qO- "https://api.github.com/repos/$REPO/releases/latest" | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -n1)"
  fi
  [ -n "$TAG" ] || die "无法获取最新版本号（网络？）。可手动指定：TEAHOUSE_VER=<tag> bash install-lite.sh"
  VER="${TEAHOUSE_VER:-${TAG#v}}"
  echo "最新版本 → $TAG (包版本 $VER)"

  step "3/4 下载并解压 $ARCH 包"
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

  step "4/4 启动"
  echo "已就绪，启动 Teahouse ...（浏览器会自动打开；Ctrl+C 停止）"
  exec "$BIN"
}

main "$@"
