#!/usr/bin/env bash
# Local development build script. GitHub Actions (.github/workflows/release.yml)
# replicates the dependency-fetching steps independently for CI-specific reasons
# (native Windows runners, caching, etc.). Changes here should be reflected there.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
BIN_DIR="$PROJECT_DIR/bin"
MODELS_DIR="$PROJECT_DIR/models"

WHISPER_VERSION="v1.8.3"
WHISPER_RELEASE_URL="https://github.com/ggml-org/whisper.cpp/releases/download/$WHISPER_VERSION"
MODEL_URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en.bin"

usage() {
  echo "Usage: $0 [--target win|linux|all] [--skip-deps] [--no-gpu] [--debug]"
  echo ""
  echo "  --target    Build target (default: win)"
  echo "  --skip-deps Skip downloading binaries (use existing bin/)"
  echo "  --no-gpu    Skip building Vulkan GPU binaries (faster dev builds)"
  echo "  --debug     Include debug panel in the build"
  exit 1
}

TARGET="win"
SKIP_DEPS=false
DEBUG_BUILD=false
NO_GPU=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --target)  TARGET="$2"; shift 2 ;;
    --skip-deps) SKIP_DEPS=true; shift ;;
    --no-gpu) NO_GPU=true; shift ;;
    --debug) DEBUG_BUILD=true; shift ;;
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
# Local builds download pre-built CPU binaries only.
# Vulkan (GPU) binaries are built from source in CI (see release.yml).
setup_win() {
  local DIR="$BIN_DIR/win"
  local CPU_DIR="$DIR/cpu"
  mkdir -p "$CPU_DIR"

  if [ -f "$CPU_DIR/whisper-cli.exe" ]; then
    echo "==> Windows whisper-cli (CPU) already exists, skipping."
  else
    echo "==> Downloading Windows whisper.cpp CPU binaries ($WHISPER_VERSION)..."
    local TMP=$(mktemp -d)
    curl -L -o "$TMP/whisper.zip" "$WHISPER_RELEASE_URL/whisper-bin-x64.zip"
    unzip -o -j "$TMP/whisper.zip" \
      "Release/whisper-cli.exe" \
      "Release/whisper.dll" \
      "Release/ggml-base.dll" \
      "Release/ggml-cpu.dll" \
      "Release/ggml.dll" \
      -d "$CPU_DIR"
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
  local CPU_DIR="$DIR/cpu"
  local VULKAN_DIR="$DIR/vulkan"
  mkdir -p "$CPU_DIR"

  local BUILD_DIR="$PROJECT_DIR/.build-whisper"

  # Clone whisper.cpp source (shared between CPU and Vulkan builds)
  if [ ! -d "$BUILD_DIR" ]; then
    echo "==> Cloning whisper.cpp..."
    git clone --depth 1 https://github.com/ggml-org/whisper.cpp.git "$BUILD_DIR"
  fi

  # CPU build
  if [ -f "$CPU_DIR/whisper-cli" ]; then
    echo "==> Linux whisper-cli (CPU) already exists, skipping."
  else
    echo "==> Building whisper.cpp (CPU) from source..."
    cmake -S "$BUILD_DIR" -B "$BUILD_DIR/build-cpu" -DCMAKE_BUILD_TYPE=Release
    cmake --build "$BUILD_DIR/build-cpu" -j"$(nproc 2>/dev/null || echo 4)" --config Release

    WHISPER_BIN=$(find "$BUILD_DIR/build-cpu" -name "whisper-cli" -type f | head -1)
    cp "$WHISPER_BIN" "$CPU_DIR/whisper-cli"
    chmod +x "$CPU_DIR/whisper-cli"
    find "$BUILD_DIR/build-cpu" -name "libwhisper.so*" -exec cp {} "$CPU_DIR/" \;
    find "$BUILD_DIR/build-cpu" -name "libggml*.so*" -exec cp {} "$CPU_DIR/" \;
  fi

  # Vulkan (GPU) build — requires libvulkan-dev and glslang-tools
  if [ "$NO_GPU" = true ]; then
    echo "==> Skipping Vulkan build (--no-gpu)."
  elif ! command -v glslc &>/dev/null; then
    echo "==> Skipping Vulkan build (glslc not installed — run: sudo apt install libvulkan-dev glslc)"
  elif [ -f "$VULKAN_DIR/whisper-cli" ]; then
    echo "==> Linux whisper-cli (Vulkan) already exists, skipping."
  else
    echo "==> Building whisper.cpp (Vulkan) from source..."
    mkdir -p "$VULKAN_DIR"
    cmake -S "$BUILD_DIR" -B "$BUILD_DIR/build-vulkan" -DCMAKE_BUILD_TYPE=Release -DGGML_VULKAN=ON
    cmake --build "$BUILD_DIR/build-vulkan" -j"$(nproc 2>/dev/null || echo 4)" --config Release

    WHISPER_BIN=$(find "$BUILD_DIR/build-vulkan" -name "whisper-cli" -type f | head -1)
    cp "$WHISPER_BIN" "$VULKAN_DIR/whisper-cli"
    chmod +x "$VULKAN_DIR/whisper-cli"
    find "$BUILD_DIR/build-vulkan" -name "libwhisper.so*" -exec cp {} "$VULKAN_DIR/" \;
    find "$BUILD_DIR/build-vulkan" -name "libggml*.so*" -exec cp {} "$VULKAN_DIR/" \;
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

# --- Debug build marker ---
DEBUG_MARKER="$PROJECT_DIR/.debug-build"
if [ "$DEBUG_BUILD" = true ]; then
  echo "==> Debug build enabled"
  touch "$DEBUG_MARKER"
else
  rm -f "$DEBUG_MARKER"
fi

echo ""
echo "==> Building Electron app for: $TARGET"
case "$TARGET" in
  win)   npx electron-builder --win ;;
  linux) npx electron-builder --linux ;;
  all)   npx electron-builder --win && npx electron-builder --linux ;;
esac

echo ""
echo "==> Build complete! Output in dist/"
ls -lh dist/*.exe dist/*.AppImage 2>/dev/null || ls dist/
