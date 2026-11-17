import { AppError } from '../middleware/errors.js';

export const ROLES = ['viewer', 'member', 'admin', 'owner'];
const VIEWER = ['agents:read', 'traces:read', 'suites:read', 'evaluations:read', 'alerts:read'];
const MEMBER = [...VIEWER, 'agents:write', 'traces:write', 'suites:write', 'evaluations:write', 'alerts:ack'];
const ADMIN = [...MEMBER, 'agents:delete', 'keys:manage', 'settings:manage', 'alerts:manage', 'members:manage', 'audit:read'];
const ROLE_PERMISSIONS = { viewer: VIEWER, member: MEMBER, admin: ADMIN, owner: [...ADMIN, 'org:manage'] };

// API keys can only ever hold these scopes (they can never manage keys or read traces back).
export const KEY_SCOPES = ['traces:write', 'agents:read', 'agents:write', 'evaluations:run'];

export function can(principal, permission) {
  if (!principal) return false;
  if (principal.type === 'apiKey') return principal.scopes.includes(permission);
  return (ROLE_PERMISSIONS[principal.role] ?? []).includes(permission);
}

export function requirePermission(principal, permission) {
  if (!can(principal, permission)) throw new AppError(403, 'FORBIDDEN', 'You do not have permission to do this');
}
