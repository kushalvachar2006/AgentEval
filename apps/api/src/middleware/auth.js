import { AppError } from './errors.js';

// Accepts either a user JWT (Authorization: Bearer <jwt>) or an API key (Bearer ae_live_... or X-API-Key).
// The organization is ALWAYS derived server-side: from the key, or from verified membership - never trusted from the client.
export function createAuthMiddleware({ authService, apiKeyService }) {
  return async (req, _res, next) => {
    try {
      const m = /^Bearer\s+(\S+)$/i.exec(req.get('authorization') || '');
      const token = m ? m[1] : req.get('x-api-key');
      if (!token) throw new AppError(401, 'UNAUTHENTICATED', 'Authentication required');
      req.principal = token.startsWith('ae_')
        ? await apiKeyService.authenticate(token)
        : await authService.authenticateUser(token, req.get('x-organization-id'));
      next();
    } catch (e) { next(e); }
  };
}
