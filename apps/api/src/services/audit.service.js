// Audit entries must never contain secrets or payloads: only ids, action names and small metadata.
export function createAuditService({ repos, logger = console }) {
  return {
    async log(entry) {
      try { await repos.audit.append({ ...entry, createdAt: new Date() }); }
      catch (e) { logger.error(JSON.stringify({ level: 'error', msg: 'audit write failed', error: e.message })); }
    },
  };
}
