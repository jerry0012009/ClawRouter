# Pricing and Luna Max

## Current public data

`/api/pricing` returns 16 public entries: `acu-auto` plus 15 canonical model cards. It has one canonical `gpt-5.6-luna` entry and no Luna Max card, as intended by the current catalog overlay.

For `/api/pricing/acu-selection-corridor?input_tokens=100000&output_tokens=4000`, the API returns Luna Max as:

- `candidateId=gpt-5.6-luna@max`
- `modelId=gpt-5.6-luna`
- `executionPresetId=gpt-5.6-luna:max`
- `reasoningEffort=max`
- `estimatedCallCost=0.002768 CNY` for this workload
- quality varies with difficulty (for example 100 at D0 and 90.1944 at D38)

The exposed Pareto corridor contains four unique candidate identities across all points (`glm-5.2`, Luna Max, Sol, Kimi K3) and four canonical model IDs. It is a selected/near-optimal corridor, not the full execution candidate pool. Base Luna never appears in this corridor sample; Luna Max does.

| Preference | Luna Max selected | Present as corridor candidate |
|---|---|---|
| economy | D0-D36, 19/51 points | D0-D44, 23/51 |
| balanced | D0-D36, 19/51 | D0-D44, 23/51 |
| quality | D0-D32, 17/51 | D0-D32, 17/51 |

## Field chain

| Luna Max field | ClawRouter API | New API backend proxy | Frontend type | UI |
|---|---:|---:|---:|---:|
| candidateId | yes | transparent map proxy | no | no |
| modelId | yes | yes | yes | yes, canonical Luna |
| executionPresetId | yes | transparent | no | no |
| reasoningEffort | yes | transparent | no | no |
| estimatedQuality | yes | transparent | type uses `quality` only | selected quality shown |
| estimatedCallCost | yes | transparent | type uses `costCny` only | selected cost shown |
| valueUtility | yes | transparent | yes | not shown |
| selectedCandidateId | yes | transparent | no | no; reads `selectedModelId` |

The New API endpoint calls Router and decodes into `map[string]interface{}`; no backend DTO strips the new fields. Therefore current loss occurs in frontend TypeScript and rendering. `ACUSelectionCandidate` declares only `modelId/quality/costCny/valueUtility`; the corridor point declares only `selectedModelId`. Candidate React keys and labels use `candidate.modelId`, so Luna Max is collapsed to canonical `GPT-5.6 Luna`. The public model curves and cost bars are built exclusively from canonical `/api/pricing` models, so no Preset curve/bar can be drawn from that source.

Backend changes are not required merely to preserve the already proxied Corridor fields. A separate public Luna Max card/curve would require a product decision about merging canonical catalog and execution candidates; this audit does not recommend that implementation.

## Screenshots

- `screenshots/pricing/pricing-1440x900-full.png`
- `screenshots/pricing/pricing-1920x1080-full.png`
- `screenshots/pricing/quality-curves.png`
- `screenshots/pricing/cost-bars.png`
- `screenshots/pricing/selection-corridor-tooltip.png`

All are anonymous public-page captures. No account data is present.
