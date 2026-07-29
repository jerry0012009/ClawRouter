# codex-acu

`codex-acu` is a thin launcher around the installed native Codex CLI. It uses a separate `CODEX_HOME`, config, sessions, logs, and auth state, so it never reads or overwrites the user's normal `~/.codex` configuration. The API key is stored as a single line in the mode-`600` file `~/.local/share/codex-acu/credentials`; it is never written to `config.toml`.

Install after the Founder HTTPS host is available:

```bash
tools/codex-acu/install.sh --base-url https://<FOUNDER_ACU_HOST>/v1
codex-acu credentials set
codex-acu doctor
codex-acu -C /path/to/disposable/repository
```

Verify isolation:

```bash
codex_home_before=$(sha256sum "${CODEX_HOME:-${HOME}/.codex}/config.toml" 2>/dev/null || true)
codex-acu doctor
codex_home_after=$(sha256sum "${CODEX_HOME:-${HOME}/.codex}/config.toml" 2>/dev/null || true)
test "$codex_home_before" = "$codex_home_after"
```

Uninstall the launcher while retaining auditable session state:

```bash
tools/codex-acu/uninstall.sh
```

The scripts require an HTTPS Base URL ending in `/v1`. They do not install, update, patch, or replace the native `codex` binary.

Credential and installation checks:

```bash
codex-acu home
codex-acu credentials status
codex-acu credentials set
codex-acu credentials clear
codex-acu doctor
```
