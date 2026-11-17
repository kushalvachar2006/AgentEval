// Central, validated configuration. Imports nothing so it is testable without installing deps.
// Error messages name variables but never print their values (no secret leakage).
const toInt = (v, d) => (v === undefined || v === '' ? d : Number.parseInt(v, 10));

export function loadConfig(env = process.env) {
  const problems = [];
  const need = (name) => {
    const v = env[name];
    if (!v) problems.push(`${name} is required`);
    return v;
  };

  const nodeEnv = env.NODE_ENV || 'development';
  const mongoUri = need('MONGODB_URI');
  const jwtSecret = need('JWT_SECRET');
  const encKey = need('ENCRYPTION_KEY');

  if (mongoUri && !/^mongodb(\+srv)?:\/\//.test(mongoUri)) problems.push('MONGODB_URI must start with mongodb:// or mongodb+srv://');
  if (jwtSecret && jwtSecret.length < 32) problems.push('JWT_SECRET must be at least 32 characters');
  if (encKey && Buffer.from(encKey, 'base64').length !== 32) problems.push('ENCRYPTION_KEY must be base64 for exactly 32 bytes');

  const ints = {
    PORT: toInt(env.PORT, 4000),
    BODY_LIMIT_KB: toInt(env.BODY_LIMIT_KB, 1024),
    INGEST_BODY_LIMIT_KB: toInt(env.INGEST_BODY_LIMIT_KB, 5120),
    RATE_LIMIT_MAX: toInt(env.RATE_LIMIT_MAX, 300),
    RATE_LIMIT_WINDOW_MS: toInt(env.RATE_LIMIT_WINDOW_MS, 60_000),
    AUTH_RATE_LIMIT_MAX: toInt(env.AUTH_RATE_LIMIT_MAX, 10),
    AUTH_RATE_LIMIT_WINDOW_MS: toInt(env.AUTH_RATE_LIMIT_WINDOW_MS, 15 * 60_000),
    INGEST_RATE_LIMIT_MAX: toInt(env.INGEST_RATE_LIMIT_MAX, 600),
    JWT_TTL_SECONDS: toInt(env.JWT_TTL_SECONDS, 15 * 60),   // short-lived access token; the refresh token renews it
    REFRESH_TTL_DAYS: toInt(env.REFRESH_TTL_DAYS, 30),
    LOGIN_MAX_FAILURES: toInt(env.LOGIN_MAX_FAILURES, 5),
    LOGIN_WINDOW_MINUTES: toInt(env.LOGIN_WINDOW_MINUTES, 15),
    LOGIN_LOCK_MINUTES: toInt(env.LOGIN_LOCK_MINUTES, 15),
    INVITE_TTL_DAYS: toInt(env.INVITE_TTL_DAYS, 7),
    RESET_TTL_MINUTES: toInt(env.RESET_TTL_MINUTES, 60),
    TRACE_RETENTION_DAYS: toInt(env.TRACE_RETENTION_DAYS, 90),
    MAX_TRACE_BYTES: toInt(env.MAX_TRACE_BYTES, 4 * 1024 * 1024),
    WORKER_CONCURRENCY: toInt(env.WORKER_CONCURRENCY, 2),
    WORKER_POLL_MS: toInt(env.WORKER_POLL_MS, 1000),
    ENGINE_TIMEOUT_MS: toInt(env.ENGINE_TIMEOUT_MS, 60_000),
    AGENT_CALL_TIMEOUT_MS: toInt(env.AGENT_CALL_TIMEOUT_MS, 60_000),
    MAX_CASES_PER_RUN: toInt(env.MAX_CASES_PER_RUN, 500),
    DEFAULT_MAX_JUDGE_CALLS: toInt(env.DEFAULT_MAX_JUDGE_CALLS, 200),
    SDK_RUN_WAIT_MINUTES: toInt(env.SDK_RUN_WAIT_MINUTES, 30),
    ALERT_TICK_MS: toInt(env.ALERT_TICK_MS, 15_000),
    PROD_EVAL_MAX_AGE_HOURS: toInt(env.PROD_EVAL_MAX_AGE_HOURS, 24),
    MAX_ALERT_RULES: toInt(env.MAX_ALERT_RULES, 100),
    ROLLUP_RETENTION_DAYS: toInt(env.ROLLUP_RETENTION_DAYS, 400),
    ALERT_RETENTION_DAYS: toInt(env.ALERT_RETENTION_DAYS, 365),
  };
  for (const [n, v] of Object.entries(ints)) {
    if (!Number.isInteger(v) || v <= 0) problems.push(`${n} must be a positive integer`);
  }

  if (problems.length) {
    const err = new Error(`Invalid configuration:\n - ${problems.join('\n - ')}`);
    err.code = 'INVALID_CONFIG';
    err.problems = problems;
    throw err;
  }

  return Object.freeze({
    nodeEnv,
    isProduction: nodeEnv === 'production',
    port: ints.PORT,
    mongoUri,
    jwtSecret,
    encryptionKey: encKey,
    corsOrigins: (env.CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
    trustProxy: toInt(env.TRUST_PROXY, 0),
    bodyLimitKb: ints.BODY_LIMIT_KB,
    ingestBodyLimitKb: ints.INGEST_BODY_LIMIT_KB,
    rateLimitMax: ints.RATE_LIMIT_MAX,
    rateLimitWindowMs: ints.RATE_LIMIT_WINDOW_MS,
    authRateLimitMax: ints.AUTH_RATE_LIMIT_MAX,
    authRateLimitWindowMs: ints.AUTH_RATE_LIMIT_WINDOW_MS,
    ingestRateLimitMax: ints.INGEST_RATE_LIMIT_MAX,
    jwtTtlSeconds: ints.JWT_TTL_SECONDS,
    refreshTtlDays: ints.REFRESH_TTL_DAYS,
    loginMaxFailures: ints.LOGIN_MAX_FAILURES,
    loginWindowMinutes: ints.LOGIN_WINDOW_MINUTES,
    loginLockMinutes: ints.LOGIN_LOCK_MINUTES,
    inviteTtlDays: ints.INVITE_TTL_DAYS,
    resetTtlMinutes: ints.RESET_TTL_MINUTES,
    traceRetentionDays: ints.TRACE_RETENTION_DAYS,
    maxTraceBytes: ints.MAX_TRACE_BYTES,
    // Self-hosted users often run agents on their own network; SaaS must keep this false.
    engineUrl: (env.ENGINE_URL || 'http://127.0.0.1:8000').replace(/\/$/, ''),
    engineToken: env.ENGINE_TOKEN || '',
    workerConcurrency: ints.WORKER_CONCURRENCY,
    workerPollMs: ints.WORKER_POLL_MS,
    engineTimeoutMs: ints.ENGINE_TIMEOUT_MS,
    agentCallTimeoutMs: ints.AGENT_CALL_TIMEOUT_MS,
    maxCasesPerRun: ints.MAX_CASES_PER_RUN,
    defaultMaxJudgeCalls: ints.DEFAULT_MAX_JUDGE_CALLS,
    sdkRunWaitMinutes: ints.SDK_RUN_WAIT_MINUTES,
    allowPrivateEndpoints: env.ALLOW_PRIVATE_ENDPOINTS === 'true',
    // Open sign-up is right for trying it out; for a private/team install set ALLOW_REGISTRATION=false (the very first account is still allowed, everyone else joins by invitation)
    allowRegistration: env.ALLOW_REGISTRATION !== 'false',
    alertTickMs: ints.ALERT_TICK_MS,
    prodEvalMaxAgeHours: ints.PROD_EVAL_MAX_AGE_HOURS,
    maxAlertRules: ints.MAX_ALERT_RULES,
    rollupRetentionDays: ints.ROLLUP_RETENTION_DAYS,
    alertRetentionDays: ints.ALERT_RETENTION_DAYS,
    publicWebUrl: (env.PUBLIC_WEB_URL || '').replace(/\/$/, ''),   // optional: lets alert notifications link back to the website
    version: env.APP_VERSION || '0.6.0',
  });
}
