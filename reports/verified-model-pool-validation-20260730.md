# ACU Verified Model Pool minimum validation

Date: 2026-07-30

Budget: CNY 1.00. Concurrency: 1. Web disabled. Output limit: 8 tokens.

| Model | Text SSE | Tool / Result | Actual model | Usage | Decision |
|---|---|---|---|---|---|
| deepseek-v4-flash | HTTP 200 | HTTP 502 | text identity/usage observed | parsed on text | rejected: tool request failed |
| deepseek-v4-pro | HTTP 200 | HTTP 502 | text identity/usage observed | parsed on text | rejected: tool request failed |
| glm-5.1 | HTTP 502 | not run | unavailable | unavailable | rejected: text request failed |
| glm-5.2 | HTTP 502 | not run | unavailable | unavailable | rejected: text request failed |
| kimi-k2.6 | HTTP 502 | not run | unavailable | unavailable | rejected: text request failed |
| kimi-k2.7-code | HTTP 502 | not run | unavailable | unavailable | rejected: text request failed |
| qwen3.6-plus | HTTP 502 | not run | unavailable | unavailable | rejected: text request failed |
| qwen3.7-max | HTTP 502 | not run | unavailable | unavailable | rejected: text request failed |
| gemini-2.5-flash | HTTP 200 | streaming call emitted tool-shaped output, non-stream call did not produce a tool call | exact on text/tool stream | present but inconsistent across tool modes | rejected: complete tool/result and Usage contract not verified |
| gemini-3.5-flash | HTTP 200 | tool call emitted | returned `gemini-3-flash-agent` | present | rejected: actual model mismatch |

No new model passed every minimum requirement. Existing seven verified Canonical Models remain active. Observed successful-call cost is below CNY 0.02; no failed request is assumed to be unbilled without Provider evidence.
