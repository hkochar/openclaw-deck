# Deck vs. Alternatives

## What Deck Is

Deck is the **ops dashboard built for OpenClaw**. If you run OpenClaw agents, Deck gives you cost tracking, budget enforcement, drift detection, and operational control — out of the box, with zero SDK integration.

It's not a general-purpose LLM observability platform. It doesn't try to support every framework. It does one thing — OpenClaw agent operations — and does it deeply.

## What Only Deck Does

These features don't exist in any other open-source tool:

**Budget kill switch** — Set a daily limit. When an agent hits it, the gateway blocks further LLM calls. Not an alert you might miss at 2am — an actual enforcement. This exists because a recursive loop once burned $1,410 in 6 hours.

**Discord operations** — Restart services, check agent status, revert broken configs — all from Discord. Your agents already live in Discord; your ops should too.

**Stuck loop detection** — If an agent calls the same tool with the same arguments 5 times in a row, Deck catches it and alerts you before it burns through your budget.

**Model drift detection** — When an agent quietly starts using a different model than configured (provider fallback, config typo, API routing), Deck catches the mismatch in real-time.

**Config management with one-click revert** — Change agent configs from the dashboard. If something breaks, revert to the last working version instantly.

**Zero-setup monitoring** — If your agents talk through the OpenClaw gateway, they're monitored automatically. No SDK. No environment variables. No proxy latency. Install the plugin, restart the gateway, done.

**SQLite simplicity** — One file. No ClickHouse cluster, no Redis, no S3 buckets. Back it up with `cp`. Query it with any SQLite client. Move it to a new machine by copying a file.

## How Deck Compares

| Capability | Deck | Langfuse | Helicone | LangSmith | AgentOps |
|------------|:----:|:--------:|:--------:|:---------:|:--------:|
| Self-hosted | Yes | Yes | Yes | Enterprise only | No |
| Open source | Yes | Yes | Yes | No | No |
| Setup time | ~10 min | 1-2 hours | ~15 min | ~5 min | ~5 min |
| Infrastructure | SQLite | ClickHouse + Redis + S3 | Proxy | Cloud | Cloud |
| Cost tracking | Yes | Yes | Yes | Yes | Yes |
| Budget enforcement | **Yes** | No | No | No | No |
| Kill runaway agents | **Yes** | No | No | No | No |
| Model drift alerts | **Yes** | No | No | No | No |
| Stuck loop detection | **Yes** | No | No | No | No |
| Discord ops | **Yes** | No | No | No | No |
| Config management | **Yes** | No | No | No | No |
| Agent silence alerts | **Yes** | No | No | No | No |
| Multi-framework | No | Yes | Yes | LangChain | Python |
| Prompt versioning | No | Yes | No | Yes | No |
| Trace visualization | Basic | Advanced | Basic | Advanced | Advanced |
| Evaluation suite | No | Yes | No | Yes | Yes |
| Semantic caching | No | No | Yes | No | No |

## Where Alternatives Are Stronger

We believe in being honest about this.

**Langfuse** has the best prompt versioning and evaluation workflow in open source. If you're running experiments across prompt variants and need structured eval pipelines, Langfuse is excellent. It also supports every major framework (LangChain, LlamaIndex, OpenAI SDK, etc.), while Deck is OpenClaw-only.

**Helicone** has the fastest setup — change one base URL and you're proxied. It also offers semantic caching that can cut costs 20-40% by deduplicating similar requests. Deck doesn't cache.

**LangSmith** has the deepest trace visualization and step-by-step debugging. If you're building with LangChain and need to inspect every chain step, it's the most polished experience.

**AgentOps** has the best time-travel debugging with visual waterfall timelines. If you're debugging complex Python agent workflows, the replay experience is genuinely impressive.

## When to Use Deck

Use Deck if:
- You run OpenClaw agents and want operational visibility
- You need budget enforcement, not just budget tracking
- You want to operate from Discord
- You prefer self-hosted with zero cloud dependencies
- You value simplicity (SQLite, Next.js, done)

Use something else if:
- You're not using OpenClaw (Langfuse or Helicone are great choices)
- You need multi-framework support across LangChain, LlamaIndex, etc.
- You need structured evaluation pipelines with prompt A/B testing
- You need semantic caching to reduce API costs

## The Bottom Line

Most observability tools answer: *"What happened in this LLM call?"*

Deck answers: *"What are my agents doing right now, and is it under control?"*

If you run OpenClaw agents, nothing else gives you this. If you don't, the alternatives are genuinely good — go use them.
