# C06 observation — explicit Planning through CloseAI

- 状态：实测确认（用户明确要求 Planning 的子场景）。
- 客户端：Codex CLI 0.145.0。
- 链路：Codex → Capture A → CloseAI `/v1/responses`。
- Fixture：`codex-0.145.0-C06-closeai-001`。
- 生产规则适用性：实际 `update_plan` Tool Call 是强 Planning 信号候选；仅声明该 Tool 仍是弱信号。

## Measured result

The native client completed a disposable multi-file Coding task with eight successful Responses Steps. The user explicitly required a maintained plan, an initial failing test run, implementation, repair of remaining failures, and final verification.

Observed high-level trajectory:

1. `update_plan` Function Call created a five-item plan.
2. `exec_command` ran the untouched suite; it exited 1 with three expected failing check files.
3. `update_plan` marked the initial-test item complete and left inspection active.
4. Multiple read/search shell calls inspected checks and source files.
5. Another tool Step prepared the implementation actions.
6. `update_plan` marked inspection complete.
7. A code mutation Tool Call changed five sandbox files; subsequent test execution passed all five checks.
8. Final `update_plan` completed the plan and the assistant summarized the verified changes.

An actual `update_plan` call and its later updates are directly observable as Responses Function Calls and matching outputs. This is materially stronger than the `update_plan` schema appearing in every request. Plan state was not sent as a special top-level Responses field; it re-entered later requests through the accumulated Function Call / Output history.

After the initial expected test failure, the client updated the plan and continued with the same Session/Thread correlation headers and requested model. No `previous_response_id` appeared; the input history grew with reasoning, messages, calls and outputs. Cached input usage increased across Steps (from zero to more than 15k cached tokens in later calls).

The run produced a real Plan → Execution → Test failure → Plan update/Repair → final passing Test trajectory. It did not prove autonomous Planning without a user request, a distinct Plan Mode, or Replanning after a post-edit regression.

## Limitations

- No New API or ACU hop was present; Planning structures may still be transformed there.
- The code-mutation transport includes a Codex custom tool item in later history; detailed custom-tool normalization needs a dedicated Fixture assertion.
- One model/task trace cannot define universal Planning end detection. A completed `update_plan` plus successful final verification is strong here, but first Edit alone should remain a supporting signal.
