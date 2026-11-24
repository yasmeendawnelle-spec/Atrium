#!/usr/bin/env sh
set -eu

REPO="yasmeendawnelle-spec/Atrium"
VERSION="${ATRIUM_VERSION:-latest}"
INSTALL_DIR="${ATRIUM_INSTALL_DIR:-$HOME/.local/bin}"
LOCAL_BINARY=""
UNINSTALL=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --version)
      VERSION="${2:?--version requires a value}"
      shift 2
      ;;
    --dir)
      INSTALL_DIR="${2:?--dir requires a value}"
      shift 2
      ;;
    --local)
      LOCAL_BINARY="${2:?--local requires a path}"
      shift 2
      ;;
    --uninstall)
      UNINSTALL=1
      shift 1
      ;;
    -h|--help)
      echo "Usage: install.sh [--version <tag>] [--dir <install-dir>] [--local <binary>] [--uninstall]"
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 2
      ;;
  esac
done

TARGET="$INSTALL_DIR/atrium"

if [ "$UNINSTALL" -eq 1 ]; then
  if [ -f "$TARGET" ]; then
    rm -f "$TARGET"
    echo "Removed Atrium CLI from $TARGET"
  else
    echo "Atrium CLI was not found at $TARGET"
  fi
  exit 0
fi

OS_RAW="$(uname -s)"
ARCH_RAW="$(uname -m)"

case "$OS_RAW" in
  Darwin) PLATFORM="darwin" ;;
  Linux) PLATFORM="linux" ;;
  *)
    echo "Unsupported OS: $OS_RAW (use install.ps1 on Windows)" >&2
    exit 1
    ;;
esac

case "$ARCH_RAW" in
  x86_64|amd64) ARCH="x64" ;;
  arm64|aarch64) ARCH="arm64" ;;
  *)
    if [ -z "$LOCAL_BINARY" ]; then
      echo "Unsupported architecture: $ARCH_RAW. Install via 'npm install -g @atrium-ai/cli' or 'npm run cli:install'." >&2
      exit 1
    fi
    ARCH="$ARCH_RAW"
    ;;
esac

mkdir -p "$INSTALL_DIR"
TMP_FILE="$INSTALL_DIR/.atrium.tmp.$$"
trap 'rm -f "$TMP_FILE"' EXIT INT TERM

if [ -n "$LOCAL_BINARY" ]; then
  if [ ! -f "$LOCAL_BINARY" ]; then
    echo "Local binary not found: $LOCAL_BINARY" >&2
    exit 1
  fi
  cp "$LOCAL_BINARY" "$TMP_FILE"
else
  ASSET="atrium-${PLATFORM}-${ARCH}"
  if [ "$VERSION" = "latest" ]; then
    URL="https://github.com/${REPO}/releases/latest/download/${ASSET}"
  else
    case "$VERSION" in
      v*) TAG="$VERSION" ;;
      *) TAG="v${VERSION}" ;;
    esac
    URL="https://github.com/${REPO}/releases/download/${TAG}/${ASSET}"
  fi
  echo "Downloading Atrium CLI (${ASSET})..."
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$URL" -o "$TMP_FILE"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$TMP_FILE" "$URL"
  else
    echo "Neither curl nor wget was found in PATH." >&2
    exit 1
  fi
fi

chmod 0755 "$TMP_FILE"
mv -f "$TMP_FILE" "$TARGET"

VER_OUT="$("$TARGET" --version)"
echo ""
echo "Installed Atrium CLI (${VER_OUT}) -> ${TARGET}"

case ":$PATH:" in
  *":$INSTALL_DIR:"*)
    echo 'Type "atrium" in any terminal to launch!'
    ;;
  *)
    SHELL_NAME="$(basename "${SHELL:-sh}")"
    RC_FILE=""
    EXPORT_LINE="export PATH=\"$INSTALL_DIR:\$PATH\""
    case "$SHELL_NAME" in
      zsh) RC_FILE="$HOME/.zshrc" ;;
      bash)
        if [ -f "$HOME/.bashrc" ] || [ "$PLATFORM" = "linux" ]; then
          RC_FILE="$HOME/.bashrc"
        else
          RC_FILE="$HOME/.bash_profile"
        fi
        ;;
      fish)
        RC_FILE="$HOME/.config/fish/config.fish"
        EXPORT_LINE="fish_add_path \"$INSTALL_DIR\""
        mkdir -p "$(dirname "$RC_FILE")"
        ;;
      *) RC_FILE="$HOME/.profile" ;;
    esac

    if [ -n "$RC_FILE" ]; then
      if [ ! -f "$RC_FILE" ] || ! grep -Fqs "$INSTALL_DIR" "$RC_FILE"; then
        printf '\n# Added by Atrium CLI installer\n%s\n' "$EXPORT_LINE" >> "$RC_FILE"
        echo "Added $INSTALL_DIR to $RC_FILE."
      fi
      echo "Run: source \"$RC_FILE\"  (or open a new terminal), then type \"atrium\" to launch!"
    fi
    ;;
esac
