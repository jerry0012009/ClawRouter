# Observation

状态：实测确认（真实 Provider，Capture A）。`--permission-mode plan` 请求具有只读 Plan system 指令和受限 Tool 集；实际 `ExitPlanMode` Tool Use 是结束 Planning 的强信号。批准后恢复为可修改 Tool 集并进入 Execution；测试暴露新失败后继续修复并通过。Thinking signature 和 cache usage 均在本 Fixture 出现。
