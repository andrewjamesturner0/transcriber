#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
BIN_DIR="$PROJECT_DIR/bin/linux"
MODELS_DIR="$PROJECT_DIR/models"
BUILD_DIR="$PROJECT_DIR/.build-whisper"

mkdir -p "$BIN_DIR" "$MODELS_DIR"

# --- 1. Build whisper.cpp ---
echo "==> Building whisper.cpp..."
if [ ! -d "$BUILD_DIR" ]; then
  git clone --depth 1 https://github.com/ggml-org/whisper.cpp.git "$BUILD_DIR"
fi

cmake -S "$BUILD_DIR" -B "$BUILD_DIR/build" -DCMAKE_BUILD_TYPE=Release
cmake --build "$BUILD_DIR/build" -j"$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 4)" --config Release

# Find and copy the whisper-cli binary
WHISPER_BIN=$(find "$BUILD_DIR/build" -name "whisper-cli" -type f | head -1)
if [ -z "$WHISPER_BIN" ]; then
  # Older versions may call it "main"
  WHISPER_BIN=$(find "$BUILD_DIR/build" -name "main" -type f -path "*/bin/*" | head -1)
fi
if [ -z "$WHISPER_BIN" ]; then
  echo "ERROR: Could not find whisper-cli binary after build"
  exit 1
fi
cp "$WHISPER_BIN" "$BIN_DIR/whisper-cli"
chmod +x "$BIN_DIR/whisper-cli"
echo "    whisper-cli -> $BIN_DIR/whisper-cli"

# Copy shared libraries needed by whisper-cli
echo "    Copying shared libraries..."
find "$BUILD_DIR/build" -name "libwhisper.so*" -exec cp {} "$BIN_DIR/" \;
find "$BUILD_DIR/build" -name "libggml*.so*" -exec cp {} "$BIN_DIR/" \;

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
if [ -f "$BIN_DIR/ffmpeg" ]; then
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
      find "$TMPDIR_FF" -name "ffmpeg" -type f -exec cp {} "$BIN_DIR/ffmpeg" \;
      rm -rf "$TMPDIR_FF"
      ;;
    Darwin)
      # macOS - use ffmpeg from evermeet.cx or homebrew
      if command -v brew &>/dev/null; then
        FFMPEG_PATH="$(brew --prefix ffmpeg 2>/dev/null)/bin/ffmpeg" || true
        if [ -f "$FFMPEG_PATH" ]; then
          cp "$FFMPEG_PATH" "$BIN_DIR/ffmpeg"
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
      echo "Unsupported OS: $OS. Please place ffmpeg binary in $BIN_DIR manually."
      exit 1
      ;;
  esac
  chmod +x "$BIN_DIR/ffmpeg"
  echo "    ffmpeg -> $BIN_DIR/ffmpeg"
fi

echo ""
echo "==> Setup complete!"
echo "    Run 'npm start' to launch the app."
