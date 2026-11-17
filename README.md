# AgentEval

**A self-hosted quality-engineering platform for AI agents.** AgentEval records every run of an agent as a *trace*, scores what the agent **said** (accuracy, hallucination, relevance, …) and what it **did** (tool choice, parameters, execution), explains *why* a run went wrong, watches production traffic, and alerts you when quality, cost or reliability degrades.

Version `0.6.0` · Node.js 20+ · Python 3.10+ · MongoDB 7 · Docker Compose

---

## Why it exists

Agents built with LangChain, LangGraph or plain code fail in ways unit tests do not catch: a tool returns ₹47,999 and the final answer says ₹52,999; a step errors but the run reports success; quality quietly drops after a prompt change. Generic APM tools show latency and errors but cannot tell you that an answer was *wrong* or *unsupported by its own tool output*.

AgentEval answers three questions with evidence:

1. **Is this agent any good?** Run it against a test suite and get explainable, versioned scores.
2. **Why did this run go wrong?** Open the trace and see which step is suspect, with a stated level of certainty.
3. **Is it still good in production?** Sample live traffic, track error rate, latency, cost and quality, and get alerted on regressions.

Everything runs on your own infrastructure. There is no vendor control plane, licence check or telemetry. The only outbound calls go to an AI-judge provider *you* configure (optional), webhook URLs *you* set, and your own agents' endpoints.

## Who it is for

| User | What they do with it |
|---|---|
| **AI / agent engineers** | Instrument an agent with the Python SDK (or REST), build test suites, compare versions, debug failing runs |
| **QA and product owners** | Review evaluation runs, dashboards and failed cases without writing code |
| **Platform / DevOps** | Deploy with Docker Compose, manage HTTPS, backups, upgrades, retention |
| **Team admins** | Manage the organization: members, roles, invitations, API keys, audit log |

## Design principles

* **Honest statuses.** Score, confidence and threshold are separate. Weak evidence produces `inconclusive`, never a silent pass.
* **Rules first, AI judge second.** Deterministic evaluators decide what they can; the optional LLM judge only refines uncertain items, and its verdicts count only if they quote real evidence.
* **Reproducible.** Runs pin evaluator versions and configs; the engine is deterministic for the same input.
* **Tenant-isolated and secure by default.** Three layers of organization isolation, SSRF-guarded outbound calls, encrypted secrets, short-lived sessions.

## Features

| Area | What it does |
|---|---|
| **Traces** | Python SDK (LangChain, LangGraph, custom) or REST; secret redaction; idempotent ingestion; per-organization retention |
| **Evaluation** | 8 evaluators: accuracy, hallucination, groundedness, relevance, completeness, tool usage, instruction adherence, operational |
| **Test suites and runs** | JSON/CSV import; run via the SDK (your code) or against your agent's HTTP endpoint; version comparison |
| **Debugging** | Trace explorer and Debug view with findings labelled *observed / likely / possible* |
| **Live monitoring** | Server-side sampling with daily budgets; live error rate, latency (p95), cost; agent health with reasons |
| **Alerts** | Error rate, latency, quality drop, cost per day, silence; cooldown, auto-resolve; in-app plus webhook (JSON or Slack) |
| **Teams and security** | Organizations, four roles, invitations, admin-issued password reset, audit log, login lockout, refresh-token rotation |

## Architecture at a glance

```text
 Your agent + Python SDK ──API key──┐            Browser (React + Vite + Tailwind)
                                    ▼                         │
                        ┌──────── Express API  /api/v1 ◄──────┘ (via nginx)
                        │              │
                        │              ▼
                        │          MongoDB  ◄── job queue, rollups, alerts
                        │              ▲
                        │         Node worker ──token──► Python evaluation engine
                        │        (queue, alerts)          (evaluators, claims, judge, debugger)
                        └─ optional: AI judge provider, webhooks, your agent's endpoint
```

| Part | Where | Role |
|---|---|---|
| **web** | `apps/web` | React website (Docker: nginx on port 8080; dev: Vite on 5173) |
| **api** | `apps/api` | Express REST API `/api/v1` on port 4000 |
| **worker** | `apps/api` (same image, `src/worker.js`) | Job queue: evaluations, sampled production evaluation, alert rules, webhooks |
| **engine** | `evaluation-engine` | Python service that computes scores and debugging findings (private) |
| **sdk** | `sdk/python` | `agenteval` Python SDK with LangChain/LangGraph support |
| **MongoDB** | container | All data and the queue |

Full detail: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Quick start (about 10 minutes)

Requirements: Docker (Compose v2) and Node.js 20+ (helper scripts only).

```bash
npm run init:env                 # creates .env with fresh random secrets (never commit it)
docker compose up -d --build     # MongoDB, API, worker, evaluation engine, website
npm run doctor                   # every line should be a green check
```

Open <http://localhost:8080>, create an account (the first account owns the organization), then follow the *Getting started* checklist on the Dashboard. Send your first trace:

```bash
pip install -e sdk/python
export AGENTEVAL_API_KEY=ae_live_...        # create it on the agent page in the website
export AGENTEVAL_AGENT_ID=<agent id>        # shown on the agent page
export AGENTEVAL_ENDPOINT=http://localhost:8080
python sdk/python/examples/send_test_trace.py
```

Instrumenting a real agent:

```python
from agenteval import AgentEval
client = AgentEval(api_key="ae_live_...", endpoint="http://localhost:8080")
handler = client.langchain_handler("<agent id>", agent_version="1.0.0")
chain.invoke(inputs, config={"callbacks": [handler]})   # LangChain / LangGraph
client.flush()
```

Developer mode (hot reload), every setting, backups and HTTPS: [docs/SETUP_GUIDE.md](docs/SETUP_GUIDE.md).

## Project layout

```text
agent/
├── apps/
│   ├── api/                 Express REST API + background worker (same image, two commands)
│   └── web/                 React + Vite + Tailwind website (nginx in production)
├── evaluation-engine/       Python HTTP service: evaluators, claim analysis, judge layer, debugger
├── sdk/python/              `agenteval` Python SDK (LangChain / LangGraph / custom) + examples
├── packages/trace-schema/   Shared fixtures that both the JS and Python trace validators must satisfy
├── deploy/                  caddy/ (TLS), nginx/ (own-proxy example), scripts/ (backup, restore)
├── scripts/                 init-env, doctor, verify (all tests), run-engine, loadtest-ingest, simulate_live_traffic
├── docs/                    Documentation (below)
├── docker-compose.yml       Self-hosted stack (hardened containers)
├── docker-compose.prod.yml  Adds HTTPS through Caddy
├── docker-compose.dev.yml   MongoDB only, for local development
├── .env.example             Every setting, documented
└── CHANGELOG.md             Change history
```

## Documentation

| Document | What is in it |
|---|---|
| [docs/SETUP_GUIDE.md](docs/SETUP_GUIDE.md) | Install and run locally (Docker or developer mode), first trace, **all configuration settings**, troubleshooting, backup/restore, upgrades, putting it on a server |
| [docs/API_DOCS.md](docs/API_DOCS.md) | Every REST endpoint, auth and roles, errors, limits, the trace format, the Python SDK reference |
| [docs/TEST_GUIDE.md](docs/TEST_GUIDE.md) | Automated tests, an API smoke test, a first-user acceptance walkthrough, server/security/load checks |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Components, data flows, data model, how evaluators and the debugger work, security design, decisions, limits, roadmap |

## Development

```bash
npm run init:env && npm run dev:infra       # MongoDB in Docker
npm run install:all
npm run dev:engine & npm run dev:api & npm run dev:worker & npm run dev:web
npm test                                    # runs every suite that can run on this machine
```

## Status and known limits

Milestones 1-6 are built. Automated tests pass (re-run for this documentation): API 179 unit + 13 integration, evaluation engine 90, SDK 44, plus the cross-language trace contract and the website build.

**Never exercised by the original author:** the MongoDB layer on a real database, Docker builds and Compose, the website in a browser, and the backup/restore scripts. Do your first deployment on a throwaway server and use the acceptance walkthrough in [docs/TEST_GUIDE.md](docs/TEST_GUIDE.md).

**Not built yet:** consistency evaluator, custom evaluation criteria end to end, workspaces, report export, e-mail, MFA/SSO, `ENCRYPTION_KEY` rotation tooling, GridFS offload (traces are capped at 4 MB).
