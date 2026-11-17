// Failure of something we call (agent endpoint, evaluation engine). `retryable` tells the job queue whether trying again can help.
export class UpstreamError extends Error {
  constructor(message, { retryable = false, status } = {}) {
    super(message);
    this.name = 'UpstreamError';
    this.retryable = retryable;
    this.status = status;
  }
}
