# Disposable Coding Protocol Sandbox

This directory contains no business data and is the only repository content that native Coding Agent reconnaissance prompts may modify. Every scenario starts from `work/` after running `./reset.sh`.

## Reset

```bash
./test/protocol-sandbox/reset.sh
```

The reset script replaces only `test/protocol-sandbox/work/` from the committed `.seed/work/` tree. It refuses to run if its resolved target is outside this sandbox.

## Scenario matrix

| ID | Task prompt | Deterministic starting result | Expected trajectory |
|---|---|---|---|
| S01 | Read `work/notes/hello.txt` and report the project codename. Do not modify files. | Contains `ORBIT-LANTERN`. | Read → answer. |
| S02 | Fix `add()` in `work/src/math.mjs`, then run tests. | `add(2, 3)` returns `-1`; math check fails. | Read → Edit one file → Test pass. |
| S03 | Run the checks, repair the initial failure, and verify all checks pass. | One math check fails before S02 fix. | Test fail → inspect → Edit → Test pass. |
| S04 | Add `multiply()` in `work/src/math.mjs`, export it from `work/src/index.mjs`, and add a check. | Function and export are absent. | Plan → multi-file Edit → Test. |
| S05 | First understand the service boundaries in `work/ARCHITECTURE.md`; plan a `TaskService.listOpen()` feature, then implement it without coupling storage to formatting. | Architecture and interfaces exist; method is absent. | Read/Search → Plan → multi-file implementation → Test. |
| S06 | Fix `parsePort()` and run checks. If the first attempted fix still accepts `0`, repair it. | Current parser accepts invalid zero and oversized ports; checks fail. | Edit → Test fail is possible → Repair → Test pass. |
| S07 | Read `work/notes/does-not-exist.txt`, explain the error, then recover by locating the correct note. | Requested file does not exist; `hello.txt` does. | File-not-found Tool Error → Search/List → Read → answer. |
| S08 | Run `acu-command-that-does-not-exist`, report the environment error, then continue with `node --version`. | First command is absent. | Command-not-found Tool Error → valid command → answer. |
| S09 | Run `node work/scripts/require-env.mjs` without setting variables, explain the failure, then rerun with `SANDBOX_ALLOWED=1`. | First run exits 13; second exits 0. | Environment Error → diagnose → corrected command. |
| S10 | Plan and complete: fix math, implement multiply/export/check, run all checks, repair any failure, and summarize changed files. | Combines S02/S03/S04. | Plan → Execution → Test fail/pass → Repair if needed → final verification. |

## Commands and expected outcomes

From `test/protocol-sandbox/work`:

```bash
npm test
```

The untouched seed exits non-zero with named assertion failures. After the relevant scenario fix, it exits zero. The sandbox has no package dependencies and requires only Node.js.

Do not manufacture Tool Schema errors by patching native clients. S07–S09 use ordinary filesystem, shell and environment failures that native clients can encounter normally.
