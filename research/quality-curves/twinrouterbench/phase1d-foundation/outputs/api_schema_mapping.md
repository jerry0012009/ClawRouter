# API schema mapping audit

The audit is read-only. It inspected the frozen TwinRouterBench rows and ClawRouter's current `src/proxy.ts` parsing path; no production code was changed.

| Target schema | Direct | Field conversion | Information loss | Cannot map reliably |
|---|---:|---:|---:|---:|
| OpenAI Chat Completions | 688 | 248 | 34 | 0 |
| OpenAI Responses | 0 | 936 | 34 | 0 |
| Anthropic Messages | 0 | 936 | 34 | 0 |
| ClawRouter internal request | 722 | 248 | 0 | 0 |

## Mapping rules

- **OpenAI Chat Completions:** preserve `messages`; convert legacy top-level `functions` to `tools: [{type: function, function: ...}]`. Stored assistant `reasoning` is nonstandard and is flagged as information loss rather than silently promoted.
- **OpenAI Responses:** convert ordered messages to Responses input items and convert tool calls/results. The same reasoning caveat applies.
- **Anthropic Messages:** move system content to the top-level `system` field, convert assistant tool calls to `tool_use` blocks, tool messages to user-side `tool_result` blocks, and convert function definitions to Anthropic tools. Stored reasoning cannot be recreated as signed thinking blocks.
- **ClawRouter:** the current proxy reads OpenAI-style `messages` and `tools`, normalizes roles, truncates messages, and routes using the last user message plus the first system message. BFCL's legacy `functions` therefore needs the same deterministic wrapping as Chat Completions.

`full_context_text` is intentionally richer than the current production router prompt extraction. Compatibility here means the request can be represented at the API boundary, not that the production router currently consumes every historical message.
