#!/bin/zsh

set -euo pipefail

exec "$(dirname "$0")/deploy-firebase.sh" "$@"
