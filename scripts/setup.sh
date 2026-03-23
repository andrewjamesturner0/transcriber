#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
PLATFORM_DIR="$PROJECT_DIR/bin/linux"
CPU_DIR="$PLATFORM_DIR/cpu"
MODELS_DIR="$PROJECT_DIR/models"
BUILD_DIR="$PROJECT_DIR/.build-whisper"

mkdir -p "$CPU_DIR" "$MODELS_DIR"

# --- 1. Build whisper.cpp (CPU) ---
echo "==> Building whisper.cpp (CPU)..."
if [ ! -d "$BUILD_DIR" ]; then
  git clone --depth 1 https://github.com/ggml-org/whisper.cpp.git "$BUILD_DIR"
fi

cmake -S "$BUILD_DIR" -B "$BUILD_DIR/build-cpu" -DCMAKE_BUILD_TYPE=Release
cmake --build "$BUILD_DIR/build-cpu" -j"$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 4)" --config Release

# Find and copy the whisper-cli binary
WHISPER_BIN=$(find "$BUILD_DIR/build-cpu" -name "whisper-cli" -type f | head -1)
if [ -z "$WHISPER_BIN" ]; then
  # Older versions may call it "main"
  WHISPER_BIN=$(find "$BUILD_DIR/build-cpu" -name "main" -type f -path "*/bin/*" | head -1)
fi
if [ -z "$WHISPER_BIN" ]; then
  echo "ERROR: Could not find whisper-cli binary after build"
  exit 1
fi
cp "$WHISPER_BIN" "$CPU_DIR/whisper-cli"
chmod +x "$CPU_DIR/whisper-cli"
echo "    whisper-cli -> $CPU_DIR/whisper-cli"

# Copy shared libraries needed by whisper-cli
echo "    Copying shared libraries..."
find "$BUILD_DIR/build-cpu" -name "libwhisper.so*" -exec cp {} "$CPU_DIR/" \;
find "$BUILD_DIR/build-cpu" -name "libggml*.so*" -exec cp {} "$CPU_DIR/" \;

# --- 1b. Build whisper.cpp (Vulkan) if libvulkan-dev is installed ---
if command -v glslc &>/dev/null && { pkg-config --exists vulkan 2>/dev/null || [ -f /usr/include/vulkan/vulkan.h ]; }; then
  VULKAN_DIR="$PLATFORM_DIR/vulkan"
  mkdir -p "$VULKAN_DIR"
  echo "==> Building whisper.cpp (Vulkan)..."
  cmake -S "$BUILD_DIR" -B "$BUILD_DIR/build-vulkan" -DCMAKE_BUILD_TYPE=Release -DGGML_VULKAN=ON
  cmake --build "$BUILD_DIR/build-vulkan" -j"$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 4)" --config Release

  WHISPER_BIN=$(find "$BUILD_DIR/build-vulkan" -name "whisper-cli" -type f | head -1)
  cp "$WHISPER_BIN" "$VULKAN_DIR/whisper-cli"
  chmod +x "$VULKAN_DIR/whisper-cli"
  echo "    whisper-cli (vulkan) -> $VULKAN_DIR/whisper-cli"
  find "$BUILD_DIR/build-vulkan" -name "libwhisper.so*" -exec cp {} "$VULKAN_DIR/" \;
  find "$BUILD_DIR/build-vulkan" -name "libggml*.so*" -exec cp {} "$VULKAN_DIR/" \;
else
  echo "==> Vulkan SDK not found, skipping Vulkan build (install libvulkan-dev glslc for GPU support)"
fi

# --- 2. Download model ---
MODEL_FILE="$MODELS_DIR/ggml-tiny.en.bin"
if [ ! -f "$MODEL_FILE" ]; then
  echo "==> Downloading tiny.en model..."
  curl -L -o "$MODEL_FILE" \
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en.bin"
else
  echo "==> Model already exists, skipping download."
fi

# --- 3. Get ffmpeg ---
if [ -f "$PLATFORM_DIR/ffmpeg" ]; then
  echo "==> ffmpeg already exists, skipping."
else
  echo "==> Downloading ffmpeg static binary..."
  OS="$(uname -s)"
  ARCH="$(uname -m)"

  case "$OS" in
    Linux)
      case "$ARCH" in
        x86_64)  FFMPEG_URL="https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz" ;;
        aarch64) FFMPEG_URL="https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-arm64-static.tar.xz" ;;
        *)       echo "Unsupported arch: $ARCH"; exit 1 ;;
      esac
      TMPDIR_FF=$(mktemp -d)
      curl -L -o "$TMPDIR_FF/ffmpeg.tar.xz" "$FFMPEG_URL"
      tar -xf "$TMPDIR_FF/ffmpeg.tar.xz" -C "$TMPDIR_FF"
      find "$TMPDIR_FF" -name "ffmpeg" -type f -exec cp {} "$PLATFORM_DIR/ffmpeg" \;
      rm -rf "$TMPDIR_FF"
      ;;
    Darwin)
      # macOS - use ffmpeg from evermeet.cx or homebrew
      if command -v brew &>/dev/null; then
        FFMPEG_PATH="$(brew --prefix ffmpeg 2>/dev/null)/bin/ffmpeg" || true
        if [ -f "$FFMPEG_PATH" ]; then
          cp "$FFMPEG_PATH" "$PLATFORM_DIR/ffmpeg"
        else
          echo "Install ffmpeg via: brew install ffmpeg"
          echo "Then re-run this script."
          exit 1
        fi
      else
        echo "Install Homebrew and ffmpeg: brew install ffmpeg"
        exit 1
      fi
      ;;
    *)
      echo "Unsupported OS: $OS. Please place ffmpeg binary in $PLATFORM_DIR manually."
      exit 1
      ;;
  esac
  chmod +x "$PLATFORM_DIR/ffmpeg"
  echo "    ffmpeg -> $PLATFORM_DIR/ffmpeg"
fi

echo ""
echo "==> Setup complete!"
echo "    Run 'npm start' to launch the app."
