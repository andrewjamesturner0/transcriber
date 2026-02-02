#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
BIN_DIR="$PROJECT_DIR/bin"
MODELS_DIR="$PROJECT_DIR/models"

WHISPER_VERSION="v1.8.3"
WHISPER_RELEASE_URL="https://github.com/ggml-org/whisper.cpp/releases/download/$WHISPER_VERSION"
MODEL_URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en.bin"

usage() {
  echo "Usage: $0 [--target win|linux|all] [--skip-deps]"
  echo ""
  echo "  --target    Build target (default: win)"
  echo "  --skip-deps Skip downloading binaries (use existing bin/)"
  exit 1
}

TARGET="win"
SKIP_DEPS=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --target)  TARGET="$2"; shift 2 ;;
    --skip-deps) SKIP_DEPS=true; shift ;;
    -h|--help) usage ;;
    *) echo "Unknown option: $1"; usage ;;
  esac
done

# --- Download model ---
download_model() {
  if [ -f "$MODELS_DIR/ggml-tiny.en.bin" ]; then
    echo "==> Model already exists, skipping."
  else
    mkdir -p "$MODELS_DIR"
    echo "==> Downloading tiny.en model..."
    curl -L -o "$MODELS_DIR/ggml-tiny.en.bin" "$MODEL_URL"
  fi
}

# --- Windows dependencies ---
setup_win() {
  local DIR="$BIN_DIR/win"
  mkdir -p "$DIR"

  if [ -f "$DIR/whisper-cli.exe" ]; then
    echo "==> Windows whisper-cli already exists, skipping."
  else
    echo "==> Downloading Windows whisper.cpp binaries ($WHISPER_VERSION)..."
    local TMP=$(mktemp -d)
    curl -L -o "$TMP/whisper.zip" "$WHISPER_RELEASE_URL/whisper-bin-x64.zip"
    unzip -o -j "$TMP/whisper.zip" \
      "Release/whisper-cli.exe" \
      "Release/whisper.dll" \
      "Release/ggml-base.dll" \
      "Release/ggml-cpu.dll" \
      "Release/ggml.dll" \
      -d "$DIR"
    rm -rf "$TMP"
  fi

  if [ -f "$DIR/ffmpeg.exe" ]; then
    echo "==> Windows ffmpeg already exists, skipping."
  else
    echo "==> Downloading Windows ffmpeg..."
    local TMP=$(mktemp -d)
    curl -L -o "$TMP/ffmpeg.zip" "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip"
    unzip -o -j "$TMP/ffmpeg.zip" "*/bin/ffmpeg.exe" -d "$DIR"
    rm -rf "$TMP"
  fi
}

# --- Linux dependencies ---
setup_linux() {
  local DIR="$BIN_DIR/linux"
  mkdir -p "$DIR"

  if [ -f "$DIR/whisper-cli" ]; then
    echo "==> Linux whisper-cli already exists, skipping."
  else
    echo "==> Building whisper.cpp from source..."
    local BUILD_DIR="$PROJECT_DIR/.build-whisper"
    if [ ! -d "$BUILD_DIR" ]; then
      git clone --depth 1 https://github.com/ggml-org/whisper.cpp.git "$BUILD_DIR"
    fi
    cmake -S "$BUILD_DIR" -B "$BUILD_DIR/build" -DCMAKE_BUILD_TYPE=Release
    cmake --build "$BUILD_DIR/build" -j"$(nproc 2>/dev/null || echo 4)" --config Release

    WHISPER_BIN=$(find "$BUILD_DIR/build" -name "whisper-cli" -type f | head -1)
    cp "$WHISPER_BIN" "$DIR/whisper-cli"
    chmod +x "$DIR/whisper-cli"
    find "$BUILD_DIR/build" -name "libwhisper.so*" -exec cp {} "$DIR/" \;
    find "$BUILD_DIR/build" -name "libggml*.so*" -exec cp {} "$DIR/" \;
  fi

  if [ -f "$DIR/ffmpeg" ]; then
    echo "==> Linux ffmpeg already exists, skipping."
  else
    echo "==> Downloading Linux ffmpeg..."
    local ARCH="$(uname -m)"
    case "$ARCH" in
      x86_64)  FFMPEG_URL="https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz" ;;
      aarch64) FFMPEG_URL="https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-arm64-static.tar.xz" ;;
      *)       echo "Unsupported arch: $ARCH"; exit 1 ;;
    esac
    local TMP=$(mktemp -d)
    curl -L -o "$TMP/ffmpeg.tar.xz" "$FFMPEG_URL"
    tar -xf "$TMP/ffmpeg.tar.xz" -C "$TMP"
    find "$TMP" -name "ffmpeg" -type f -exec cp {} "$DIR/ffmpeg" \;
    chmod +x "$DIR/ffmpeg"
    rm -rf "$TMP"
  fi
}

# --- Main ---
cd "$PROJECT_DIR"

echo "==> Installing npm dependencies..."
npm install

if [ "$SKIP_DEPS" = false ]; then
  download_model

  case "$TARGET" in
    win)   setup_win ;;
    linux) setup_linux ;;
    all)   setup_win; setup_linux ;;
    *)     echo "Unknown target: $TARGET"; usage ;;
  esac
fi

echo ""
echo "==> Building Electron app for: $TARGET"
# Note: NSIS installer target requires native Linux (not WSL) or Windows.
# Use -c.win.target=zip to build just the zip if NSIS fails.
case "$TARGET" in
  win)   npx electron-builder --win -c.win.target=zip ;;
  linux) npx electron-builder --linux ;;
  all)   npx electron-builder --win -c.win.target=zip && npx electron-builder --linux ;;
esac

echo ""
echo "==> Build complete! Output in dist/"
ls -lh dist/*.exe dist/*.AppImage 2>/dev/null || ls dist/
