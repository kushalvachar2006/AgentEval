export class AppError extends Error {
  constructor(status, code, message, details, { retryAfterSeconds } = {}) {
    super(message);
    this.retryAfterSeconds = retryAfterSeconds;
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const sendError = (res, status, code, message, details) =>
  res.status(status).json({ error: { code, message, requestId: res.req?.id, ...(details ? { details } : {}) } });

export const notFound = (_req, res) => sendError(res, 404, 'NOT_FOUND', 'Route not found');

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, _next) {
  if (err instanceof AppError) {
    if (err.retryAfterSeconds) res.set('Retry-After', String(err.retryAfterSeconds));
    return sendError(res, err.status, err.code, err.message, err.details);
  }
  if (err?.type === 'entity.too.large') return sendError(res, 413, 'PAYLOAD_TOO_LARGE', 'Request body is too large');
  if (err instanceof SyntaxError && err.status === 400) return sendError(res, 400, 'INVALID_JSON', 'Request body is not valid JSON');
  // Log only metadata; never the request body (may hold customer data or secrets).
  console.error(JSON.stringify({ level: 'error', requestId: req.id, name: err?.name, message: err?.message }));
  return sendError(res, 500, 'INTERNAL_ERROR', 'Unexpected server error');
}
