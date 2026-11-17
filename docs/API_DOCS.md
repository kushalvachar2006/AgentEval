# AgentEval API Documentation

Complete reference for the AgentEval REST API (`v1`, app version 0.6.0). Every route below was checked against `apps/api/src/routes/index.js` and the service code. An automated route sweep (`apps/api/test/integration/route-sweep.test.js`) fails if a route is added without being classified.

**Contents**
1. [Basics](#1-basics): base URL, auth, roles, errors, pagination, limits
2. [Health](#2-health)
3. [Authentication and sessions](#3-authentication-and-sessions)
4. [Agents and API keys](#4-agents-and-api-keys)
5. [Traces (ingestion and explorer)](#5-traces)
6. [Test suites](#6-test-suites)
7. [Evaluators and evaluation runs](#7-evaluators-and-evaluation-runs)
8. [Analytics](#8-analytics)
9. [Debugging](#9-debugging)
10. [Live monitoring](#10-live-monitoring)
11. [Alerts](#11-alerts)
12. [Organization](#12-organization)
13. [Trace format (schema 1.0)](#13-trace-format-schema-10)
14. [Python SDK quick reference](#14-python-sdk-quick-reference)
15. [Internal engine API](#15-internal-evaluation-engine-api)
16. [Error code index](#16-error-code-index)

---

## 1. Basics

### Base URL

| Where you call from | URL |
|---|---|
| Docker (through the website's nginx) | `http://localhost:8080/api/v1` |
| Docker or dev (API directly) | `http://localhost:4000/api/v1` |
| Dev website (Vite proxies `/api`) | `http://localhost:5173/api/v1` |
| Production | `https://<your-domain>/api/v1` |

All request and response bodies are JSON (`Content-Type: application/json`). Every response carries an `x-request-id` header (you may send your own, max 64 characters).

### Authentication

Send `Authorization: Bearer <token>`. The token is one of:

| Token | Looks like | Obtained from | Lifetime |
|---|---|---|---|
| **User access token** | JWT (`eyJ…`) | `register`, `login`, `refresh`, `change-password`, `invitations/accept` | 15 minutes (`JWT_TTL_SECONDS`). Bound to a server-side session, so logout revokes it immediately |
| **API key** | `ae_live_…` | `POST /api-keys` (admin) or the agent page in the website | Until revoked or its optional expiry (1-365 days). Also accepted as header `X-API-Key: ae_live_…` |

Users that belong to more than one organization must also send `X-Organization-Id: <24-hex id>`. It is always checked against real membership; it is never trusted. With exactly one organization it can be omitted.

### Roles and permissions

`viewer` < `member` < `admin` < `owner`.

| Role | Can do |
|---|---|
| viewer | Read agents, traces, suites, evaluations, alerts, analytics, monitoring |
| member | + create/edit agents, suites, cases; ingest traces; start/cancel evaluations; acknowledge and resolve alerts |
| admin | + delete (archive) agents; manage API keys; evaluator (judge) settings; monitoring policy; alert rules; members, invitations, password resets; audit log; organization settings; delete demo data |
| owner | + everything an admin can, and may manage other admins/owners. Admins can only manage `viewer`/`member` |

**API key scopes** (a key can hold only these):

| Scope | Allows |
|---|---|
| `traces:write` (default) | `POST /traces`, `POST /traces/batch` |
| `agents:read` | Read agents and versions (also `GET /agents/:id/monitoring` and `GET /org`, which only check this scope) |
| `agents:write` | Create/update agents, add versions |
| `evaluations:run` | `GET /evaluations/:id/work` (used by the SDK) |

A key may be bound to a single `agentId`; it can then only act on that agent. **API keys can never** read traces, analytics, monitoring data, alerts, evaluations (other than `/work`), members, audit, keys, or settings, and cannot start runs. Those routes return `403`.

In the tables below, **Access** is the minimum role (or key scope). "Users only" means API keys are refused.

### Errors

All errors use one envelope:

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "Request validation failed", "requestId": "…", "details": [ { "path": "name", "message": "is required" } ] } }
```

`details` is optional. Validation failures are `422` and list every problem at once. See the [error code index](#16-error-code-index).

| Status | Meaning |
|---|---|
| 400 | Bad query, cursor, JSON, or missing `X-Organization-Id` |
| 401 | Missing/invalid/expired token, key, or credentials |
| 403 | Authenticated but not allowed (role, scope, bound agent, wrong organization) |
| 404 | Not found (also returned for another organization's objects) |
| 409 | Conflict (duplicate name, invalid state transition) |
| 413 | Body or trace too large |
| 422 | Validation failed |
| 429 | Rate limited (`RATE_LIMITED`) or account locked (`TOO_MANY_ATTEMPTS`, with `Retry-After`) |
| 5xx | Server error. Body is generic; details are only in server logs |

### Pagination

List endpoints take `limit` and `cursor` and return `{ "items": [...], "nextCursor": "…" | null }`. Pass `nextCursor` back as `cursor` until it is `null`. Default `limit` is 20 (50 for suite cases, results, alert rules, audit; 25 for alerts), maximum 100 (200 for suite cases and results). Query values must be plain strings; `?a[$ne]=x` is rejected with `400 INVALID_QUERY`.

### Limits

| What | Limit | Setting |
|---|---|---|
| General JSON body | 1024 KB | `BODY_LIMIT_KB` |
| Trace endpoints body | 5120 KB | `INGEST_BODY_LIMIT_KB` |
| Stored trace (after redaction and truncation) | 4 MB, else `413 TRACE_TOO_LARGE` | `MAX_TRACE_BYTES` |
| Traces per batch | 1-100 | fixed |
| Spans per trace | 5000 | fixed |
| Test-suite import | 2 MB content, 1000 rows | fixed |
| Cases per suite / per run | 5000 / 500 | fixed / `MAX_CASES_PER_RUN` |
| Auth endpoints (register, login, refresh, change-password, reset, invitation accept) | 10 *failed* attempts per 15 min per IP | `AUTH_RATE_LIMIT_MAX` |
| Trace ingestion | 600 per minute per API key (or per IP) | `INGEST_RATE_LIMIT_MAX` |
| Everything else | 300 per minute per IP | `RATE_LIMIT_MAX` |

Authentication is checked before a trace body is parsed, so anonymous callers cannot make the server parse megabytes.

---

## 2. Health

No authentication.

| Method and path | Response |
|---|---|
| `GET /health` | `200 {status:"ok", service:"agenteval-api", version, time}` (liveness) |
| `GET /health/ready` | `200 {status:"ready", dependencies:{mongo:"up"}}`, or `503 {status:"degraded", …}` when MongoDB cannot be pinged within 2 s (readiness) |

---

## 3. Authentication and sessions

Routes marked **P** are public.

| Method and path | Access | Body → Response |
|---|---|---|
| `POST /auth/register` **P** | anyone | `{email, password, name, organizationName}` → `201 {token, refreshToken, expiresInSeconds, user, organizations}`. Creates the organization with you as `owner`. Password is 10-128 characters. `409 EMAIL_IN_USE`; `403 REGISTRATION_DISABLED` when `ALLOW_REGISTRATION=false` and at least one user exists |
| `POST /auth/login` **P** | anyone | `{email, password}` → same bundle as register. Wrong password and unknown e-mail give the same `401 INVALID_CREDENTIALS`. After 5 failures in 15 min the account is locked for 15 min (`429 TOO_MANY_ATTEMPTS` + `Retry-After`), also for e-mails that do not exist |
| `GET /auth/me` | user | → `{user, organizations:[{id,name,role}], currentOrganizationId}` |
| `POST /auth/refresh` **P** | refresh token | `{refreshToken}` → `{token, refreshToken, expiresInSeconds}`. The old refresh token stops working (rotation). Re-using an already-rotated token revokes **all** of that user's sessions → `401 INVALID_REFRESH` |
| `POST /auth/logout` | user | `204`. Revokes this session immediately |
| `POST /auth/logout-all` | user | `204`. Revokes every session of the user |
| `POST /auth/change-password` | user | `{currentPassword, newPassword}` → new token bundle. Ends every other session |
| `POST /auth/password-reset/complete` **P** | one-time token | `{token, newPassword}` → `204`. Token comes from an admin (`ae_rst_…`), single use, 60 min. Ends all of the user's sessions |
| `POST /auth/invitations/accept` **P** | one-time token | `{token, name, password}` → `201` token bundle. Creates the account and joins the organization with the invited role. `409 ACCOUNT_EXISTS` if the e-mail already has an account |
| `POST /org/invitations/accept` | user | `{token}` → `{organizationId, role}`. For an existing account; the invitation must be addressed to the user's e-mail (`403 INVITATION_EMAIL_MISMATCH`) |

**Refresh pattern** (what the website does): on `401 INVALID_TOKEN`, call `/auth/refresh` once, store both new tokens, retry. Parallel 401s should share one refresh call because the refresh token rotates on every use.

```bash
curl -s http://localhost:4000/api/v1/auth/register -H 'content-type: application/json' \
  -d '{"email":"me@example.com","password":"a-long-password","name":"Me","organizationName":"Me Inc"}'
```

---

## 4. Agents and API keys

An **agent** is the thing you evaluate. `integrationType` is `sdk` (your code sends traces) or `api` (AgentEval calls your HTTP endpoint).

| Method and path | Access | Notes |
|---|---|---|
| `POST /agents` | `agents:write` (member+, or key not bound to an agent) | `{name, framework, description?, version?, integrationType?, endpointUrl?, endpointToken?, config?}` → `201` agent. `framework`: `langchain`, `langgraph`, `custom`. `integrationType` default `sdk`. `version` default `1.0.0` (letters, digits, `. + _ -`, max 32). `endpointUrl` is required for `api` and forbidden for `sdk`; it passes the SSRF guard. `endpointToken` (8-500 chars) is sent as a bearer token to your endpoint and stored encrypted. Secrets inside `config` are redacted. `409 AGENT_NAME_EXISTS` |
| `GET /agents` | `agents:read` | `?limit&cursor&name&framework`. A bound key sees only its agent |
| `GET /agents/:id` | `agents:read` | |
| `PATCH /agents/:id` | `agents:write` | Only `name`, `description`, `config`, `endpointUrl`, `endpointToken`, `clearEndpointToken`. Anything else is `422 cannot be changed here`; an empty body is rejected |
| `DELETE /agents/:id` | admin+ | `204`. Archives the agent and revokes its bound keys; traces remain until retention expires them |
| `GET /agents/:id/versions` | `agents:read` | → `{items:[{id,agentId,version,notes,source,createdAt}]}` (`source`: `manual` or `trace`) |
| `POST /agents/:id/versions` | `agents:write` | `{version, notes?, config?, setCurrent?}` → `201`. `setCurrent` defaults to true. `409 VERSION_EXISTS` |
| `GET /agents/:id/traces` | `traces:read` (users) | See [Traces](#5-traces) |
| `GET /agents/:id/metrics` | `traces:read` (users) | See [Analytics](#8-analytics) |
| `GET /agents/:id/monitoring` | `agents:read` | See [Live monitoring](#10-live-monitoring) |
| `PUT /agents/:id/monitoring` | admin+ | See [Live monitoring](#10-live-monitoring) |

Agent object: `id, name, description, framework, integrationType, endpointUrl, hasEndpointToken, currentVersion, status, config, lastTraceAt, createdAt, updatedAt`. `status` is `pending` until the first trace arrives. Tokens are never returned, only `hasEndpointToken`.

### API keys (admin+, users only)

| Method and path | Notes |
|---|---|
| `GET /api-keys` | → `{items:[{id,name,keyPrefix,scopes,agentId,createdAt,expiresAt,lastUsedAt,revokedAt}]}` |
| `POST /api-keys` | `{name (max 64), scopes?, agentId?, expiresInDays?}` → `201` with the key object **plus `key`, the plaintext key, shown once**. `scopes` default `["traces:write"]`; allowed values listed in [Roles](#roles-and-permissions). `expiresInDays` is 1-365 |
| `DELETE /api-keys/:id` | `204`. Takes effect immediately |

```bash
curl -s http://localhost:4000/api/v1/agents -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"name":"laptop-agent","framework":"langchain"}'
curl -s http://localhost:4000/api/v1/api-keys -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"name":"ci","scopes":["traces:write","evaluations:run"],"agentId":"<agent id>"}'
```

---

## 5. Traces

A trace is one complete agent execution. Format: [section 13](#13-trace-format-schema-10).

| Method and path | Access | Notes |
|---|---|---|
| `POST /traces` | `traces:write` (API key, or member+) | One trace. `202 {traceId, status:"accepted"}` or `200 {traceId, status:"duplicate"}`. Idempotent on `(organization, traceId)`. If the trace carries `metadata.evaluation = {runId, testCaseId}` the response also has `linked: true/false` |
| `POST /traces/batch` | `traces:write` | `{traces:[1-100 traces]}` → `200 {accepted, duplicates, rejected, results:[{index, traceId, status:"accepted"\|"duplicate"\|"rejected", error?}]}`. A rejected trace never blocks the others. Infrastructure failures fail the whole request so the client retries |
| `GET /traces` | `traces:read` (users only) | Explorer across all agents. Newest first, summaries without spans |
| `GET /traces/:id` | `traces:read` | Full trace with spans. `:id` is the 32-hex `traceId`. Sensitive internals (`organizationId`, `expiresAt`) are removed |
| `GET /agents/:id/traces` | `traces:read` | `?status&from&to&limit&cursor`, newest first |
| `GET /traces/:id/debug` | `traces:read` (users only) | See [Debugging](#9-debugging) |

**Ingestion rules**

* `agentId` in the trace must be the **24-hex agent id** of an agent in your organization (`404 AGENT_NOT_FOUND` otherwise). A key bound to another agent gets `403`.
* Validation failure: `422 INVALID_TRACE` with up to 20 `{path, message}` entries.
* The server redacts secrets (by key name and by value pattern), truncates strings over 32,768 characters, rewrites unsafe keys (`$x`, `a.b`, `__proto__`), and then enforces the 4 MB limit.
* Traces expire automatically (organization retention, default 90 days).
* A trace with `metadata.demo = true` is flagged as demo data.
* Ingestion also updates the agent's `lastTraceAt`, registers the `agentVersion` if new, writes an hourly rollup, and may queue a sampled production evaluation. These side effects never make ingestion fail.

**Explorer filters for `GET /traces`**: `agentId`, `status` (`success|error|cancelled|timeout`), `environment` (`production|test|evaluation`), `version`, `from`, `to` (ISO dates), `q` (literal case-insensitive substring over question/answer previews, max 100 characters, defaults to the last 30 days; never a regex), `minDurationMs` (non-negative integer), `demo` (`true|false`), `limit`, `cursor`.

```bash
curl -s http://localhost:4000/api/v1/traces/batch -H "authorization: Bearer ae_live_…" -H 'content-type: application/json' \
  -d '{"traces":[ { …trace… } ]}'
```

---

## 6. Test suites

A suite is a named list of test cases. Cases are immutable once created (deleting is a soft delete, so past runs keep their copy).

| Method and path | Access | Notes |
|---|---|---|
| `POST /test-suites` | member+ | `{name (max 100), description?, tags? (≤20)}` → `201`. `409 SUITE_NAME_EXISTS` |
| `GET /test-suites` | viewer+ | `?limit&cursor` → suites with `caseCount` |
| `GET /test-suites/:id` | viewer+ | Suite plus `cases:{items, nextCursor}` (`?limit` default 50, max 200) |
| `POST /test-suites/:id/cases` | member+ | One case → `201` |
| `POST /test-suites/:id/import` | member+ | `{format:"json"\|"csv", content, allowPartial?}` → `201 {imported, rejected, errors[], ignoredColumns[], secretsRedacted}`. All-or-nothing unless `allowPartial: true`. `422 IMPORT_ERRORS` lists up to 20 problems with row numbers |
| `DELETE /test-suites/:id/cases/:caseId` | member+ | `204` |

### Test case fields

| Field | Type | Used by |
|---|---|---|
| `input` (required) | string (≤20,000 chars) or small object | all |
| `referenceAnswer` | string | accuracy, hallucination |
| `referenceEvidence` | list (≤50) of strings or `{source?, text}` | hallucination, groundedness |
| `expectedBehavior` | string (≤2000) | documentation for humans |
| `evaluationCriteria` | list (≤20) of strings | (stored; custom criteria are not evaluated end to end yet) |
| `requiredElements` | list (≤50) of strings or `{text, alternatives[]}` | completeness |
| `expectedToolCalls` | list (≤20) of `{name, args?, required?, order?}` | tool_usage |
| `constraints` | `{maxChars, minChars, maxWords, mustInclude[], mustNotInclude[], format}`; `format` is `json`, `single_line` or `bullet_list` | instruction_adherence |
| `tags`, `metadata` | list of strings, object (<4 KB) | filtering |

Unknown fields are rejected. Regular expressions in constraints are rejected on purpose (they can freeze the evaluator). Secrets inside cases are redacted (`secretsRedacted` counts them).

### Import formats

**JSON:** an array of cases, or `{"cases":[...]}`.

**CSV:** RFC 4180 subset (quotes, `""`, CRLF, BOM, newlines inside quotes). Needs an `input` column (aliases `prompt`, `question`). Optional columns (aliases in brackets): `referenceAnswer` (`expected`, `answer`), `referenceEvidence` (`evidence`, `context`), `expectedBehavior`, `evaluationCriteria` (`criteria`), `requiredElements`, `expectedToolCalls`, `constraints`, `tags`, `metadata`. List columns use `||` as separator (tags may use `|` or `,`); `expectedToolCalls`, `constraints` and `metadata` hold JSON. Other columns are ignored and reported in `ignoredColumns`.

```json
{ "format": "json", "content": "[{\"input\":\"Find the cheapest laptop below ₹50,000.\",\"referenceAnswer\":\"Acme Book 14 at ₹47,999\",\"referenceEvidence\":[\"Acme Book 14 costs ₹47,999\"],\"expectedToolCalls\":[{\"name\":\"search_products\",\"required\":true}]}]" }
```

---

## 7. Evaluators and evaluation runs

| Method and path | Access | Notes |
|---|---|---|
| `GET /evaluators` | viewer+ (users) | Catalogue: `{evaluators:[{metric, version, description, requires[], usesJudge}]}`. Metrics: `accuracy`, `hallucination`, `groundedness`, `relevance`, `completeness`, `tool_usage`, `instruction_adherence`, `operational`. How each is scored: [ARCHITECTURE.md §8](ARCHITECTURE.md#8-evaluators-how-scores-are-computed) |
| `GET /evaluator-config` | viewer+ | → `{judge:{enabled, provider, model, baseUrl, hasApiKey, temperature, maxTokens}}`. The key is never returned |
| `PUT /evaluator-config` | admin+ | `{judge:{enabled, provider, model, baseUrl?, apiKey?, clearApiKey?, temperature? (0-2), maxTokens? (1-8000)}}`. `provider`: `openai_compatible` or `anthropic` (the latter requires an `apiKey`). `apiKey` (8-500 chars) is write-only and stored encrypted. `baseUrl` passes the SSRF guard |
| `POST /evaluations` | member+ (users only) | Start a run → `202` run |
| `GET /evaluations` | viewer+ | `?agentId&limit&cursor` |
| `GET /evaluations/:id` | viewer+ | Run, progress, counters, and `summary` once complete |
| `GET /evaluations/:id/results` | viewer+ | `?status=passed\|failed\|inconclusive\|error&limit&cursor` |
| `GET /evaluations/:id/work` | key `evaluations:run`, or member+ | SDK mode: cases still to run → `{runId, agentId, deadline, cases:[{testCaseId, input}]}`. `409 RUN_NOT_SDK` / `RUN_NOT_ACCEPTING` |
| `POST /evaluations/:id/cancel` | member+ (users) | `409 RUN_FINISHED` if already finished |

### Starting a run

```json
{
  "agentId": "<24-hex>", "suiteId": "<24-hex>", "mode": "sdk",
  "name": "optional", "useJudge": false,
  "limits": { "maxJudgeCalls": 200 },
  "metrics": [ { "metric": "accuracy", "config": { "threshold": 0.9 } }, { "metric": "relevance" } ]
}
```

* `mode`: `sdk` (your code runs the agent; status starts at `awaiting_traces`) or `endpoint` (the worker calls your agent; status starts at `queued`; the agent must be `integrationType:"api"` with an `endpointUrl`, else `422 AGENT_NOT_CALLABLE`).
* `metrics` (1-12) is optional. When omitted, defaults are chosen from what the suite contains: `relevance` always; `accuracy` if any case has a `referenceAnswer`; `hallucination` if any case has a reference answer or evidence; `groundedness` with evidence; `completeness` with `requiredElements`; `tool_usage` with `expectedToolCalls`; `instruction_adherence` with `constraints`.
* Evaluator **versions are pinned** at creation so the run stays reproducible. Per-metric `config` (under 4 KB) is described in [ARCHITECTURE.md §8](ARCHITECTURE.md#8-evaluators-how-scores-are-computed).
* `useJudge` defaults to true if a judge is configured; `true` without a configured judge is `422 JUDGE_NOT_CONFIGURED`. `limits.maxJudgeCalls` is 0-5000 (default `DEFAULT_MAX_JUDGE_CALLS`, 200).
* Errors: `422 SUITE_EMPTY`, `SUITE_TOO_LARGE` (over `MAX_CASES_PER_RUN`).

### Run status

`queued` → `running` → `completed` | `cancelled` | `failed`; SDK runs start at `awaiting_traces`. SDK runs wait `SDK_RUN_WAIT_MINUTES` (30) for traces; cases without a trace then become `error` results so the run can finish.

### Case status and run summary

* A case is `failed` if any metric is `fail`; else `passed` if any metric is `pass`; else `inconclusive`. Infrastructure problems (agent unreachable, engine down after retries) make it `error`.
* `summary`: `{cases:{total,passed,failed,inconclusive,error}, passRate, metrics:{<metric>:{pass,fail,inconclusive,avgScore,avgConfidence}}, latencyMs:{avg,p95}, tokens, costUsd, judgeCalls, evaluators:[{metric,version}]}`.
* Each result in `/results` holds `metrics[]` with `metric, score, status (pass|fail|inconclusive), confidence, threshold, explanation, findings[], evaluatorVersion, meta` plus `traceId`, `latencyMs`, `tokens`, `costUsd`, `judgeCalls`, previews.

### SDK mode link

A trace with `metadata.evaluation = {runId, testCaseId}` ingested while the run is accepting traces (same agent, case belongs to the run, before the deadline) is attached to the run and queued for evaluation. `client.run_evaluation(run_id, agent_fn)` does this for you.

### Endpoint mode contract (your agent)

AgentEval sends `POST <endpointUrl>`:

```json
{ "input": "<test case input>", "sessionId": "eval-<runId>-<caseId>", "traceId": "<32 hex>", "metadata": { "evaluation": { "runId": "…", "testCaseId": "…" } } }
```

Headers: `x-agenteval-run: <runId>` and `Authorization: Bearer <endpointToken>` if one is set. Your agent must answer **2xx** with JSON `{ "output": <answer>, "trace": <optional normalized trace> }` (`answer` or `response` are accepted instead of `output`). If `trace` is valid it is used (its agent id and environment are overwritten); otherwise a minimal trace is synthesized (then tool_usage and grounding cannot see tool output). `408`, `429`, `5xx` and timeouts are retried (3 attempts); other `4xx` are final. Redirects are not followed; responses over 2 MB are rejected; timeout `AGENT_CALL_TIMEOUT_MS` (60 s). A reference agent is `sdk/python/examples/demo_agent_server.py`.

---

## 8. Analytics

Users only; requires `traces:read` (viewer+).

| Method and path | Notes |
|---|---|
| `GET /analytics/overview` | Organization-wide dashboard data |
| `GET /agents/:id/metrics` | Same payload for one agent plus `versions[]` (always lists every version) |

**Filters:** `from`, `to` (ISO; default last 30 days; range max 366 days), `agentId`, `version`, `environment`, `status`, `metric`, `demo=true|false`. Execution-only filters (`status`, `environment`, `demo`) do not apply to evaluation results.

**Response:**

```text
filters, totals{agents, executions, evaluationRuns, failedExecutions},
execution{avgLatencyMs, errorRate, taskCompletionRate, totalTokens, estimatedCostUsd, costCoverage},
quality{metrics{<metric>:{avgScore,n,pass,fail,inconclusive}}, accuracy, groundedness,
        unsupportedClaimRate, contradictedClaimRate, evaluatedCases, passRate, failedTestCases},
trends{daily[], runs[] (last 20)}, recentFailures[] (10)
```

Averages over no data are `null`, never 0. *taskCompletionRate* = executions with status `success` / all. *unsupportedClaimRate* = (contradicted + unsupported) / checked claims. *costCoverage* = share of executions that reported `usage.estimatedCostUsd` (cost is never guessed). Per-version entries: `{version, executions, errorRate, avgLatencyMs, avgTokens, quality:{<metric>:avgScore}}`.

---

## 9. Debugging

`GET /traces/:id/debug` (users only, `traces:read`) asks the engine to analyse one stored trace together with any evaluation results about it.

```text
{ engineAvailable, verdict: failed|suspicious|clean|unknown, headline,
  findings[], failedMetrics[], suspectedPath[], caveats[], evaluation[] }
```

Each finding: `id, type, severity (error|warning|info), certainty (observed|likely|possible), title, explanation, spanId, path[], claim, evidence[], affectedMetrics[]` (real evaluation results) or `potentialMetrics[]` (could be affected once evaluated).

Finding types: `span_error`, `trace_error`, `swallowed_error`, `contradiction`, `unsupported_claim`, `empty_tool_output`, `repeated_call`, `slow_step`, `evaluation_finding`, `evaluation_check`, `metric_failed`. If the engine is down the call **still succeeds** with `engineAvailable:false`, `verdict:"unknown"` and an explanatory caveat. Details: [ARCHITECTURE.md §9](ARCHITECTURE.md#9-the-debugging-engine).

---

## 10. Live monitoring

Production traces (`environment: "production"`) only. Reads need `traces:read`; the policy is readable with `agents:read` and writable by admins. `windowMinutes` is 5-1440 (default 15). `demo=true` includes demo data (default: excluded).

| Method and path | Notes |
|---|---|
| `GET /monitoring/overview` | Up to 50 agents, sorted failing → degraded → healthy → no_data. Per agent: `current` window stats, `health {status: healthy\|degraded\|failing\|no_data, reasons[], openAlerts}`, `lastTraceAt`, `monitoring {enabled, sampleRate}`. `truncated` if more agents exist |
| `GET /monitoring/agents/:id/live` | `current` and `previous` windows (`count, errors, errorRate, avgLatencyMs, p95LatencyMs, p95Exact, totalTokens, costUsd, costCoverage`), `series[]` (about 30 bins), `health`, `recentTraces[]`, `failedExecutions[]` (last 24 h), `quality{windowHours, evaluated, passed, failed, inconclusive, passRate, metrics, recent[]}`, `openAlerts[]`, `policy`, `usage` |
| `GET /monitoring/agents/:id/rollups` | Hourly rollups. `from`, `to` (max 90 days; default last 7 days), `environment` (default `production`), `version`, `demo`. `p95LatencyMs` is a **bucket upper bound** (see `p95Note`) |
| `GET /agents/:id/monitoring` | → `{policy, usage}` |
| `PUT /agents/:id/monitoring` | admin+. **Replaces the whole policy**; missing fields take defaults |

**Policy** (default: everything off):

| Field | Meaning |
|---|---|
| `enabled` | Master switch (default `false`) |
| `sampleRate` | 0-1; `0.1` evaluates about 10% of production traces (deterministic by trace id hash) |
| `alwaysEvaluateErrors` | Also evaluate every non-success trace (default `true`) |
| `dailyTraceBudget` | Max sampled evaluations per UTC day; `null` = unlimited; `0` = none |
| `dailyJudgeBudget` | Max AI-judge calls per UTC day. **Required (≥1) when `useJudge` is true** |
| `useJudge` | Use the configured AI judge (default `false`) |
| `evaluators` | Distinct list from `hallucination, groundedness, relevance, tool_usage, instruction_adherence, operational` (default: all but `instruction_adherence`). Only reference-free evaluators are allowed because production traces have no test case |
| `constraints` | Same shape as case constraints; required when `instruction_adherence` is selected |

`usage`: `{day, evaluationsQueued, skippedBudget, judgeCalls, dailyTraceBudget, dailyJudgeBudget}`.

**Health rules** (fixed constants): needs 10 traces in the window for a verdict, else `no_data`. Error rate ≥ 5% → degraded, ≥ 25% → failing; average latency ≥ 2× the previous window → degraded; ≥ 30% of the last 5+ evaluated traces failing → degraded; open critical alert → failing; open warning alert → degraded. Every verdict lists its `reasons`.

---

## 11. Alerts

Reads need `alerts:read` (viewer+); acknowledge/resolve need `alerts:ack` (member+); rules need `alerts:manage` (admin+). Users only.

### Rules

| Method and path | Access | Notes |
|---|---|---|
| `GET /alert-rules` | viewer+ | `?agentId&limit&cursor` → `{items, nextCursor, supportedTypes}` |
| `POST /alert-rules` | admin+ | `201`. Limit `MAX_ALERT_RULES` (100) per organization, else `409 ALERT_RULE_LIMIT` |
| `GET /alert-rules/:id` | viewer+ | |
| `PATCH /alert-rules/:id` | admin+ | Partial update; `type` cannot change; `params` are merged; `notify:null` removes the webhook |
| `DELETE /alert-rules/:id` | admin+ | `204`. Resolves its open alert |
| `POST /alert-rules/:id/test` | viewer+ | Evaluates now against live data, **records nothing** → `{state: firing\|ok\|insufficient_data, observed, threshold, explanation}` |

Rule body: `{name, type, agentId|null, severity: warning|critical, params, enabled, cooldownMinutes (0-1440, default 30), resolveAfterOk (1-10, default 2), evalEveryMinutes (1-60, default 1), notify:{webhook:{url, secret?, format: json|slack}}}`. `agentId:null` means all agents (not allowed for `silence`).

| `type` | `params` |
|---|---|
| `error_rate` | `{windowMinutes (1-1440, 15), thresholdPct (>0-100), minSamples (20)}` |
| `latency` | `{stat: p95\|avg (p95), windowMinutes (15), thresholdMs, minSamples (20)}` |
| `quality_drop` | `{metric (a production evaluator), dropThreshold (0-1), windowMinutes (5-1440, 60), baseline: previous_window\|last_run, minSamples (10)}`. `last_run` needs an `agentId` |
| `cost_per_day` | `{thresholdUsd, minSamples (5)}` over a rolling 24 h; only traces that report a cost count |
| `silence` | `{silenceMinutes (1-10080)}`; agent required; never judged before the agent's first trace |

A rule with too few samples reports `insufficient_data` and never opens or closes an alert. Webhook URL and secret are **never returned**, only `notify.webhook:{host, format, hasSecret}`.

**Lifecycle:** one open alert per rule (de-duplicated across workers). Opening needs a firing evaluation outside the cooldown that follows a resolution. Auto-resolve happens after `resolveAfterOk` consecutive OK evaluations. Manual resolve also starts the cooldown.

### Alerts

| Method and path | Notes |
|---|---|
| `GET /alerts` | `?status=open\|acknowledged\|resolved\|active&agentId&ruleId&limit (≤100)&cursor`; `active` = open + acknowledged |
| `GET /alerts/summary` | `{active, critical, warning}` (the navigation badge) |
| `GET /alerts/:id` | Alert with `links.monitoring` and `links.traces` (website hash links) |
| `POST /alerts/:id/acknowledge` | open → acknowledged. `409 ALERT_STATE` otherwise |
| `POST /alerts/:id/resolve` | → resolved. `409 ALERT_STATE` if already resolved |

### Webhooks

On open and on resolve the worker sends `POST` to the rule's URL (10 s timeout) with headers `x-agenteval-event` (`opened`|`resolved`), `x-agenteval-timestamp` (unix seconds), and, when a secret is set, `x-agenteval-signature: sha256=<hex>` = HMAC-SHA256 of `"<timestamp>.<raw body>"` with your secret. JSON payload: `event, alertId, status, severity, rule{id,name,type}, agentId, explanation, observed, threshold, openedAt, resolvedAt?, link?` (`link` needs `PUBLIC_WEB_URL`). `format:"slack"` sends `{text}` instead. `408/429/5xx`/timeouts are retried (4 attempts in total); an SSRF refusal is final. Delivery results are stored on the alert. Payloads never contain trace content.

---

## 12. Organization

Users only.

| Method and path | Access | Notes |
|---|---|---|
| `GET /org` | any member | `{id, name, role, settings:{traceRetentionDays}, memberCount}` |
| `PATCH /org` | admin+ | `{name?, settings:{traceRetentionDays: 1-3650}?}`. Retention only applies to traces ingested afterwards |
| `GET /org/members` | admin+ | `{items:[{userId,email,name,role,isYou}]}` |
| `PATCH /org/members/:userId` | admin+ | `{role}`. Admins may only handle viewer/member; owners handle everyone; no self-edits (`409 CANNOT_EDIT_SELF`) |
| `DELETE /org/members/:userId` | admin+ | `204`. The last owner is protected (`409 LAST_OWNER`) |
| `POST /org/members/:userId/password-reset` | admin+ | `201 {token, resetPath, expiresAt, note}`. One-time link `#/reset?token=ae_rst_…`, shown once, valid 60 min |
| `GET /org/invitations` | admin+ | Pending invitations (never tokens) |
| `POST /org/invitations` | admin+ | `{email, role? (default member)}` → `201 {id, email, role, expiresAt, token, acceptPath, note}`. One-time link `#/invite?token=ae_inv_…`, valid 7 days, shown once. No e-mail is sent; you hand the link over. `409 ALREADY_MEMBER` / `INVITATION_EXISTS` |
| `DELETE /org/invitations/:id` | admin+ | `204` |
| `GET /org/audit` | admin+ | `?action&limit (≤100)&cursor`. Entries: `{id, at, action, actorId, actorEmail, target, ip, meta}`. Never contains secrets. Retained 365 days |
| `POST /org/demo-data/delete` | admin+ | `{confirm:"DELETE_DEMO_DATA"}` → `{deletedTraces, deletedRollups}` |

Audit `action` values include `user.register`, `user.login`, `user.login_failed`, `user.logout`, `user.logout_all`, `user.password_changed`, `user.password_reset`, `session.reuse_detected`, `agent.create|update|archive|version|endpoint-token`, `apikey.create|revoke`, `case.create|import|delete`, `suite.create`, `evaluation.create|cancel`, `evaluator-config.update`, `monitoring-policy.update`, `alert-rule.create|update|delete`, `alert.acknowledge|resolve`, `org.update`, `member.role_changed|removed`, `invitation.created|accepted|revoked`, `password_reset.issued`, `demo_data.deleted`.

---

## 13. Trace format (schema 1.0)

One trace = one complete agent execution. The server accepts any `1.x`. The JavaScript validator (`apps/api/src/modules/traces/traceSchema.js`) and the Python one (`sdk/python/src/agenteval/trace.py`) are tested against the same fixtures in `packages/trace-schema/fixtures/`.

```jsonc
{
  "schemaVersion": "1.0",
  "traceId": "<32 lowercase hex, not all zero>",
  "agentId": "<your agent's 24-hex id>",
  "agentVersion": "1.0.0",            // optional, max 128
  "sessionId": "conversation-42",     // optional
  "environment": "production",        // production | test | evaluation (default production)
  "framework": { "name": "langchain", "version": "0.3.0" },   // name required
  "status": "success",                // success | error | cancelled | timeout
  "input": "…any JSON…",              // required (may be null)
  "output": "…any JSON…",
  "startedAt": "2026-11-17T10:00:00.000Z",   // ISO-8601 WITH timezone
  "endedAt":   "2026-11-17T10:00:03.200Z",   // not earlier than startedAt
  "durationMs": 3200,                 // optional; computed if omitted
  "usage": { "inputTokens": 0, "outputTokens": 0, "totalTokens": 0, "estimatedCostUsd": 0.0 },  // optional; summed from llm spans if omitted
  "error": { "type": "TimeoutError", "message": "…" },    // REQUIRED when status = "error"
  "metadata": {},                     // free-form; metadata.demo=true marks demo data; metadata.evaluation links to a run
  "spans": [
    {
      "spanId": "<16 lowercase hex, not all zero>",
      "parentSpanId": null,           // null for roots, otherwise an existing spanId
      "type": "tool",                 // agent | chain | llm | tool | retriever | other
      "name": "search_products",
      "status": "success",            // success | error | cancelled
      "startedAt": "…", "endedAt": "…", "durationMs": 120,
      "input": {}, "output": {},
      "error": { "message": "…" },    // required when status = "error"
      "llm":  { "provider": "openai", "model": "REQUIRED for llm spans", "params": {}, "usage": { } },
      "tool": { "name": "REQUIRED for tool spans", "input": {}, "output": {} },
      "retriever": { "query": "…", "documents": [] }
    }
  ]
}
```

**Rules enforced identically in JS and Python:** ID formats (not all zero), ISO timestamps with timezone, `endedAt ≥ startedAt`, non-negative numbers, unique `spanId`s, every parent exists, no parent cycles, type-specific blocks present, at most 5000 spans. There is deliberately no field for hidden reasoning.

**Record tool and retrieval outputs.** Hallucination and groundedness checks compare the final answer with what tools returned *inside the trace*; without it they have no evidence and answer `inconclusive`.

---

## 14. Python SDK quick reference

Package `agenteval` 0.3.0 (`sdk/python`, Python 3.10+, standard library only; LangChain/LangGraph are optional extras). Install: `pip install -e sdk/python` (add `"[langchain]"` or `"[langgraph]"` for those integrations).

```python
from agenteval import AgentEval
client = AgentEval(api_key="ae_live_...", endpoint="http://localhost:8080")
```

`endpoint` must be `https://` except for `localhost`, `127.0.0.1` and `::1` (the key would otherwise travel unencrypted). Constructor options: `timeout=10.0`, `sampling_rate=1.0`, `batch_size=50`, `flush_interval=5.0`, `max_retries=3`, `max_queue_size=10000`, `always_sample_errors=True`, `validate=True`, `redact=True`, `flush_on_exit=True`.

| Call | Purpose |
|---|---|
| `client.langchain_handler(agent_id, agent_version=…, environment=…)` | Callback handler: `chain.invoke(x, config={"callbacks":[handler]})` |
| `client.langgraph_config(agent_id, thread_id=…)` | Run config for `graph.invoke(state, config=…)` |
| `client.instrument(runnable, agent_id)` | Returns the runnable with the handler attached |
| `client.capture(trace_dict)` | Send a trace you built yourself (sampling, redaction, batching, retries apply) |
| `TraceBuilder(agent_id, "custom", …)` (`agenteval.builder`) | `begin_span`, `end_span`, `finish(status, output, error)` build a valid trace |
| `client.run_evaluation(run_id, agent_fn)` | SDK-mode runs: calls `agent_fn(input, config)` for every pending case and sends the traces |
| `client.register_agent(...)`, `client.get_or_create_agent(name, framework)` | Needs a key with `agents:read` + `agents:write` |
| `client.flush()`, `client.close()` | Always flush in short-lived scripts; `with AgentEval(...) as client:` does it for you |
| `client.stats` | Property (not a method): `{queued, accepted, duplicates, rejected, failed, dropped_*}` |

The client batches in a background thread, retries with exponential backoff (honouring `Retry-After`), splits batches on `413`, never raises into your agent, redacts secrets before anything leaves the process, and drops traces over 3 MB. Evaluation traces are never sampled out. Runnable examples live in `sdk/python/examples/` (`send_test_trace.py`, `langchain_demo.py`, `langgraph_demo.py`, `evaluation_demo.py`, `generate_demo_data.py`, `demo_agent_server.py`).

Production tips: use `environment="production"` so traces show up in Live monitoring; set an `agent_version` on every deployment (version comparison depends on it); keep `sampling_rate=1.0` unless volume forces otherwise (server-side sampling decides what gets *evaluated*, the SDK setting decides what gets *sent*).

---

## 15. Internal evaluation engine API

Not public. Reachable only from the worker over the private network; every call except `/healthz` needs header `X-Engine-Token: <ENGINE_TOKEN>`. Body limit 5 MB.

| Route | Purpose |
|---|---|
| `POST /v1/evaluate` | `{trace, testCase, evaluators:[{metric, version?, config?}] (1-20), judge?, limits?:{maxJudgeCalls}}` → `{results:[…], judgeCalls, engineVersion}`. One failing evaluator becomes an `inconclusive` result and never breaks the others |
| `POST /v1/debug` | `{trace, results?}` → debugging findings |
| `GET /v1/evaluators` | Catalogue |
| `GET /healthz` | Liveness (no token) |

Judge credentials arrive per request, are used for that request only, and are never logged or stored.

---

## 16. Error code index

| Code | Status | Meaning |
|---|---|---|
| `UNAUTHENTICATED` | 401 | No credentials sent |
| `INVALID_TOKEN` | 401 | Access token invalid, expired or session revoked → refresh |
| `INVALID_API_KEY` | 401 | Key invalid, revoked or expired |
| `INVALID_CREDENTIALS` | 401 | Wrong e-mail/password (or wrong current password) |
| `INVALID_REFRESH` | 401 | Refresh token invalid, used, revoked or expired → sign in again |
| `TOO_MANY_ATTEMPTS` | 429 | Account locked; see `Retry-After` |
| `RATE_LIMITED` | 429 | Per-IP or per-key limit |
| `FORBIDDEN` | 403 | Role/scope/bound-agent does not allow this |
| `FORBIDDEN_ORG` | 403 | Not a member of the organization in `X-Organization-Id` |
| `NO_ORGANIZATION` | 403 | User belongs to no organization |
| `ORG_REQUIRED` | 400 | Several organizations: send `X-Organization-Id` |
| `REGISTRATION_DISABLED` | 403 | Public sign-up closed |
| `VALIDATION_ERROR` | 422 | See `details[]` |
| `INVALID_QUERY`, `INVALID_CURSOR`, `INVALID_JSON` | 400 | Bad query parameter, cursor or JSON |
| `PAYLOAD_TOO_LARGE` | 413 | Request body over the limit |
| `TRACE_TOO_LARGE` | 413 | Stored trace would exceed `MAX_TRACE_BYTES` |
| `INVALID_TRACE` | 422 | Trace failed schema validation |
| `NOT_FOUND` | 404 | Unknown route or API key |
| `AGENT_NOT_FOUND`, `TRACE_NOT_FOUND`, `SUITE_NOT_FOUND`, `CASE_NOT_FOUND`, `RUN_NOT_FOUND`, `ALERT_RULE_NOT_FOUND`, `ALERT_NOT_FOUND`, `MEMBER_NOT_FOUND`, `INVITATION_NOT_FOUND`, `ORG_NOT_FOUND` | 404 | Also returned for other organizations' objects |
| `EMAIL_IN_USE`, `AGENT_NAME_EXISTS`, `VERSION_EXISTS`, `SUITE_NAME_EXISTS`, `ACCOUNT_EXISTS` | 409 | Duplicate |
| `ALREADY_MEMBER`, `INVITATION_EXISTS`, `TOO_MANY_INVITATIONS`, `CANNOT_EDIT_SELF`, `LAST_OWNER` | 409 | Organization rules |
| `RUN_FINISHED`, `RUN_NOT_SDK`, `RUN_NOT_ACCEPTING`, `ALERT_STATE`, `ALERT_RULE_LIMIT` | 409 | State conflicts |
| `SUITE_FULL`, `SUITE_EMPTY`, `SUITE_TOO_LARGE`, `INVALID_IMPORT`, `IMPORT_ERRORS` | 422 | Suite and import problems |
| `AGENT_NOT_CALLABLE`, `JUDGE_NOT_CONFIGURED` | 422 | Run cannot start as requested |
| `UNSAFE_ENDPOINT`, `INVALID_URL` | 422 | URL failed the SSRF guard or is malformed |
| `INVALID_TOKEN_LINK` | 400 | Invitation/reset link invalid, used or expired |
| `INVITATION_EMAIL_MISMATCH` | 403 | Invitation addressed to a different e-mail |
| `INTERNAL_ERROR` | 500 | Unexpected; quote the `requestId` |
