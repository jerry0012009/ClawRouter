#!/usr/bin/env sh
set -eu

bin_dir=${CODEX_ACU_BIN_DIR:-${HOME}/.local/bin}
acu_home=${CODEX_ACU_HOME:-${XDG_DATA_HOME:-${HOME}/.local/share}/codex-acu}
wrapper="$bin_dir/codex-acu"
if [ -f "$wrapper" ]; then
  rm -f "$wrapper"
fi
echo "removed launcher: $wrapper"
echo "state was retained at: $acu_home"
echo "archive or remove that exact directory manually after reviewing saved sessions"
