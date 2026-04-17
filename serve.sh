#!/bin/zsh

set -euo pipefail

RUSTUP_TOOLCHAIN_BIN="${HOME}/.rustup/toolchains/stable-aarch64-apple-darwin/bin"
TRUNK_BIN="${HOME}/.cargo/bin/trunk"

if [[ ! -x "${TRUNK_BIN}" ]]; then
  echo "trunk is not installed at ${TRUNK_BIN}" >&2
  echo "Install it with: cargo install trunk" >&2
  exit 1
fi

if [[ ! -d "${RUSTUP_TOOLCHAIN_BIN}" ]]; then
  echo "rustup stable toolchain bin directory not found: ${RUSTUP_TOOLCHAIN_BIN}" >&2
  echo "Install Rust via rustup and add the wasm target first." >&2
  exit 1
fi

export PATH="${RUSTUP_TOOLCHAIN_BIN}:${PATH}"
export NO_COLOR=true

exec "${TRUNK_BIN}" serve --open "$@"
