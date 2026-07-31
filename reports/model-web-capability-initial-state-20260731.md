# ACU model Web capability initial state

Date: 2026-07-31

## Meaning of the states

- `supported`: the model/vendor API has an official hosted-search integration, or ACU has already observed a complete hosted-search lifecycle for this canonical model.
- `unsupported`: the official API exposes client function calling but no provider-hosted search integration. Client-side Web tools remain usable.
- `unknown`: the available official material does not establish hosted-search support for this exact model.
- `verified`: ACU observed declaration acceptance, execution lifecycle, streaming output, and a search result on this Execution Profile.
- `compatible_unverified`: the native request and adapter can pass the declaration through, but this private relay has not completed ACU's lifecycle verification.
- `incompatible`: ACU has direct Profile-specific evidence of a rejected or incomplete hosted-search lifecycle.

Model support never changes because of a timeout, 5xx response, cooldown, or ordinary Channel health event. Profile transport evidence can change from real execution observations.

## Official evidence

| Vendor | Evidence | ACU interpretation |
| --- | --- | --- |
| OpenAI | [Web search](https://developers.openai.com/api/docs/guides/tools-web-search) documents Responses `web_search`, uses GPT-5.6 in the canonical example, and recommends GPT-5.5 for agentic search. | GPT-5.5 and GPT-5.6 family are `supported`. GPT-5.4 Mini remains `supported` because ACU has a complete production preflight lifecycle. |
| Anthropic | [Web search tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool) documents the Messages server tool and its `server_tool_use` / `web_search_tool_result` lifecycle. Availability varies by hosting platform; it is not available on Amazon Bedrock. | Current Claude canonical models are model-level `supported`; every private relay remains Profile-level `compatible_unverified` until observed. |
| Google | [Grounding with Google Search](https://ai.google.dev/gemini-api/docs/google-search) explicitly lists Gemini 2.5 Flash and Gemini 3.5 Flash as supported. | Both canonical models are `supported`; OpenAI-compatible relay translation remains unverified. |
| Z.AI | [Web Search](https://docs.z.ai/guides/tools/web-search) documents Web Search in Chat integrated with GLM generation. | GLM 5.1 and GLM 5.2 are provisionally model-level `supported`; private relay protocol execution remains unverified. |
| Moonshot | [Kimi Web Search](https://platform.kimi.com/docs/guide/use-web-search) explicitly documents `$web_search` for Kimi K3 and K2.6. | Kimi K3 and K2.6 are `supported`; K2.7 Code is `unknown`. The official flow is multi-turn, so relay execution must still be verified. |
| Alibaba Cloud | [Model Studio Web search](https://www.alibabacloud.com/help/en/model-studio/web-search) documents Responses `web_search` for Qwen 3.5 and later Max, Plus, and Flash models. | Qwen 3.5 Flash, 3.6 Plus, and 3.7 Max are `supported`. |
| DeepSeek | [Function calling](https://api-docs.deepseek.com/guides/function_calling) documents client-executed functions but does not expose a provider-hosted search tool. | Current DeepSeek canonical models are `unsupported` for hosted search, while client-side search functions remain allowed. |

## Current active routing models

| Canonical model | Initial model capability | Native ACU protocol in active pool | Initial behavior for declared hosted Web |
| --- | --- | --- | --- |
| gpt-5.4-mini | supported | Responses, Messages | Verified Profiles first, otherwise optimistic pass-through |
| gpt-5.5 | supported | Responses, Messages | Optimistic pass-through |
| gpt-5.6-luna | supported | Responses, Messages | Verified Profiles first; its BlackAI preflight failure remains incompatible |
| gpt-5.6-terra | supported | Responses, Messages | Verified Profiles first; its BlackAI preflight failure remains incompatible |
| gpt-5.6-sol | supported | Responses | Optimistic pass-through; its BlackAI preflight failure remains incompatible |
| claude-fable-5 | supported | Messages | Optimistic native Messages pass-through |
| claude-opus-4-8 | supported | Messages | Optimistic native Messages pass-through |
| claude-sonnet-5 | supported | Messages | Optimistic native Messages pass-through |
| gemini-2.5-flash | supported | Responses | Optimistic pass-through; relay translation is not claimed as verified |
| glm-5.1 | supported | Responses | Optimistic pass-through |
| glm-5.2 | supported | Responses, Messages | Optimistic pass-through |
| kimi-k2.6 | supported | Messages | Optimistic pass-through; official multi-turn lifecycle remains unverified on relay |
| kimi-k2.7-code | unknown | Messages | Not admitted for provider-hosted Web; client-side Web tools still work |
| kimi-k3 | supported | Responses | Optimistic pass-through; official multi-turn lifecycle remains unverified on relay |
| deepseek-v4-flash | unsupported | Messages | Not admitted for provider-hosted Web; client-side Web tools still work |

## Profile evidence baseline

- Active Execution Profiles: 75.
- Complete ACU Web lifecycle verified: 4.
- Explicit `web_search_output_item_missing` incompatibilities: 3, all on `blackai-codex-mix-low` for GPT-5.6 Luna, Terra, and Sol.
- Every other eligible private relay starts as `compatible_unverified`, not `verified` and not `incompatible`.
- `not_verified_for_full_pool_profile` is absence of evidence and never blocks routing.

Pure local admission replay over the 75 active Profiles produced:

| Model | Verified | Optimistic | Explicitly incompatible | Model/protocol blocked |
| --- | ---: | ---: | ---: | ---: |
| gpt-5.4-mini | 1 | 9 | 0 | 0 |
| gpt-5.5 | 0 | 12 | 0 | 0 |
| gpt-5.6-luna | 1 | 10 | 1 | 0 |
| gpt-5.6-terra | 2 | 4 | 1 | 0 |
| gpt-5.6-sol | 0 | 9 | 1 | 0 |
| claude-fable-5 | 0 | 1 | 0 | 0 |
| claude-opus-4-8 | 0 | 8 | 0 | 0 |
| claude-sonnet-5 | 0 | 6 | 0 | 0 |
| gemini-2.5-flash | 0 | 1 | 0 | 0 |
| glm-5.1 | 0 | 1 | 0 | 0 |
| glm-5.2 | 0 | 3 | 0 | 0 |
| kimi-k2.6 | 0 | 1 | 0 | 0 |
| kimi-k2.7-code | 0 | 0 | 0 | 1 |
| kimi-k3 | 0 | 1 | 0 | 0 |
| deepseek-v4-flash | 0 | 0 | 0 | 1 |

## Runtime transitions

1. A complete hosted-search lifecycle promotes the Profile to `verified`.
2. A clear tool/protocol rejection marks only that Profile `incompatible`.
3. A successful HTTP response that repeatedly omits the required search lifecycle becomes `incompatible` after repeated evidence, not after one observation.
4. Timeout, 429, 5xx, 524, cancellation, and Channel cooldown do not change model capability.
5. Client-side Web functions bypass the hosted-search capability gate entirely.
