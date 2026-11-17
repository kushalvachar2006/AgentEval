# AgentEval Setup Guide

Everything you need to get AgentEval running **locally**, from an empty machine to a first trace in the website. Allow about 15 minutes. At the end there are reference sections for every setting, backup/restore, upgrades and troubleshooting, plus a short note on putting it on a server.

**Contents**
1. [What you are installing](#1-what-you-are-installing)
2. [Prerequisites](#2-prerequisites)
3. [Get the project and create your settings](#3-get-the-project-and-create-your-settings)
4. [Check your machine](#4-check-your-machine)
5. [Run it: choose Option A or Option B](#5-run-it)
6. [Create your account](#6-create-your-account)
7. [Install the Python SDK and send a first trace](#7-install-the-python-sdk-and-send-a-first-trace)
8. [Optional: AI judge](#8-optional-ai-judge)
9. [Daily commands cheat sheet](#9-daily-commands-cheat-sheet)
10. [Configuration reference](#10-configuration-reference)
11. [Troubleshooting](#11-troubleshooting)
12. [Backup, restore and upgrades](#12-backup-restore-and-upgrades)
13. [Putting it on a server (HTTPS)](#13-putting-it-on-a-server-https)

---

## 1. What you are installing

| Process | What it is | Local port |
|---|---|---|
| **mongo** | MongoDB 7: all data and the job queue | 27017 (dev mode only) |
| **api** | Node/Express REST API (`apps/api`, `src/index.js`) | 4000 |
| **worker** | Same code and image as the API, run as `src/worker.js`: evaluations, sampled production evaluation, alert rules, webhooks | none |
| **engine** | Python service that computes scores and debugging findings (`evaluation-engine`) | 8000 (private) |
| **web** | React website. Docker: nginx on 8080 (also proxies `/api`). Dev mode: Vite on 5173 | 8080 / 5173 |

Architecture details: [ARCHITECTURE.md](ARCHITECTURE.md).

## 2. Prerequisites

| Tool | Needed for | Version |
|---|---|---|
| **Node.js** | Helper scripts always; API and website in developer mode | 20 or newer (Docker images use 22) |
| **Python** | Evaluation engine in developer mode, the SDK and test scripts | 3.10 or newer |
| **Docker** with Compose v2 | MongoDB (both options) and the whole stack (Option A) | current |
| **Git** | Getting the code | any |

Check: `node --version`, `python3 --version` (Windows: `python --version` or `py --version`), `docker compose version`.

You do **not** need any AI provider key to run AgentEval. Everything works without one; the optional AI judge only improves some scores ([section 8](#8-optional-ai-judge)).

## 3. Get the project and create your settings

Open a terminal in the project folder (the one containing `docker-compose.yml` and `package.json`).

```bash
npm run init:env
```

This creates `.env` with fresh random secrets (`MONGO_ROOT_PASSWORD`, `ENGINE_TOKEN`, `JWT_SECRET`, `ENCRYPTION_KEY`), file mode 600. It **refuses to overwrite** an existing `.env`. After pulling a newer version, run `npm run init:env -- --add-missing` to append only new settings without touching your secrets.

> **Never commit or share `.env`.** `ENCRYPTION_KEY` encrypts stored provider keys, agent tokens and webhook URLs. If you lose it those stored secrets cannot be read again (you re-enter them); keep a copy in a password manager.

## 4. Check your machine

```bash
npm run doctor
```

Green checks are good. Warnings that MongoDB, the engine or the API are "not reachable" are normal before you start anything. A red cross means a required tool is missing or `.env` is invalid, and the line below it tells you how to fix it.

## 5. Run it

### Option A: everything in Docker (simplest)

```bash
docker compose up -d --build
npm run doctor
```

The first build takes 1-3 minutes. Then open **http://localhost:8080**.

* Starts `mongo`, `api` (published on `127.0.0.1:4000` only), `worker`, `engine` (not published) and `web` (`127.0.0.1:8080`). The containers are hardened: non-root, read-only filesystem, no extra capabilities.
* Stop: `docker compose down` (data is kept in the `mongo_data` volume). **Erase all data:** `docker compose down -v`.
* Logs: `docker compose logs -f api worker engine`.
* After changing `.env` or the code: `docker compose up -d --build`.

### Option B: developer mode (hot reload)

```bash
npm run install:all      # installs API + website packages (npm ci/install in apps/api and apps/web)
npm run dev:infra        # starts MongoDB only, in Docker (docker-compose.dev.yml, port 127.0.0.1:27017)
```

Wait about 15 seconds for MongoDB to become healthy (`docker compose -f docker-compose.dev.yml ps`), then start four processes, each in its own terminal:

```bash
npm run dev:engine       # Python engine on http://127.0.0.1:8000 (reads ENGINE_TOKEN from .env)
npm run dev:api          # API on http://localhost:4000 (auto-restarts on change)
npm run dev:worker       # background worker: evaluations, alerts
npm run dev:web          # website on http://localhost:5173 (Vite proxies /api to :4000)
```

Open **http://localhost:5173**. Start `dev:api` only after MongoDB is healthy: the API exits if it cannot connect (just run it again). In this mode the API and worker read `../../.env` (`node --env-file`), and the default `MONGODB_URI` points at `localhost:27017`. If your API runs on a different port, set `VITE_API_PROXY=http://localhost:<port>` before `npm run dev:web`.

Stop MongoDB with `npm run dev:infra:down`.

### Verify the stack

```bash
npm run doctor                                   # every line green once all services are up
curl http://localhost:4000/api/v1/health         # {"status":"ok",...}
curl http://localhost:4000/api/v1/health/ready   # {"status":"ready","dependencies":{"mongo":"up"}}
```

In the website, the sidebar footer shows system status (use **Re-check** if it says "down" while services are still starting).

## 6. Create your account

Open the website and choose **Create an account**. Enter name, e-mail, a password of at least 10 characters, and an organization name. **The first account becomes the organization owner.**

The Dashboard shows a *Getting started* checklist (agent → trace → test suite → evaluation run → alert rule). Its steps tick only when real data exists.

The sidebar groups: **Dashboard**; **Build** (Agents, Test suites, Evaluations); **Production** (Traces, Monitoring, Alerts); **Workspace** (Organization, Evaluators).

## 7. Install the Python SDK and send a first trace

```bash
cd sdk/python
python -m venv .venv
source .venv/bin/activate                  # Windows PowerShell: .venv\Scripts\Activate.ps1   (cmd: .venv\Scripts\activate)
pip install -e .                           # core SDK uses only the standard library
pip install -e ".[langchain,langgraph]"    # optional: only if your agent uses them
cd ../..
```

1. In the website: **Agents → New agent**. Name it `laptop-agent`, framework *LangChain*, connection **Python SDK (runs on my machine)**.
2. Open the agent page, **Create API key**, copy the key (shown **once**), then confirm.
3. Copy the **agent id** shown on the agent page.
4. Send a demo trace (no LangChain or LLM key needed):

```bash
export AGENTEVAL_API_KEY=ae_live_...            # Windows PowerShell:  $env:AGENTEVAL_API_KEY="ae_live_..."
export AGENTEVAL_AGENT_ID=<agent id>
export AGENTEVAL_ENDPOINT=http://localhost:8080  # Docker. Dev mode: http://localhost:4000 (the default)
python sdk/python/examples/send_test_trace.py
```

Expected output: `export stats: {... 'accepted': 1 ...}`. Open **Traces** in the website to see it. The demo trace contains a planted bug (the tool returns ₹47,999 but the answer says ₹52,999) and a fake secret, which the SDK redacts before sending. Click **Debug** on the trace to see the engine flag the wrong price.

The SDK refuses plain `http://` endpoints unless the host is `localhost`/`127.0.0.1`/`::1`. API reference and all SDK calls: [API_DOCS.md §14](API_DOCS.md#14-python-sdk-quick-reference).

### Using a deployed site (no local clone)

If AgentEval is already deployed and you only need to connect an agent, skip the clone and the editable install above:

```bash
pip install "agenteval @ git+https://github.com/kushalvachar2006/AgentEval.git#subdirectory=sdk/python"      # add [langchain] or [langgraph] if needed
export AGENTEVAL_API_KEY=ae_live_...
export AGENTEVAL_ENDPOINT=https://your-site.netlify.app          # the site address, no /api/v1
```

The agent page and the evaluation run page in the website show these commands already filled in. To run an **evaluation** against the deployed site, follow [TEST_GUIDE: Running an evaluation on the deployed site](TEST_GUIDE.md#running-an-evaluation-on-the-deployed-site-no-local-clone). When you host your own copy, set the Netlify variables `VITE_SDK_REPO` (your fork's `.git` URL) and, if the API has a different address from the site, `VITE_API_URL`, so the commands shown in the website use them.

## 8. Optional: AI judge

Some scores (relevance, semantic accuracy, borderline claims) are more reliable with an LLM judge. Configure it **in the website**: **Evaluators** page → enable, pick provider (`openai_compatible` for OpenAI, Azure-style gateways, vLLM, Ollama, LiteLLM; or `anthropic`), model, optionally base URL, and paste the API key. The key is stored **encrypted per organization**, never in `.env`, and is never shown again. New evaluation runs then offer *Use the AI judge* with a *Max judge calls* cap.

A judge on `localhost` (for example Ollama) is blocked by default; set `ALLOW_PRIVATE_ENDPOINTS=true` in `.env` and restart (see the warning in [section 10](#10-configuration-reference)).

## 9. Daily commands cheat sheet

| Task | Command |
|---|---|
| Start everything (Docker) | `docker compose up -d` |
| Stop (keep data) | `docker compose down` |
| Rebuild after changes | `docker compose up -d --build` |
| Start dev infrastructure | `npm run dev:infra` |
| Run engine / API / worker / website | `npm run dev:engine` / `dev:api` / `dev:worker` / `dev:web` |
| Health check of your machine | `npm run doctor` |
| Run all tests | `npm test` (see [TEST_GUIDE.md](TEST_GUIDE.md)) |
| Add new settings after an upgrade | `npm run init:env -- --add-missing` |
| Logs (Docker) | `docker compose logs -f <service>` |
| Fill the dashboard with sample data | `python sdk/python/examples/generate_demo_data.py` |

---

## 10. Configuration reference

All settings are environment variables, normally in `.env`. The API **refuses to start** if a required secret is missing or weak (`JWT_SECRET` under 32 characters, `ENCRYPTION_KEY` not base64 for exactly 32 bytes, `MONGODB_URI` not starting with `mongodb://` or `mongodb+srv://`, any numeric setting not a positive integer). Error messages name the variable but never print its value. `docker-compose.yml` passes the settings marked ✔ through to the containers.

### Required (generated by `npm run init:env`)

| Variable | Compose | Meaning |
|---|---|---|
| `MONGO_ROOT_USER` / `MONGO_ROOT_PASSWORD` | ✔ | MongoDB credentials used by Docker Compose (user defaults to `agenteval`) |
| `MONGODB_URI` | set automatically | Connection string. Needed in `.env` for developer mode; inside Compose it is built from the two values above and points at the `mongo` service |
| `JWT_SECRET` | ✔ | Signs access tokens, at least 32 characters (48+ generated). Changing it signs everyone out |
| `ENCRYPTION_KEY` | ✔ | 32 random bytes, base64. Encrypts judge keys, agent endpoint tokens, webhook URLs and secrets at rest. Losing it means those secrets must be re-entered |
| `ENGINE_TOKEN` | ✔ | Shared secret between worker and engine (engine requires 16+ characters) |
| `ENGINE_URL` | worker only | Engine address; default `http://127.0.0.1:8000` (Compose sets `http://engine:8000`) |
| `CORS_ORIGINS` | ✔ | Comma-separated website origins allowed to call the API (exact match, scheme+host+port). Dev default includes `http://localhost:8080` and `http://localhost:5173` |
| `NODE_ENV` | ✔ | `development` or `production` |
| `WEB_PORT` (8080), `API_PORT` (4000) | ✔ | Published host ports |

### Network safety

| Variable | Default | Meaning |
|---|---|---|
| `ALLOW_PRIVATE_ENDPOINTS` | `false` | When `true`, agent endpoint URLs, judge URLs and webhook URLs may point at localhost/private addresses; the engine's `ENGINE_ALLOW_PRIVATE_JUDGE_URLS` follows it. **This turns the SSRF network guard off.** Use only on a private, self-hosted install. Needed for endpoint-mode evaluation against an agent on your own machine |

### Sessions and sign-in

| Variable | Default | Meaning |
|---|---|---|
| `ALLOW_REGISTRATION` | `true` | `false` closes public sign-up after the first account; everyone else joins by invitation. **Set this on any server reachable from the internet** |
| `JWT_TTL_SECONDS` | 900 | Access-token lifetime (renewed silently by the refresh token) |
| `REFRESH_TTL_DAYS` | 30 | How long a device stays signed in without activity |
| `LOGIN_MAX_FAILURES` / `LOGIN_WINDOW_MINUTES` / `LOGIN_LOCK_MINUTES` | 5 / 15 / 15 | Per-account lockout (also for unknown e-mails) |
| `AUTH_RATE_LIMIT_MAX` | 10 | Failed sign-ins/registrations per 15 min per IP |
| `INVITE_TTL_DAYS` / `RESET_TTL_MINUTES` | 7 / 60 | Lifetime of invitation / password-reset links |

### Data, retention and limits

| Variable | Default | Meaning |
|---|---|---|
| `TRACE_RETENTION_DAYS` | 90 | Default for new organizations; each organization can change it under Organization → General (applies to traces ingested afterwards) |
| `MAX_TRACE_BYTES` | 4194304 | Largest stored trace after redaction/truncation |
| `INGEST_RATE_LIMIT_MAX` | 600 | Trace uploads per minute per API key |
| `ROLLUP_RETENTION_DAYS` | 400 | Hourly rollups kept |
| `ALERT_RETENTION_DAYS` | 365 | Fired alerts kept |
| `MAX_ALERT_RULES` | 100 | Alert rules per organization |
| `PROD_EVAL_MAX_AGE_HOURS` | 24 | Sampled production traces older than this are skipped if the worker was far behind |
| `ALERT_TICK_MS` | 15000 | How often a worker looks for due alert rules |

### Evaluation

| Variable | Default | Meaning |
|---|---|---|
| `WORKER_CONCURRENCY` | 2 | Evaluation cases processed in parallel per worker |
| `MAX_CASES_PER_RUN` | 500 | Largest suite one run may evaluate |
| `DEFAULT_MAX_JUDGE_CALLS` | 200 | AI-judge calls per run unless the run sets its own |
| `SDK_RUN_WAIT_MINUTES` | 30 | How long an SDK-driven run waits for your agent's traces |
| `AGENT_CALL_TIMEOUT_MS` | 60000 | Timeout per call to your agent's HTTP endpoint |

### Production with HTTPS

| Variable | Meaning |
|---|---|
| `DOMAIN`, `ACME_EMAIL` | Used by `docker-compose.prod.yml` (Caddy with automatic Let's Encrypt) |
| `WEB_BIND` | Interface the website port binds to (default `127.0.0.1`). Use `0.0.0.0` only without the bundled Caddy and with your own firewall |
| `PUBLIC_WEB_URL` | Lets webhook messages link back to the website |
| `TRUST_PROXY` | Number of reverse-proxy hops in front of the API (Compose sets `1`; the code default is `0`). A wrong value makes per-IP rate limits spoofable or useless |

### Code-level settings (not in `.env.example`, and **not** passed through by Compose)

These exist in `apps/api/src/config/env.js` with sensible defaults. To change them with Docker you must add them to `x-app-env` in `docker-compose.yml`; in developer mode they work from `.env`.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | 4000 | API port inside the process |
| `BODY_LIMIT_KB` / `INGEST_BODY_LIMIT_KB` | 1024 / 5120 | JSON body limits (general / trace endpoints) |
| `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_MS` | 300 / 60000 | General per-IP rate limit |
| `AUTH_RATE_LIMIT_WINDOW_MS` | 900000 | Window for the auth limiter |
| `WORKER_POLL_MS` | 1000 | Job queue polling interval |
| `ENGINE_TIMEOUT_MS` | 60000 | Worker → engine call timeout |
| `APP_VERSION` | 0.6.0 | Version reported by `/health` |

Engine-only variables: `ENGINE_TOKEN`, `ENGINE_HOST` (default `0.0.0.0`; the dev script uses `127.0.0.1`), `ENGINE_PORT` (8000), `ENGINE_ALLOW_PRIVATE_JUDGE_URLS`.

---

## 11. Troubleshooting

| Symptom | Fix |
|---|---|
| `docker: command not found` / daemon not running | Install Docker and start it |
| `variable is not set … run npm run init:env first` | Run `npm run init:env` ([section 3](#3-get-the-project-and-create-your-settings)) |
| `.env already exists - not overwriting` | Intended. Use `npm run init:env -- --add-missing` to append new settings |
| API exits at startup with `Invalid configuration:` | The message lists the variables; fix them in `.env` |
| API exits with a MongoDB error | `docker compose -f docker-compose.dev.yml ps`, wait for *healthy*, run `npm run dev:api` again. Check the password in `MONGODB_URI` matches `MONGO_ROOT_PASSWORD`. **If you changed `MONGO_ROOT_PASSWORD` after MongoDB first started, the old password stays in its volume**: `docker compose down -v` (erases data) or reset the user inside MongoDB |
| `dev:worker`: `ENGINE_TOKEN is required` | `.env` is from an older version: `npm run init:env -- --add-missing` |
| Evaluation runs stay at 0 cases / "engine is unreachable" | Engine not running: `npm run dev:engine` or `docker compose up -d`. A 401 in worker logs means `ENGINE_TOKEN` differs between engine and worker |
| Runs stay `queued` | The worker is not running (`npm run dev:worker`, or check `docker compose logs worker`) |
| Port already in use (8080 / 4000 / 27017 / 5173) | Stop the other program or change `WEB_PORT` / `API_PORT` in `.env` |
| Website shows API "down" | API not running (Option B) or still starting (Option A: wait, click **Re-check**) |
| Browser console shows a CORS error | `CORS_ORIGINS` must exactly match the origin you open in the browser |
| Everyone suddenly signed out | `JWT_SECRET` changed, or the database was restored from an older backup. Expected after upgrading from 0.5 |
| `Too many failed sign-in attempts` | Per-account lock for 15 minutes; wait, or an admin issues a password-reset link (which clears it) |
| Agent creation: "private or reserved network address" / "host is not allowed" | The SSRF guard blocks `localhost`/private URLs. Set `ALLOW_PRIVATE_ENDPOINTS=true` and restart api + worker (self-hosted only). In Docker use `http://host.docker.internal:<port>` to reach a program on your computer |
| SDK: `plain http is only allowed for localhost` | Use `https://`, or `localhost`/`127.0.0.1` |
| SDK: `AgentEvalHTTPError 404 AGENT_NOT_FOUND` | `agentId` must be the 24-hex id from the agent page, not the agent name |
| SDK: `401 INVALID_API_KEY` | Key revoked/expired/mistyped. Create a new one |
| Trace appears with `[REDACTED]` in text | Working as designed: key-like values and `password=…` text are redacted. Redaction is best-effort |
| Docker build fails | Read the first error in `docker compose build --no-cache`; Compose **v2.24+** is needed for the production overlay (`!reset`) |
| Disk filling | Traces expire by TTL (default 90 days): lower retention under Organization; check `docker system df` |

**Before publishing the repository:** the file `sdk/python/p1.py` contains a real-looking API key (`ae_live_kcj3…`) although the changelog says it was removed. In the website go to **Organization → API keys** and revoke it, then delete the file. A stray `pnpm-lock.yaml` (114 bytes, ignored by `.gitignore`) can also be deleted.

---

## 12. Backup, restore and upgrades

Everything AgentEval stores is in MongoDB (database `agenteval`). Secrets inside it are encrypted with `ENCRYPTION_KEY`, which is **not** in the database. Back up both: the database, and `.env` (especially `ENCRYPTION_KEY` and `JWT_SECRET`) kept separately and encrypted.

```bash
deploy/scripts/backup.sh                       # writes backups/agenteval-<UTC time>.archive.gz (mode 600)
deploy/scripts/restore.sh backups/<file>       # DESTRUCTIVE; asks you to type RESTORE; stops api/worker/web, replaces data, restarts
npm run doctor                                 # after a restore
```

Both scripts use the Docker Compose stack (`docker compose exec mongo …`). Daily cron example: `30 2 * * * cd /opt/agenteval && deploy/scripts/backup.sh /var/backups/agenteval`. Copy archives off the server. **Test a restore on another machine before you need it.** The author never ran these scripts against a real MongoDB; try them on test data first.

| Situation | Action |
|---|---|
| Server lost | New server, restore `.env`, `docker compose up -d`, then `restore.sh` with the latest archive |
| Lost `ENCRYPTION_KEY` | Restore works; re-enter judge keys, agent endpoint tokens, webhook URLs |
| Leaked `JWT_SECRET` | Change it in `.env`, `docker compose up -d api worker`; everyone signs in again; review the audit log |

**Standard upgrade (Docker):**

```bash
deploy/scripts/backup.sh
git pull                                  # or unpack the new release over the folder, keeping .env
npm run init:env -- --add-missing
docker compose up -d --build              # production: add  -f docker-compose.yml -f docker-compose.prod.yml
npm run doctor
```

Mongoose creates new collections and indexes at start; watch `docker compose logs -f api worker` for the first minute. To roll back, redeploy the previous images (new fields are ignored by old code) and, if `CHANGELOG.md` says data semantics changed, restore the pre-upgrade backup.

Routine administration is in the website: **Organization** → Members (roles, remove, *Reset password* link), Invitations (one-time links; no e-mail is sent), API keys (revoke), Audit log, General (retention), Danger zone (delete demo data).

---

## 13. Putting it on a server (HTTPS)

Requirements: Linux server (2 vCPU / 4 GB RAM is enough to start), Docker Engine with Compose **v2.24+**, a DNS name pointing at it, ports 80 and 443 open.

```bash
git clone <repo> agenteval && cd agenteval
npm run init:env
cat >> .env <<'EOT'
NODE_ENV=production
DOMAIN=agenteval.example.com
ACME_EMAIL=you@example.com
CORS_ORIGINS=https://agenteval.example.com
PUBLIC_WEB_URL=https://agenteval.example.com
EOT
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
npm run doctor
```

Then open `https://<DOMAIN>`, register (first account = owner), set `ALLOW_REGISTRATION=false` in `.env`, run `docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d` again, and invite colleagues from **Organization → Invitations**.

* **Firewall:** allow only 22, 80, 443. MongoDB (27017), the API (4000) and the engine (8000) must never be reachable from the internet; the Compose files bind them to localhost or the private network.
* **Your own proxy instead of Caddy:** start without the production overlay, keep `WEB_BIND=127.0.0.1` and `WEB_PORT=8080`, and adapt `deploy/nginx/agenteval.conf.example`. Keep `TRUST_PROXY=1`.
* **Secrets in production:** do not bake `.env` into images; inject `JWT_SECRET`, `ENCRYPTION_KEY`, `ENGINE_TOKEN`, `MONGODB_URI` from your platform's secret store. `ENCRYPTION_KEY` has no rotation tool (rotating means re-entering judge keys, endpoint tokens and webhook URLs). Rotating `JWT_SECRET` signs everyone out; rotate `ENGINE_TOKEN` on engine and workers together.
* **Scaling / managed MongoDB:** run several `api` and `worker` replicas (queue leases and atomic counters make this safe); keep the engine private. Use MongoDB 5.0+ (7 recommended; the code uses `$dateTrunc`) with TLS, authentication and backups. The web `nginx.conf` expects the API hostname `api`; adjust `proxy_pass` for other layouts. Health endpoints: `/api/v1/health` (liveness), `/api/v1/health/ready` (readiness).
* **Status honesty:** the Docker/Compose/Caddy setup and the MongoDB layer were written and statically checked but never run on a real Docker host or MongoDB by the original author. Do the first deployment on a throwaway server.

Pre-launch checklist: `NODE_ENV=production`; `.env` mode 600 and not in git; HTTPS works with HSTS (`curl -sI https://DOMAIN | grep -i strict`); `CORS_ORIGINS` lists only your https origin; only ports 22/80/443 open; MongoDB not exposed and a **restore tested**; `ALLOW_PRIVATE_ENDPOINTS=false`; `ALLOW_REGISTRATION=false`; a second owner exists as break-glass; `npm --prefix apps/api audit --omit=dev` clean.

Self-hosted AgentEval contacts nothing but what you configure: an AI judge provider (optional), webhook URLs you set, and your agents' endpoints.
