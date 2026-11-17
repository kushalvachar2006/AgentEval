# AgentEval Test Guide

How to test AgentEval from beginning to end. Four parts, in the order you should do them:

| Part | What | Time | Needs running stack? |
|---|---|---|---|
| **A** | Automated tests (one command) | 2-3 min | No |
| **B** | API smoke test with `curl` | 5 min | Yes |
| **C** | First-user acceptance walkthrough in the website (every feature) | 2-3 hours total, split in sections | Yes |
| **D** | Server, security and load checks | 45 min | A server |

> **What is verified, honestly.** Part A was run while writing this guide, on Node 22.23 and Python 3.12, and everything passed: **API 179 unit + 13 integration, evaluation engine 90, Python SDK 44**, plus the cross-language contract check and a production build of the website. The demo-data numbers quoted in Part C (112 traces, 8 failed, 92.9%, 3.36 s, 9 and 6 search hits, 12.5% / 1.8% error rates) were recomputed from the generator and match. **Parts B-D were not executed** because that needs Docker and a real MongoDB; the original author's notes say they were not available to them either. The automated tests use an in-memory twin of the database layer, so **the real MongoDB code (`apps/api/src/repos/mongo.js`) is only exercised by Parts B and C.** Treat those as unverified until you run them. When a step differs from what you see, note the step number and the exact text.

**Contents**
- [Before you start](#before-you-start)
- [Part A: Automated tests](#part-a-automated-tests)
- [Part B: API smoke test](#part-b-api-smoke-test)
- [Part C: First-user acceptance walkthrough](#part-c-first-user-acceptance-walkthrough)
- [Part D: Server, security and load checks](#part-d-server-security-and-load-checks)
- [Test data and helper scripts](#test-data-and-helper-scripts)
- [Not built yet (do not report as bugs)](#not-built-yet-do-not-report-as-bugs)
- [Reporting a failure](#reporting-a-failure)

---

## Before you start

1. Set up the project: [SETUP_GUIDE.md](SETUP_GUIDE.md) sections 2-3 (prerequisites, `npm run init:env`).
2. Install packages once: `npm run install:all` (needed for the API integration tests and the website build).
3. Parts B-C additionally need the stack running (SETUP_GUIDE section 5). Website: `http://localhost:8080` (Docker) or `http://localhost:5173` (dev mode).

Terminal variables used below (Windows PowerShell: `$env:NAME="value"` instead of `export NAME=value`): `AGENTEVAL_API_KEY`, `AGENTEVAL_AGENT_ID`, `AGENTEVAL_RUN_ID`, `AGENTEVAL_ENDPOINT`.

---

## Part A: Automated tests

```bash
npm test          # = node scripts/verify.mjs : runs everything that can run on this machine
```

`npm test` prints one line per suite: PASS, FAIL (with the last 15 lines of output) or SKIPPED (with the reason, for example Python missing or `npm run install:all` not done). Exit code 1 means at least one FAIL. It works on Windows, macOS and Linux. Expected output when everything is installed:

```text
✅ Python SDK tests: PASS
✅ Evaluation-engine tests: PASS
✅ SDK trace accepted by server validator: PASS
✅ API unit tests (config, security, services, trace contract): PASS
✅ API integration tests (HTTP): PASS
✅ Web production build: PASS
```

### The suites

| Suite | Run on its own | Count | Covers |
|---|---|---|---|
| **API unit** | `npm --prefix apps/api test` | 179 | Config validation, auth and sessions, RBAC, tenant isolation per service, SSRF matrix, secret-leak sweep, importer/validator fuzzing, analytics, monitoring, alert rules and lifecycle, accounts, trace schema, evaluation runs. Uses in-memory repositories: **no database needed**. One test (`m3-engine-e2e`) starts the real Python engine and is skipped if Python is missing |
| **API integration** | `npm --prefix apps/api run test:integration` | 13 | Real HTTP against the Express app: auth flow, API flow, evaluations flow, analytics, monitoring, health, and the **route-by-route tenant-isolation sweep** (every route called anonymously and as another organization; fails if a new route is added without being classified) |
| **Evaluation engine** | `cd evaluation-engine && PYTHONPATH=src python3 -m unittest discover -s tests` | 90 | Evaluators, claim analysis, debugging engine, judge prompt-injection set, production payloads, result normalisation, server |
| **Python SDK** | `cd sdk/python && PYTHONPATH=src python3 -m unittest discover -s tests` | 44 | Trace contract, transport/retry, LangChain handler, `run_evaluation`, demo data |
| **Cross-language contract** | part of `npm test` | n/a | A trace built by the SDK (`sdk/python/tests/emit_sample_trace.py`) must be accepted by the Node validator (`scripts/validate-trace-file.mjs`). Both also share `packages/trace-schema/fixtures/` |
| **Web build** | `npm --prefix apps/web run build` | n/a | The React site must build for production |
| **Python only** | `npm run test:python` | n/a | Just the two Python suites |

Windows PowerShell: set `PYTHONPATH` first (`$env:PYTHONPATH="src"`) and use `python` or `py` instead of `python3`.

Run one API test file: `node --test apps/api/test/unit/ssrf.test.js` (from the project folder). The Python suites use the standard `unittest`; `pytest` also works if installed.

### Where the unit tests live

| File (in `apps/api/test/unit`) | Area |
|---|---|
| `config`, `crypto-jwt`, `redact-validate`, `ssrf`, `traceSchema` | Startup config, hashing/JWT/AES, redaction, SSRF guard, trace contract |
| `auth.service`, `m6-accounts` | Register/login/refresh/lockout/invitations/reset/roles |
| `agents-keys.service`, `traces.service` | Agents, API keys, ingestion, explorer |
| `m3-*` | Libraries, suites/import/judge config, evaluation runs, real-engine end-to-end |
| `m4-*` | Analytics and the debug service |
| `m5-*` | Pure monitoring/alert logic and the services |
| `m6-security` | Security regression set |

Test helpers: `apps/api/test/helpers/memoryRepos.js` (in-memory twin of every repository method) and `world.js` (builds a complete in-memory app with signup/agent helpers).

### Extra automated checks

| Check | Command |
|---|---|
| Load test, no infrastructure (API layer only, in-memory storage; **not** a MongoDB benchmark) | `node scripts/loadtest-ingest.mjs --inprocess --seconds 8 --concurrency 20 --batch 10` |
| Load test against a real deployment | `node scripts/loadtest-ingest.mjs --url http://localhost:4000/api/v1 --api-key ae_live_... --agent-id <id> --seconds 20 --concurrency 20 --batch 10` (prints traces/second, latency percentiles, status code counts; `429` means the ingest rate limit works, raise `INGEST_RATE_LIMIT_MAX` for the test) |
| Dependency audit | `npm --prefix apps/api audit --omit=dev` |
| Environment self-check | `npm run doctor` |
| Evaluator catalogue in sync with the engine | `python evaluation-engine/tests/regen_catalog.py` regenerates `apps/api/src/config/evaluatorCatalog.json` (a test fails when they drift apart) |

---

## Part B: API smoke test

Proves the stack works end to end before you open the browser. Needs `curl` (Windows: use Git Bash, or the SDK script in step 5 instead). Set `API=http://localhost:4000/api/v1`.

```bash
API=http://localhost:4000/api/v1

# 1. Health: both must be 200
curl -s $API/health
curl -s $API/health/ready                 # {"status":"ready","dependencies":{"mongo":"up"}}

# 2. Register (use any e-mail; password 10+ characters). Copy "token" from the answer.
curl -s $API/auth/register -H 'content-type: application/json' \
  -d '{"email":"smoke@example.com","password":"smoke-test-pass-1","name":"Smoke","organizationName":"Smoke Org"}'
TOKEN=<paste token>

# 3. Create an agent. Copy its "id".
curl -s $API/agents -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"name":"smoke-agent","framework":"custom"}'
AGENT=<paste id>

# 4. Create an API key. Copy "key" (shown once).
curl -s $API/api-keys -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"name":"smoke-key"}'
KEY=<paste key>

# 5. Ingest a minimal trace with the key
TID=$(python3 -c "import secrets;print(secrets.token_hex(16))")
curl -s -i $API/traces -H "authorization: Bearer $KEY" -H 'content-type: application/json' -d "{
  \"schemaVersion\":\"1.0\",\"traceId\":\"$TID\",\"agentId\":\"$AGENT\",\"environment\":\"test\",
  \"framework\":{\"name\":\"custom\"},\"status\":\"success\",\"input\":\"hello\",\"output\":\"hi\",
  \"startedAt\":\"2026-11-17T10:00:00.000Z\",\"endedAt\":\"2026-11-17T10:00:01.000Z\",\"spans\":[]}"
```

| Step | Expected |
|---|---|
| 1 | `{"status":"ok",...}` and `{"status":"ready",...}`. `503 degraded` = MongoDB not reachable |
| 2 | `201` with `token`, `refreshToken`, `user`, one organization with role `owner`. Repeating it: `409 EMAIL_IN_USE` |
| 3 | `201`, `status:"pending"`. Repeating the same name: `409 AGENT_NAME_EXISTS` |
| 4 | `201` with `key` starting `ae_live_`. A second `GET /api-keys` shows only the prefix |
| 5 | `HTTP/1.1 202` and `{"traceId":"…","status":"accepted"}`. Sending the identical command again: `200` and `"status":"duplicate"` |

Read it back and check isolation and permissions:

```bash
curl -s "$API/traces/$TID" -H "authorization: Bearer $TOKEN"       # full trace, 200
curl -s "$API/agents/$AGENT" -H "authorization: Bearer $TOKEN"     # status now "connected" (lastTraceAt set)
curl -s -o /dev/null -w "%{http_code}\n" "$API/traces/$TID" -H "authorization: Bearer $KEY"   # 403: keys cannot read traces
curl -s -o /dev/null -w "%{http_code}\n" "$API/agents"             # 401: no credentials
curl -s -o /dev/null -w "%{http_code}\n" "$API/agents" -H "authorization: Bearer $KEY"        # 403: default key has only traces:write
```

Now check the MongoDB-backed behaviour that the unit tests cannot: restart the API (`docker compose restart api`, or stop and start `dev:api`) and repeat `GET /traces/$TID`: the trace must still be there. Finally open the website, sign in with `smoke@example.com`: Agents shows `smoke-agent`, Traces shows the trace.

---

## Part C: First-user acceptance walkthrough

Do the sections in order; each builds on the previous one. Sections C1-C4 are the core (30 minutes).

### C1. Account, agent, key (5 min)
1. Open the site → **Create an account**. You land on Agents. The sidebar shows Dashboard; Build: Agents, Test suites, Evaluations; Production: Traces, Monitoring, Alerts; Workspace: Organization, Evaluators.
2. **New agent**: `laptop-agent`, framework LangChain, connection **Python SDK (runs on my machine)**.
3. Agent page → **Create API key**, copy it (shown once), confirm.
4. `pip install -e sdk/python`; export `AGENTEVAL_API_KEY`, `AGENTEVAL_AGENT_ID` (and `AGENTEVAL_ENDPOINT=http://localhost:8080` for Docker).
5. `python sdk/python/examples/send_test_trace.py` → `accepted: 1`. With `--twice` → 1 accepted, 1 duplicate. With `--fail` → one failed trace (try the *error* filter on Traces).
6. Open the trace: the stored input shows the fake secret **redacted** (`[REDACTED]`), not `sk-demo…`.

### C2. Test suite import (3 min)
1. **Test suites** → create `demo-suite` → open it → **Import** → **Insert a sample** → **Import**. ✅ "Imported 3 case(s)" (laptop, refund, hello).
2. Break it: import `[{"input":"ok"},{"nope":1}]` → ❌ message naming row 2 and the unknown field `nope`; the suite still has 3 cases. Tick the option to import valid rows → 1 case added.
3. CSV with header `input,referenceAnswer` works; a cell starting with `=` is stored as plain text.
4. Delete a case → it disappears; the case count drops by one.

### C3. Evaluation, SDK mode (5 min)
1. **Evaluations** → agent `laptop-agent`, suite `demo-suite`, mode **My own code (Python SDK)** → **Start**. ✅ Run page: 0 of 3, status `awaiting_traces`.
2. `export AGENTEVAL_RUN_ID=<run id>` then `python sdk/python/examples/evaluation_demo.py` → `Sent 3 of 3 traces. Agent errors: 0`. (The key needs the **evaluation runs** option: create a key with it on the agent page.)
3. ✅ Status `completed`, 3 evaluated, 2 passed, 1 failed (pass rate ≈ 67%). Needs the **worker and engine** running.

### C4. Reading results (the important part)
Open the laptop case → **Details**:
* **hallucination: fail**. A contradicted claim (52,999 vs evidence 47,999) with a step id.
* **tool_usage: fail**. Selection 100%, parameters 100%, **interpretation 0%** (right tool, wrong reporting).
* **accuracy: fail**; **completeness** about 50%; **relevance: pass** (metrics are independent).
* Refund case: accuracy / hallucination / groundedness **pass**. Hello case: instruction_adherence pass, relevance **inconclusive** (weak evidence never counts as a pass).

### C5. Endpoint mode (optional, 10 min)
1. `.env`: `ALLOW_PRIVATE_ENDPOINTS=true`; restart api and worker.
2. `python sdk/python/examples/demo_agent_server.py` (port 9100). Create agent `http-agent` with connection **HTTP endpoint** and URL `http://127.0.0.1:9100/run` (Docker: `http://host.docker.internal:9100/run`).
3. Start a run in endpoint mode → same verdicts without running anything yourself.
4. Stop the demo agent and run again → cases show `error` ("Could not reach the agent endpoint") and the run still **completes**.
5. Remove `ALLOW_PRIVATE_ENDPOINTS`, restart → creating the same agent is refused ("private or reserved network address").

### C6. AI judge (optional)
**Evaluators** page → enable the judge, choose provider/model, paste your key (stored encrypted, never shown again). New runs offer **Use the AI judge** with **Max judge calls**. Starting a run with the judge forced on while none is configured is refused (`JUDGE_NOT_CONFIGURED`). Without a judge everything above still works.

### C7. Dashboard, explorer, debugger (25 min)
1. Create agent `support-bot` + key, then `python sdk/python/examples/generate_demo_data.py` → "Sent 112 demo traces over 14 days".
2. **Dashboard**: demo-data notice; Executions **112** (8 failed); completion ≈ **92.9%**; avg latency ≈ **3.36 s**; quality cards show **—** until an evaluation exists (never a fake zero). Filters: status `error` → 8; environment `test` → 19; **Hide demo data** → 0.
3. Agent filter `support-bot` → version table: 1.0.0 (56 executions, ≈12.5% errors) vs 1.1.0 (56, ≈1.8%).
4. **Traces**: search `52,999` → 9 rows; `5 days` → 6; `.*` → 0 (search is literal, never a pattern).
5. **Debug** on a `52,999` trace: banner "Problems found", headline "Likely: final answer disagrees with a tool/retrieval result at step 'search_products'", certainty **likely**, **Show this step** opens the suspicious step, and the caveat "a suspicious step is a lead, not a proven root cause" is shown.
6. A delivery trace ("5 days") → certainty **possible**; an error trace → "Observed: step 'search_products' failed" (deepest step only); a refund trace → "Nothing found".
7. After C3, Debug the failed laptop case from the Dashboard: **affected metrics** are now real (hallucination, tool_usage, …).
8. Stop the engine → Debug shows "analysis engine is not reachable"; the rest of the site keeps working.

### C8. Live monitoring and alerts (20 min)
1. Create agent `monitor-bot` + key. **Monitoring** → `monitor-bot` → *Sampling and cost controls*: enable, share `20`, daily budget `50` → **Save policy**. Ticking the judge without a judge cap → red error on the daily judge budget.
2. **Alerts → New rule**: `Error spike`, Error rate, agent `monitor-bot`, critical, window 5, threshold 20%, min traces 10, cooldown 5, resolve after 2 OK. Threshold `0` → error naming `params.thresholdPct`. Initially **insufficient_data** (it never alerts on 3 traces).
3. Add a **Silence** rule (3 minutes).
4. Run `python scripts/simulate_live_traffic.py --api http://localhost:4000/api/v1 --api-key $AGENTEVAL_API_KEY --agent-id $AGENTEVAL_AGENT_ID --rate 3 --healthy-seconds 120 --degraded-seconds 240 --recovery-seconds 240` (use the key and id of `monitor-bot`).
   * Healthy: error rate ≈ 1%, health **healthy** after 10+ traces; the quality panel fills (needs worker + engine).
   * Degraded: error rate climbs toward ~40%, health goes **degraded → failing**, a critical `Error spike` alert appears (navigation badge `1`). **Acknowledge** keeps it open without duplicates.
   * Recovery: after two consecutive OK checks it **auto-resolves**; History keeps it.
5. Cost caps: the *queued* counter never exceeds the budget; set the daily budget to `0` → queued stays flat while *skipped* grows.
6. Stop the script → the `Silence` alert fires after about 4-5 minutes; restart it → it resolves.
7. In the rule editor **Test against live data** records nothing. Roles: viewer reads only, member acknowledges/resolves, admin edits rules.
8. Webhook (optional, e.g. webhook.site): afterwards only the **host** is shown; a POST arrives on open and on resolve with numbers but no trace text; `x-agenteval-signature` is present when a secret is set; `http://127.0.0.1:9/x` or `http://169.254.169.254/` is refused.

### C9. Organization, sessions, onboarding (25 min)
1. **Organization** tabs: General, Members, Invitations, API keys, Audit log, Account, Danger zone. Retention `30` saves; `0` → error naming `settings.traceRetentionDays`.
2. **Invite** `colleague@example.com` as member → one-time link `#/invite?token=ae_inv_…` shown once. Open it in a private window, set name and a 10+ character password → joined. Reusing the link fails; a duplicate pending invitation is refused.
3. Change their role to viewer → restrictions apply (no creating agents). The Audit log shows `invitation.created`, `invitation.accepted`, `member.role_changed` and no tokens or passwords.
4. **Change password**: a wrong current password is rejected; the correct one signs out other devices. Admin **Reset password** → one-time `#/reset?token=ae_rst_…` link; completing it ends all of that user's sessions.
5. **Lockout**: 5 wrong passwords → the 6th attempt is refused even with the right password (also for unknown e-mails). **Sign out everywhere** works.
6. A tab left open 20 minutes stays signed in (silent refresh of the 15-minute token).
7. A new organization shows "Getting started: 0 of 5 done"; steps tick only with real data. **Danger zone → Delete demo data** removes only demo traces.
8. `ALLOW_REGISTRATION=false` + `docker compose up -d` → "Sign-up is closed on this server"; invitation links still work.

### C10. Negative tests (any time)

| Try | Expected |
|---|---|
| Run on an empty suite | "This test suite has no test cases" |
| Cancel a run while it waits | `cancelled`; late traces are refused |
| Re-send traces for a completed run | "This run is completed and no longer accepts traces" |
| A second account opens the first account's `#/runs/<id>` or `#/debug/<traceId>` | "not found"; no data leaks |
| Wrong bearer token on trace/evaluation calls | `401`, nothing stored |
| `GET /traces?minDurationMs=-5` | `400` with a clear message |
| Import a CSV or JSON case containing `password=hunter2` | stored as `password=[REDACTED]`; `secretsRedacted` > 0 |

---

## Part D: Server, security and load checks

Do on a server (see [SETUP_GUIDE §13](SETUP_GUIDE.md#13-putting-it-on-a-server-https)); about 45 minutes.

1. **Headers:** `curl -sI https://DOMAIN` must show `strict-transport-security`, `content-security-policy` (starting `default-src 'self'`), `x-content-type-options: nosniff`, `x-frame-options: DENY`, `referrer-policy: no-referrer`, and no `server:` version. `http://` redirects to https. The browser console shows no CSP violations.
2. **Containers:** `docker compose ps` → all healthy; `docker compose exec api id` → user `node`, not root; `docker compose exec api touch /app/x` → read-only filesystem. From outside: `nmap -p 27017,4000,8000 DOMAIN` → closed or filtered.
3. **Backup and restore:** `deploy/scripts/backup.sh` → archive; delete an agent; `deploy/scripts/restore.sh <archive>` (type `RESTORE`) → the agent returns after `npm run doctor`; sessions from before the backup are gone.
4. **Load:** the `loadtest-ingest.mjs --url …` command from Part A. Look for `tracesPerSecond`, latency percentiles and `statusCodes`.
5. **Tenant isolation by hand:** create two accounts; with account B's token call `GET /agents/<A's agent id>`, `GET /traces/<A's trace id>`, `GET /evaluations/<A's run id>` → always `404` (or `403`), never data. (The automated sweep already does this for every route against the in-memory twin.)

---

## Test data and helper scripts

| File | Use |
|---|---|
| `sdk/python/examples/send_test_trace.py` (`--fail`, `--twice`) | One hand-built trace with a planted bug (tool says 47,999, answer says 52,999) and a fake secret to verify redaction |
| `sdk/python/examples/generate_demo_data.py` (`--days`, `--per-day`) | 112 repeatable demo traces over 14 days, two versions (1.0.0 / 1.1.0), planted problems, all tagged demo |
| `sdk/python/examples/evaluation_demo.py` | Runs an SDK-mode evaluation against a run id |
| `sdk/python/examples/demo_agent_server.py` | Tiny HTTP agent on port 9100 for endpoint mode |
| `sdk/python/examples/langchain_demo.py`, `langgraph_demo.py` | Real LangChain/LangGraph instrumentation with a fake model (need the extras installed) |
| `scripts/simulate_live_traffic.py` | Healthy → degraded → recovery production traffic for monitoring and alerts |
| `scripts/loadtest-ingest.mjs` | Ingestion load test |
| `scripts/doctor.mjs`, `scripts/verify.mjs` | Environment self-check; run-everything test command |
| `packages/trace-schema/fixtures/valid-trace.json`, `invalid-cases.json` | The shared trace contract: one valid trace and 14 mutations that must all be rejected |

## Not built yet (do not report as bugs)

Consistency evaluator, custom evaluation criteria end to end, workspaces, report export, e-mail (self-service reset, invitation e-mails), MFA/SSO, `ENCRYPTION_KEY` rotation tool, push notifications (pages poll), file upload of reference documents (paste text), Slack-app/e-mail alert channels (webhook only).

## Reporting a failure

Include: step number · expected vs seen · full error text or screenshot · output of `npm run doctor` · the `requestId` from the error body. **Never paste `.env` or a full API key.**
