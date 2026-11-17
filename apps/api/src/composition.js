import { createAuditService } from './services/audit.service.js';
import { createAuthService } from './services/auth.service.js';
import { createApiKeyService } from './services/apiKeys.service.js';
import { createAgentService } from './services/agents.service.js';
import { createTraceService } from './services/traces.service.js';
import { createTestSuiteService } from './services/testSuites.service.js';
import { createEvaluatorConfigService } from './services/evaluatorConfig.service.js';
import { createEvaluationService } from './services/evaluations.service.js';
import { createEvaluationExecutor } from './services/evaluationExecutor.js';
import { createAnalyticsService } from './services/analytics.service.js';
import { createDebugService } from './services/debug.service.js';
import { createOrgService } from './services/org.service.js';
import { createMonitoringService } from './services/monitoring.service.js';
import { createAlertsService } from './services/alerts.service.js';
import { createAlertEngine } from './services/alertEngine.js';
import { createAlertNotifier } from './services/alertNotifier.js';
import { createProductionEvaluator } from './services/productionEvaluator.js';
import { createJobRouter } from './services/jobRouter.js';
import { createWorkerLoop } from './services/workerLoop.js';
import { createSecretBox } from './lib/secretbox.js';
import { createEngineClient } from './lib/engineClient.js';

export function buildServices({ repos, config, deps = {} }) {
  const audit = createAuditService({ repos });
  const secrets = createSecretBox(config.encryptionKey);
  const engine = deps.engine ?? createEngineClient({ url: config.engineUrl, token: config.engineToken, timeoutMs: config.engineTimeoutMs });
  const evaluatorConfig = createEvaluatorConfigService({ repos, config, audit, secrets, deps });
  const evaluations = createEvaluationService({ repos, config, audit, evaluatorConfig, now: deps.now });
  const monitoring = createMonitoringService({ repos, config, audit, now: deps.now, logger: deps.logger });
  const alertEngine = createAlertEngine({ repos, config, now: deps.now, logger: deps.logger });
  return {
    audit, secrets, engine, evaluatorConfig, evaluations, monitoring, alertEngine,
    org: createOrgService({ repos, config, audit, now: deps.now }),
    alerts: createAlertsService({ repos, config, audit, secrets, engine: alertEngine, deps, now: deps.now }),
    analytics: createAnalyticsService({ repos, now: deps.now }),
    debug: createDebugService({ repos, engine }),
    auth: createAuthService({ repos, config, audit, now: deps.now }),
    apiKeys: createApiKeyService({ repos, audit }),
    agents: createAgentService({ repos, config, audit, secrets, deps }),
    traces: createTraceService({ repos, config, evaluations, monitoring, now: deps.now }),
    suites: createTestSuiteService({ repos, audit }),
  };
}

// The background worker: queue consumer + executor. `deps.engine` / `deps.http` / `deps.now` can be replaced in tests.
export function buildWorker({ repos, config, deps = {}, services }) {
  const svc = services ?? buildServices({ repos, config, deps });
  const engine = deps.engine ?? svc.engine;
  const executor = createEvaluationExecutor({ repos, config, engine, evaluatorConfig: svc.evaluatorConfig, secrets: svc.secrets, now: deps.now, http: deps.http });
  const production = createProductionEvaluator({ repos, config, engine, evaluatorConfig: svc.evaluatorConfig, now: deps.now });
  const notifier = createAlertNotifier({ repos, config, secrets: svc.secrets, now: deps.now, http: deps.http, logger: deps.logger });
  const router = createJobRouter({ executor, production, notifier });
  const loop = createWorkerLoop({ repos, executor: router, config, scheduler: svc.alertEngine, now: deps.now, logger: deps.logger });
  return { executor, production, notifier, loop, services: svc };
}
