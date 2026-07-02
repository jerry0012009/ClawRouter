# ClawRouter — Smart LLM Router

<div align="center">

**The intelligent LLM router that picks the cheapest model for each request.**

22+ models · 15-dimension routing · <1ms local decisions · OpenRouter powered

[![npm version](https://img.shields.io/npm/v/clawrouter.svg)](https://npmjs.com/package/clawrouter)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

</div>

---

## What is ClawRouter?

ClawRouter is a local proxy that intercepts OpenAI-compatible requests, analyzes them across 15 dimensions (token count, code keywords, reasoning markers, technical terms, etc.), and routes to the **cheapest capable model** via OpenRouter.

**Save 60-90% on LLM costs** without sacrificing quality.

```
Your App → localhost:8402 (ClawRouter)
              ↓
         Smart Routing (15-dimension scoring, <1ms)
              ↓
         OpenRouter API (22+ models)
              ↓
         Response → back to your app
```

## Quick Start

```bash
# 1. Install
npm install -g clawrouter

# 2. Set your OpenRouter API key
export OPENROUTER_API_KEY=sk-or-v1-...

# 3. Start the proxy
clawrouter

# 4. Point your app at http://localhost:8402
curl http://localhost:8402/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"auto","messages":[{"role":"user","content":"Hello!"}]}'
```

## Smart Routing

When you send `"model": "auto"`, ClawRouter analyzes your request and picks the best model:

| Request Type | Tier | Selected Model | Cost |
|-------------|------|---------------|------|
| "What is 2+2?" | SIMPLE | Gemini 2.5 Flash | $0.0001 |
| "Write a Python function" | MEDIUM | GPT-4o Mini | $0.001 |
| "Design a distributed system" | COMPLEX | GPT-4o | $0.01 |
| "Prove this theorem step by step" | REASONING | o4-mini | $0.02 |

### Routing Profiles

- `auto` — Intelligent routing (default)
- `eco` — Cheapest models only
- `premium` — Best quality models

### 15-Dimension Scoring

1. Token count
2. Code keywords (9 languages)
3. Reasoning markers
4. Technical terms
5. Creative markers
6. Simple indicators
7. Multi-step patterns
8. Question complexity
9. Imperative verbs
10. Constraint indicators
11. Output format keywords
12. Reference complexity
13. Negation complexity
14. Domain specificity
15. Agentic task detection

## Demo Frontend

Start the proxy and open http://localhost:8402 for an interactive dashboard with:
- Real-time routing decisions
- Model comparison
- Chat testing interface

## Available Models

| Provider | Model | Input $/1M | Output $/1M | Context |
|----------|-------|-----------|------------|---------|
| Google | Gemini 2.5 Flash | $0.15 | $0.60 | 1M |
| Google | Gemini 2.0 Flash | $0.10 | $0.40 | 1M |
| OpenAI | GPT-4o Mini | $0.15 | $0.60 | 128K |
| OpenAI | GPT-4.1 Nano | $0.10 | $0.40 | 1M |
| DeepSeek | DeepSeek V3 | $0.50 | $1.54 | 164K |
| DeepSeek | DeepSeek R1 | $0.55 | $2.19 | 164K |
| Anthropic | Claude Sonnet 4 | $3.00 | $15.00 | 200K |
| Anthropic | Claude Opus 4 | $15.00 | $75.00 | 200K |
| xAI | Grok 3 | $3.00 | $15.00 | 131K |
| Meta | Llama 4 Maverick | $0.20 | $0.60 | 1M |
| ...and more |

## CLI Commands

```bash
clawrouter              # Start proxy (default port 8402)
clawrouter --port 3000  # Custom port
clawrouter setup        # Save API key
clawrouter models       # List all models
clawrouter stats        # Usage statistics
clawrouter status       # Check if proxy is running
```

## Environment Variables

| Variable | Description | Default |
|----------|------------|---------|
| `OPENROUTER_API_KEY` | OpenRouter API key | Required |
| `BLOCKRUN_PROXY_PORT` | Proxy port | 8402 |

## Architecture

```
src/
├── proxy.ts        # HTTP proxy server (840 lines)
├── models.ts       # 22+ model definitions
├── auth.ts         # API key resolution
├── router/         # Smart routing engine
│   ├── rules.ts    # 15-dimension scorer
│   ├── selector.ts # Tier → model selection
│   └── config.ts   # Routing configuration
├── compression/    # Context compression (7 layers)
├── dedup.ts        # Request deduplication
├── session.ts      # Session persistence
└── cli.ts          # CLI entry point
```

## License

MIT
