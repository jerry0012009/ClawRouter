#!/usr/bin/env sh
set -eu

usage() {
  echo "usage: install.sh --base-url https://acu.example.com/v1 [--bin-dir DIR] [--acu-home DIR]" >&2
}

base_url=
bin_dir=${CODEX_ACU_BIN_DIR:-${HOME}/.local/bin}
acu_home=${CODEX_ACU_HOME:-${XDG_DATA_HOME:-${HOME}/.local/share}/codex-acu}
while [ "$#" -gt 0 ]; do
  case "$1" in
    --base-url) base_url=${2:-}; shift 2 ;;
    --bin-dir) bin_dir=${2:-}; shift 2 ;;
    --acu-home) acu_home=${2:-}; shift 2 ;;
    *) usage; exit 2 ;;
  esac
done

case "$base_url" in
  https://*/v1) ;;
  *) echo "--base-url must be an HTTPS URL ending in /v1" >&2; exit 2 ;;
esac
command -v codex >/dev/null 2>&1 || { echo "native codex is not installed" >&2; exit 1; }

mkdir -p "$bin_dir" "$acu_home"
chmod 700 "$acu_home"
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cp "$script_dir/codex-acu" "$bin_dir/codex-acu"
chmod 755 "$bin_dir/codex-acu"
config_tmp="$acu_home/config.toml.tmp"
cat >"$config_tmp" <<EOF
model = "acu-auto"
model_provider = "acu-founder-alpha"
model_reasoning_effort = "medium"

[model_providers.acu-founder-alpha]
name = "ACU Router Founder Alpha"
base_url = "$base_url"
env_key = "ACU_API_KEY"
wire_api = "responses"
EOF
chmod 600 "$config_tmp"
mv "$config_tmp" "$acu_home/config.toml"
native_config=${CODEX_NATIVE_HOME:-${HOME}/.codex}/config.toml
if [ -f "$native_config" ]; then
  sha256sum "$native_config" | awk '{print $1}' > "$acu_home/native-config.sha256"
else
  printf '%s\n' MISSING > "$acu_home/native-config.sha256"
fi
chmod 600 "$acu_home/native-config.sha256"

echo "installed: $bin_dir/codex-acu"
echo "isolated CODEX_HOME: $acu_home"
echo "configure the key once with: codex-acu credentials set"
echo "then verify with: codex-acu doctor"
