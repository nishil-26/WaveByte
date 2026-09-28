#!/usr/bin/env bash
# WaveByte CLI installer — macOS / Linux.
# Installs sox (audio I/O) if missing, then installs the `wavebyte` command
# globally via npm, straight from this GitHub repo (no npm-registry publish
# needed). This script itself is fetched over the internet, same as any
# install step for any tool — the point of WaveByte is that AFTER this
# one-time setup, no internet or shared network is used between the two
# laptops ever again; only sound.
set -e

REPO="github:nishil-26/WaveByte"

echo "==> WaveByte CLI installer"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required but wasn't found. Install Node.js 18+ from https://nodejs.org, then re-run this script." >&2
  exit 1
fi

if ! command -v sox >/dev/null 2>&1; then
  echo "==> Installing sox (used for microphone/speaker access)..."
  if [[ "$(uname)" == "Darwin" ]]; then
    if ! command -v brew >/dev/null 2>&1; then
      echo "Homebrew wasn't found. Install it from https://brew.sh, then re-run this script." >&2
      exit 1
    fi
    brew install sox
  elif command -v apt-get >/dev/null 2>&1; then
    sudo apt-get update -y && sudo apt-get install -y sox
  elif command -v dnf >/dev/null 2>&1; then
    sudo dnf install -y sox
  elif command -v pacman >/dev/null 2>&1; then
    sudo pacman -Sy --noconfirm sox
  else
    echo "Couldn't detect a supported package manager. Install 'sox' manually for your distro, then re-run this script." >&2
    exit 1
  fi
else
  echo "==> sox already installed."
fi

echo "==> Installing the wavebyte command..."
npm install -g "$REPO"

echo ""
echo "Done. On each laptop, first run:  wavebyte calibrate"
echo "Then just run:                    wavebyte"
