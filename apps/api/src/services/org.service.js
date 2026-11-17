// Organization settings, members, invitations, admin-issued password resets, audit viewer, demo-data cleanup.
// Rules: only admins manage people; admins may only manage roles BELOW admin; only owners touch admins/owners; nobody edits themselves here.
import crypto from 'node:crypto';
import { AppError } from '../middleware/errors.js';
import { check, parseLimit, queryString } from '../lib/validate.js';
import { isId } from '../lib/ids.js';
import { requirePermission, ROLES } from '../lib/rbac.js';
import { sha256Hex } from '../lib/crypto.js';

const DAY = 86_400_000, MIN = 60_000;
const rank = (r) => ROLES.indexOf(r);
const MAX_PENDING_INVITES = 200;

export function createOrgService({ repos, config, audit, now = () => new Date() }) {
  const org = async (principal) => {
    const o = await repos.orgs.get(principal.organizationId);
    if (!o) throw new AppError(404, 'ORG_NOT_FOUND', 'Organization not found');
    return o;
  };
  // May `actor` assign/modify/remove `targetRole`? Admins: viewer & member only. Owners: anyone.
  const mayManage = (actorRole, targetRole) => actorRole === 'owner' || (actorRole === 'admin' && rank(targetRole) < rank('admin'));
  const token = (prefix) => `${prefix}${crypto.randomBytes(32).toString('base64url')}`;

  return {
    async get(principal) {
      requirePermission(principal, 'agents:read');
      const o = await org(principal);
      return { id: o.id, name: o.name, role: principal.role, settings: { traceRetentionDays: o.settings?.traceRetentionDays ?? config.traceRetentionDays }, memberCount: o.members.length };
    },

    async update(principal, body) {
      requirePermission(principal, 'settings:manage');
      const c = check();
      const patch = {};
      if (body?.name !== undefined) patch.name = c.str(body.name, 'name', { max: 100 });
      if (body?.settings?.traceRetentionDays !== undefined) {
        const d = body.settings.traceRetentionDays;
        if (!Number.isInteger(d) || d < 1 || d > 3650) c.fail('settings.traceRetentionDays', 'must be a whole number of days from 1 to 3650');
        else patch.settings = { traceRetentionDays: d };
      }
      if (!Object.keys(patch).length && !c.errors?.length) c.fail('body', 'nothing to update (send name and/or settings.traceRetentionDays)');
      c.done();
      const o = await repos.orgs.update(principal.organizationId, patch);
      await audit.log({ organizationId: o.id, actorId: principal.userId, action: 'org.update', meta: { fields: Object.keys(patch), ...(patch.settings && { traceRetentionDays: patch.settings.traceRetentionDays }) } });
      return { id: o.id, name: o.name, settings: { traceRetentionDays: o.settings?.traceRetentionDays ?? config.traceRetentionDays }, note: 'The retention period applies to traces ingested from now on; traces already stored keep the expiry they were given.' };
    },

    // ---------- members ----------
    async listMembers(principal) {
      requirePermission(principal, 'members:manage');
      const o = await org(principal);
      const users = await repos.users.findByIds(o.members.map((m) => m.userId));
      return { items: o.members.map((m) => { const u = users.find((x) => x.id === m.userId); return { userId: m.userId, email: u?.email, name: u?.name, role: m.role, isYou: m.userId === principal.userId }; }) };
    },
    async changeRole(principal, userId, body) {
      requirePermission(principal, 'members:manage');
      const c = check(); const role = c.oneOf(body?.role, 'role', ROLES); c.done();
      const o = await org(principal);
      const target = isId(userId) ? o.members.find((m) => m.userId === userId) : null;
      if (!target) throw new AppError(404, 'MEMBER_NOT_FOUND', 'Member not found');
      if (userId === principal.userId) throw new AppError(409, 'CANNOT_EDIT_SELF', 'You cannot change your own role');
      if (!mayManage(principal.role, target.role) || !mayManage(principal.role, role)) throw new AppError(403, 'FORBIDDEN', 'You do not have permission to assign this role');
      await repos.orgs.setMemberRole(o.id, userId, role);
      await audit.log({ organizationId: o.id, actorId: principal.userId, action: 'member.role_changed', target: userId, meta: { from: target.role, to: role } });
      return { userId, role };
    },
    async removeMember(principal, userId) {
      requirePermission(principal, 'members:manage');
      const o = await org(principal);
      const target = isId(userId) ? o.members.find((m) => m.userId === userId) : null;
      if (!target) throw new AppError(404, 'MEMBER_NOT_FOUND', 'Member not found');
      if (userId === principal.userId) throw new AppError(409, 'CANNOT_EDIT_SELF', 'You cannot remove yourself');
      if (!mayManage(principal.role, target.role)) throw new AppError(403, 'FORBIDDEN', 'You do not have permission to remove this member');
      if (target.role === 'owner' && o.members.filter((m) => m.role === 'owner').length < 2) throw new AppError(409, 'LAST_OWNER', 'An organization must keep at least one owner');
      await repos.orgs.removeMember(o.id, userId);
      await audit.log({ organizationId: o.id, actorId: principal.userId, action: 'member.removed', target: userId, meta: { role: target.role } });
    },

    // ---------- invitations (no e-mail needed: the admin passes the one-time link on) ----------
    async invite(principal, body) {
      requirePermission(principal, 'members:manage');
      const c = check(); const email = c.email(body?.email, 'email'); const role = c.oneOf(body?.role, 'role', ROLES, { optional: true, fallback: 'member' }); c.done();
      if (!mayManage(principal.role, role)) throw new AppError(403, 'FORBIDDEN', 'You do not have permission to invite with this role');
      const o = await org(principal);
      const existing = await repos.users.findByEmail(email);
      if (existing && o.members.some((m) => m.userId === existing.id)) throw new AppError(409, 'ALREADY_MEMBER', 'This person is already a member');
      const pending = await repos.tokens.listPending(o.id, 'invite', now());
      if (pending.length >= MAX_PENDING_INVITES) throw new AppError(409, 'TOO_MANY_INVITATIONS', 'Too many pending invitations; revoke some first');
      if (pending.some((p) => p.email === email)) throw new AppError(409, 'INVITATION_EXISTS', 'There is already a pending invitation for this email; revoke it to issue a new one');
      const raw = token('ae_inv_');
      const row = await repos.tokens.create(o.id, { purpose: 'invite', tokenHash: sha256Hex(raw), email, role, createdBy: principal.userId, expiresAt: new Date(now().getTime() + config.inviteTtlDays * DAY) });
      await audit.log({ organizationId: o.id, actorId: principal.userId, action: 'invitation.created', target: row.id, meta: { role } });
      return { id: row.id, email, role, expiresAt: row.expiresAt, token: raw, acceptPath: `#/invite?token=${raw}`, note: 'Share this link with the person now. It is shown only once and works once.' };
    },
    async listInvitations(principal) {
      requirePermission(principal, 'members:manage');
      const rows = await repos.tokens.listPending(principal.organizationId, 'invite', now());
      return { items: rows.map(({ id, email, role, expiresAt, createdAt }) => ({ id, email, role, expiresAt, createdAt })) };
    },
    async revokeInvitation(principal, id) {
      requirePermission(principal, 'members:manage');
      const r = isId(id) ? await repos.tokens.revoke(principal.organizationId, id, now()) : null;
      if (!r || r.purpose !== 'invite') throw new AppError(404, 'INVITATION_NOT_FOUND', 'Invitation not found');
      await audit.log({ organizationId: principal.organizationId, actorId: principal.userId, action: 'invitation.revoked', target: id });
    },

    // ---------- password reset issued by an admin ----------
    async issuePasswordReset(principal, userId) {
      requirePermission(principal, 'members:manage');
      const o = await org(principal);
      const target = isId(userId) ? o.members.find((m) => m.userId === userId) : null;
      if (!target) throw new AppError(404, 'MEMBER_NOT_FOUND', 'Member not found');
      if (userId === principal.userId) throw new AppError(409, 'CANNOT_EDIT_SELF', 'Use "change password" for your own account');
      if (!mayManage(principal.role, target.role)) throw new AppError(403, 'FORBIDDEN', 'You do not have permission to reset this member\'s password');
      const raw = token('ae_rst_');
      const row = await repos.tokens.create(o.id, { purpose: 'reset', tokenHash: sha256Hex(raw), userId, createdBy: principal.userId, expiresAt: new Date(now().getTime() + config.resetTtlMinutes * MIN) });
      await audit.log({ organizationId: o.id, actorId: principal.userId, action: 'password_reset.issued', target: userId });
      return { token: raw, resetPath: `#/reset?token=${raw}`, expiresAt: row.expiresAt, note: 'Give this link to the member. It is shown only once, works once, and signs them out everywhere when used.' };
    },

    // ---------- audit log ----------
    async audit(principal, query = {}) {
      requirePermission(principal, 'audit:read');
      const action = queryString(query, 'action');
      if (action && !/^[a-z_.-]{1,60}$/.test(action)) throw new AppError(400, 'INVALID_QUERY', 'action is not valid');
      const cursorId = queryString(query, 'cursor');
      if (cursorId && !isId(cursorId)) throw new AppError(400, 'INVALID_CURSOR', 'cursor is not valid');
      const { items, hasMore } = await repos.audit.list(principal.organizationId, { action, cursorId, limit: parseLimit(query.limit, { def: 50, max: 100 }) });
      const users = await repos.users.findByIds([...new Set(items.map((e) => e.actorId).filter(Boolean).map(String))]);
      return { items: items.map((e) => ({ id: e.id, at: e.createdAt, action: e.action, actorId: e.actorId ?? null, actorEmail: users.find((u) => u.id === String(e.actorId))?.email ?? null, target: e.target ?? null, ip: e.ip ?? null, meta: e.meta ?? null })), nextCursor: hasMore ? items.at(-1).id : null };
    },

    // ---------- cleanup ----------
    async deleteDemoData(principal, body) {
      requirePermission(principal, 'settings:manage');
      if (body?.confirm !== 'DELETE_DEMO_DATA') throw new AppError(422, 'VALIDATION_ERROR', 'Confirmation required', [{ path: 'confirm', message: 'must be the text DELETE_DEMO_DATA' }]);
      const traces = await repos.traces.deleteDemo(principal.organizationId);
      const rollups = await repos.rollups.deleteDemo(principal.organizationId);
      await audit.log({ organizationId: principal.organizationId, actorId: principal.userId, action: 'demo_data.deleted', meta: { traces, rollups } });
      return { deletedTraces: traces, deletedRollups: rollups };
    },
  };
}
