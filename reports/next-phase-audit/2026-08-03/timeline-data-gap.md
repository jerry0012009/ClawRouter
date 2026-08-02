# Timeline observability gaps

| Data | Router DB | Router Trace | New API DTO | Timeline | Session Trace |
|---|---:|---:|---:|---:|---:|
| Work Phase | yes | yes | no | no | no |
| Work Phase Offset | yes | yes | no | no | no |
| Judge Trigger | yes | yes | Session only | no | yes |
| Judge Status | yes | yes | Session only | no | yes |
| Judge Result Source | yes | yes | no | no | no |
| Judge Attempt Chain | yes | yes | partial | no | yes, partial |
| Judge Profile ID | metadata only | metadata only | no | no | no |
| Difficulty | yes | yes | yes | yes | yes |
| Confidence | yes | yes | Session only | no | yes |
| selectedCandidateId | yes | yes | no | no | no |
| selectedExecutionPresetId | yes | yes | no | no | no |
| selectedDisplayName | candidate estimate | yes | no | no | no |
| client/preset/target/resolved Effort | yes | yes | no | no | no |
| mappingStatus | yes | yes | no | no | no |
| Pareto Candidates | yes | yes | IDs only in Session | no | IDs only |
| Candidate Quality/Cost/Utility | yes | yes | discarded | no | no |
| Profile Attempt Chain | yes | yes | partial | collapsed | yes |
| Recovery Reason | yes | yes | synthetic/partial | error only | partial |
| Cache Input Tokens | yes | yes | no | no | no |
| Reasoning Tokens | yes | yes | no | no | no |
| Actual Cost | yes | yes | yes | yes | yes |
| First Event Latency | metadata | yes | yes | yes | yes |

Router Trace already exposes most missing data. New API's raw trace decoder receives route formula, candidate estimates and provider metadata, then its public DTO discards them. Timeline is even narrower: it is reconstructed from New API usage-log `acu_cost_breakdown` and displays time, difficulty, model/provider/channel, latency, status and cost.

Judge normalized persistence loses `executionProfileId`, channel, parser exception and backup reason; newer Segment `judgeRun` preserves them. This makes historical Profile diagnosis dependent on JSON metadata rather than the attempt table.

The UI cannot directly answer “why this candidate, effort and Profile, and what changed on retry.” Users must infer from model/channel and open Session Trace, which still lacks Work Phase, Preset and Effort decisions.
