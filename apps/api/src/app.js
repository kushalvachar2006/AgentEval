import crypto from 'node:crypto';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { healthRouter } from './modules/health/health.routes.js';
import { errorHandler, notFound, sendError } from './middleware/errors.js';
import { createAuthMiddleware } from './middleware/auth.js';
import { buildRouter } from './routes/index.js';

// `checks` and `services` are injected so the app is testable without live services.
export function createApp({ config, checks = {}, services }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);

  app.use((req, res, next) => {
    req.id = req.get('x-request-id')?.slice(0, 64) || crypto.randomUUID();
    res.set('x-request-id', req.id);
    next();
  });
  app.use(helmet());
  app.use(cors({
    origin: (origin, cb) => cb(null, !origin || config.corsOrigins.includes(origin)),
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
  }));
  app.use(rateLimit({
    windowMs: config.rateLimitWindowMs,
    limit: config.rateLimitMax,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (_req, res) => sendError(res, 429, 'RATE_LIMITED', 'Too many requests, slow down'),
  }));

  app.use('/api/v1/health', healthRouter({ config, checks }));
  if (services) {
    const auth = createAuthMiddleware({ authService: services.auth, apiKeyService: services.apiKeys });
    app.use('/api/v1', buildRouter({ services, auth, config }));
  }

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
