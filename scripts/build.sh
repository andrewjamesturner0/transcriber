#!/usr/bin/env bash
# Local development build script. GitHub Actions (.github/workflows/release.yml)
# replicates the dependency-fetching steps independently for CI-specific reasons
# (native Windows runners, caching, etc.). Changes here should be reflected there.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
BIN_DIR="$PROJECT_DIR/bin"
MODELS_DIR="$PROJECT_DIR/models"
DEPS_JSON="$PROJECT_DIR/deps.json"

# Read dependency versions from deps.json (single source of truth)
dep() { node -p "require('$DEPS_JSON')$1"; }

WHISPER_VERSION="$(dep '.whisper.version')"
build_dep() { node "$SCRIPT_DIR/build-deps.js" "$@"; }
linux_ffmpeg_key() {
  case "$(uname -m)" in
    x86_64) echo ffmpeg-linux-amd64 ;;
    aarch64) echo ffmpeg-linux-arm64 ;;
    *) echo "Unsupported architecture" >&2; return 1 ;;
  esac
}

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
  echo "==> Checking/downloading pinned tiny.en model..."
  build_dep fetch model "$MODELS_DIR/$(dep '.model.default')"
}

# --- Windows dependencies ---
# Local builds download pre-built CPU binaries only.
# Vulkan (GPU) binaries are built from source in CI (see release.yml).
setup_win() {
  local DIR="$BIN_DIR/win"
  local CPU_DIR="$DIR/cpu"
  mkdir -p "$CPU_DIR"

  # Optional GPU outputs are packaged too, so verify them even in a CPU build.
  if [ -d "$DIR/vulkan" ]; then
    build_dep cache whisper-win-vulkan "$DIR/vulkan"
  fi
  local CACHE
  CACHE=$(build_dep cache whisper-win-cpu "$CPU_DIR")
  if [ "$CACHE" = valid ]; then
    echo "==> Windows whisper-cli (CPU) already exists, skipping."
  else
    echo "==> Downloading Windows whisper.cpp CPU binaries ($WHISPER_VERSION)..."
    local TMP
    TMP=$(mktemp -d)
    build_dep fetch whisper-win "$TMP/whisper.zip"
    unzip -o -j "$TMP/whisper.zip" \
      "Release/whisper-cli.exe" \
      "Release/whisper.dll" \
      "Release/ggml-base.dll" \
      "Release/ggml-cpu.dll" \
      "Release/ggml.dll" \
      -d "$CPU_DIR"
    build_dep record whisper-win-cpu "$CPU_DIR"
    rm -rf "$TMP"
  fi

  CACHE=$(build_dep cache-file ffmpeg-win "$DIR/ffmpeg.exe")
  if [ "$CACHE" = valid ]; then
    echo "==> Windows ffmpeg already exists, skipping."
  else
    echo "==> Downloading Windows ffmpeg..."
    local TMP
    TMP=$(mktemp -d)
    build_dep fetch ffmpeg-win "$TMP/ffmpeg.zip"
    unzip -o -j "$TMP/ffmpeg.zip" "*/bin/ffmpeg.exe" -d "$DIR"
    build_dep record-file ffmpeg-win "$DIR/ffmpeg.exe"
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

  # Verify the exact revision before inspecting or reusing build outputs.
  build_dep source "$BUILD_DIR"

  # CPU build
  local CPU_CACHE VULKAN_CACHE
  CPU_CACHE=$(build_dep cache whisper-linux-cpu "$CPU_DIR")
  VULKAN_CACHE=$(build_dep cache whisper-linux-vulkan "$VULKAN_DIR")
  if [ "$CPU_CACHE" = valid ]; then
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
    build_dep record whisper-linux-cpu "$CPU_DIR"
  fi

  # Vulkan (GPU) build - requires libvulkan-dev, glslc, and spirv-headers
  if [ "$NO_GPU" = true ]; then
    echo "==> Skipping Vulkan build (--no-gpu)."
  elif ! command -v glslc &>/dev/null; then
    echo "==> Skipping Vulkan build (glslc not installed - run: sudo apt install libvulkan-dev glslc spirv-headers)"
  elif ! { pkg-config --exists vulkan 2>/dev/null || [ -f /usr/include/vulkan/vulkan.h ]; }; then
    echo "==> Skipping Vulkan build (Vulkan headers not installed - run: sudo apt install libvulkan-dev glslc spirv-headers)"
  elif ! cmake --find-package -DNAME=SPIRV-Headers -DCOMPILER_ID=GNU -DLANGUAGE=CXX -DMODE=EXIST &>/dev/null; then
    echo "==> Skipping Vulkan build (SPIR-V headers not installed - run: sudo apt install libvulkan-dev glslc spirv-headers)"
  elif [ "$VULKAN_CACHE" = valid ]; then
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
    build_dep record whisper-linux-vulkan "$VULKAN_DIR"
  fi

  local FFMPEG_KEY
  FFMPEG_KEY="$(linux_ffmpeg_key)"
  local FFMPEG_CACHE
  FFMPEG_CACHE=$(build_dep cache-file "$FFMPEG_KEY" "$DIR/ffmpeg")
  if [ "$FFMPEG_CACHE" = valid ]; then
    echo "==> Linux ffmpeg already verified, skipping."
  else
    echo "==> Downloading Linux ffmpeg..."
    local TMP
    TMP=$(mktemp -d)
    build_dep fetch "$FFMPEG_KEY" "$TMP/ffmpeg.tar.xz"
    tar -xf "$TMP/ffmpeg.tar.xz" -C "$TMP"
    find "$TMP" -name "ffmpeg" -type f -exec cp {} "$DIR/ffmpeg" \;
    chmod +x "$DIR/ffmpeg"
    build_dep record-file "$FFMPEG_KEY" "$DIR/ffmpeg"
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
else
  build_dep verify model "$MODELS_DIR/$(dep '.model.default')"
  if [ "$TARGET" = win ] || [ "$TARGET" = all ]; then
    test "$(build_dep cache whisper-win-cpu "$BIN_DIR/win/cpu")" = valid
    test "$(build_dep cache-file ffmpeg-win "$BIN_DIR/win/ffmpeg.exe")" = valid
    if [ -d "$BIN_DIR/win/vulkan" ]; then
      test "$(build_dep cache whisper-win-vulkan "$BIN_DIR/win/vulkan")" = valid
    fi
  fi
  if [ "$TARGET" = linux ] || [ "$TARGET" = all ]; then
    test "$(build_dep cache whisper-linux-cpu "$BIN_DIR/linux/cpu")" = valid
    test "$(build_dep cache-file "$(linux_ffmpeg_key)" "$BIN_DIR/linux/ffmpeg")" = valid
    if [ -d "$BIN_DIR/linux/vulkan" ]; then
      test "$(build_dep cache whisper-linux-vulkan "$BIN_DIR/linux/vulkan")" = valid
    fi
  fi
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
