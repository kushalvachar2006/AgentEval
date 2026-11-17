// Accounts and sessions.
//  * access token  = short-lived HS256 JWT carrying the session id (sid); checked against the session on EVERY request, so revocation is immediate
//  * refresh token = opaque random string, stored only as a hash, rotated on every use; presenting an already-used one revokes the user's sessions (theft signal)
//  * brute force   = per-account throttle (counted for every email, existing or not) on top of the per-IP rate limit
import crypto from 'node:crypto';
import { AppError } from '../middleware/errors.js';
import { check } from '../lib/validate.js';
import { isId } from '../lib/ids.js';
import { hashPassword, verifyPassword, dummyVerify, sha256Hex } from '../lib/crypto.js';
import { signJwt, verifyJwt } from '../lib/jwt.js';

const publicUser = (u) => ({ id: u.id, email: u.email, name: u.name });
const publicOrg = (o, userId) => ({ id: o.id, name: o.name, role: o.members.find((m) => m.userId === userId)?.role });
const DAY = 86_400_000, MIN = 60_000;
export const REFRESH_PREFIX = 'ae_rt_';

export function validatePassword(c, pw, path = 'password') {
  if (typeof pw !== 'string' || pw.length < 10 || pw.length > 128) c.fail(path, 'must be 10-128 characters');
}

export function createAuthService({ repos, config, audit, now = () => new Date() }) {
  const throttleOf = (email) => ({ key: sha256Hex(`login:${email}`), max: config.loginMaxFailures, windowMs: config.loginWindowMinutes * MIN, lockMs: config.loginLockMinutes * MIN });

  async function startSession(user, ctx = {}) {
    const refresh = `${REFRESH_PREFIX}${crypto.randomBytes(32).toString('base64url')}`;
    const at = now();
    const session = await repos.sessions.create({ userId: user.id, refreshHash: sha256Hex(refresh), userAgent: typeof ctx.userAgent === 'string' ? ctx.userAgent.slice(0, 120) : undefined, ip: ctx.ip, lastUsedAt: at, expiresAt: new Date(at.getTime() + config.refreshTtlDays * DAY) });
    return { session, refresh };
  }
  const accessToken = (user, session) => signJwt({ sub: user.id, sid: session.id }, { secret: config.jwtSecret, ttlSeconds: config.jwtTtlSeconds, now: () => now().getTime() });
  const bundle = async (user, orgs, ctx) => { const { session, refresh } = await startSession(user, ctx); return { token: accessToken(user, session), refreshToken: refresh, expiresInSeconds: config.jwtTtlSeconds, user: publicUser(user), organizations: orgs.map((o) => publicOrg(o, user.id)) }; };

  return {
    async register(body, ctx = {}) {
      const c = check();
      const email = c.email(body?.email, 'email');
      const name = c.str(body?.name, 'name', { max: 100 });
      const orgName = c.str(body?.organizationName, 'organizationName', { max: 100 });
      validatePassword(c, body?.password);
      c.done();
      if (!config.allowRegistration && (await repos.users.count()) > 0) throw new AppError(403, 'REGISTRATION_DISABLED', 'Sign-up is closed on this server. Ask an administrator for an invitation.');
      if (await repos.users.findByEmail(email)) throw new AppError(409, 'EMAIL_IN_USE', 'An account with this email already exists');
      const user = await repos.users.create({ email, name, passwordHash: await hashPassword(body.password) });
      const org = await repos.orgs.create({ name: orgName, members: [{ userId: user.id, role: 'owner' }], settings: { traceRetentionDays: config.traceRetentionDays } });
      await audit.log({ organizationId: org.id, actorId: user.id, action: 'user.register', ip: ctx.ip });
      return bundle(user, [org], ctx);
    },

    async login(body, ctx = {}) {
      const c = check();
      const email = c.email(body?.email, 'email');
      if (typeof body?.password !== 'string' || !body.password) c.fail('password', 'is required');
      c.done();
      const t = throttleOf(email);
      const at = now();
      const th = await repos.throttle.get(t.key);
      if (th?.lockedUntil && new Date(th.lockedUntil) > at) {
        await dummyVerify(body.password);   // same cost as a real attempt
        throw new AppError(429, 'TOO_MANY_ATTEMPTS', 'Too many failed sign-in attempts. Try again later.', undefined, { retryAfterSeconds: Math.ceil((new Date(th.lockedUntil) - at) / 1000) });
      }
      const user = await repos.users.findByEmail(email);
      // Same work whether or not the account exists, and the same error message: no enumeration by timing or text.
      const ok = user && !user.disabled ? await verifyPassword(body.password, user.passwordHash) : await dummyVerify(body.password);
      if (!ok) {
        const after = await repos.throttle.fail(t.key, at, t);
        await audit.log({ action: 'user.login_failed', ip: ctx.ip, meta: { emailHash: sha256Hex(email).slice(0, 12), locked: Boolean(after.lockedUntil && new Date(after.lockedUntil) > at) } });
        throw new AppError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect');
      }
      await repos.throttle.clear(t.key);
      const orgs = await repos.orgs.listForUser(user.id);
      await audit.log({ actorId: user.id, action: 'user.login', ip: ctx.ip });
      return bundle(user, orgs, ctx);
    },

    async refresh(body, ctx = {}) {
      const rt = body?.refreshToken;
      const bad = () => new AppError(401, 'INVALID_REFRESH', 'Session expired. Sign in again.');
      if (typeof rt !== 'string' || !rt.startsWith(REFRESH_PREFIX) || rt.length > 200) throw bad();
      const hash = sha256Hex(rt), at = now();
      const s = await repos.sessions.findByRefreshHash(hash);
      if (!s) throw bad();
      if (s.refreshHash !== hash) {   // an already-rotated token is being replayed: the token was copied. End every session of this user.
        await repos.sessions.revokeAllForUser(s.userId, at);
        await audit.log({ actorId: s.userId, action: 'session.reuse_detected', ip: ctx.ip });
        throw bad();
      }
      if (s.revokedAt) throw bad();   // plain logout / revocation: refused, but not treated as an attack
      if (new Date(s.expiresAt) <= at) throw bad();
      const user = await repos.users.findById(s.userId);
      if (!user || user.disabled) throw bad();
      const next = `${REFRESH_PREFIX}${crypto.randomBytes(32).toString('base64url')}`;
      const rotated = await repos.sessions.rotate(s.id, hash, sha256Hex(next), at, new Date(at.getTime() + config.refreshTtlDays * DAY));
      if (!rotated) throw bad();   // lost a race with a parallel refresh of the same token
      return { token: accessToken(user, rotated), refreshToken: next, expiresInSeconds: config.jwtTtlSeconds };
    },

    async authenticateUser(token, orgHeader) {
      const payload = verifyJwt(token, { secret: config.jwtSecret, now: () => now().getTime() });
      const bad = () => new AppError(401, 'INVALID_TOKEN', 'Invalid or expired token');
      if (!isId(payload.sid) || !isId(payload.sub)) throw bad();
      const session = await repos.sessions.get(payload.sid);
      if (!session || session.revokedAt || session.userId !== payload.sub || new Date(session.expiresAt) <= now()) throw bad();
      const user = await repos.users.findById(payload.sub);
      if (!user || user.disabled) throw bad();
      const orgs = await repos.orgs.listForUser(user.id);
      let org;
      if (orgHeader) {
        org = isId(orgHeader) ? orgs.find((o) => o.id === orgHeader) : undefined;
        if (!org) throw new AppError(403, 'FORBIDDEN_ORG', 'You are not a member of this organization');
      } else if (orgs.length === 0) throw new AppError(403, 'NO_ORGANIZATION', 'You are not a member of any organization');
      else if (orgs.length === 1) org = orgs[0];
      else throw new AppError(400, 'ORG_REQUIRED', 'Send the X-Organization-Id header');
      const role = org.members.find((m) => m.userId === user.id).role;
      return { type: 'user', userId: user.id, organizationId: org.id, role, sessionId: session.id };
    },

    async me(principal) {
      if (principal.type !== 'user') throw new AppError(403, 'FORBIDDEN', 'Only signed-in users can do this');
      const user = await repos.users.findById(principal.userId);
      const orgs = await repos.orgs.listForUser(principal.userId);
      return { user: publicUser(user), organizations: orgs.map((o) => publicOrg(o, user.id)), currentOrganizationId: principal.organizationId };
    },

    async logout(principal) {
      if (principal.type !== 'user') throw new AppError(403, 'FORBIDDEN', 'Only signed-in users can do this');
      await repos.sessions.revoke(principal.sessionId, now());
      await audit.log({ organizationId: principal.organizationId, actorId: principal.userId, action: 'user.logout' });
    },
    async logoutAll(principal) {
      if (principal.type !== 'user') throw new AppError(403, 'FORBIDDEN', 'Only signed-in users can do this');
      await repos.sessions.revokeAllForUser(principal.userId, now());
      await audit.log({ organizationId: principal.organizationId, actorId: principal.userId, action: 'user.logout_all' });
    },

    // Changing the password ends every session (including this one) and starts a fresh one.
    async changePassword(principal, body, ctx = {}) {
      if (principal.type !== 'user') throw new AppError(403, 'FORBIDDEN', 'Only signed-in users can do this');
      const c = check();
      if (typeof body?.currentPassword !== 'string' || !body.currentPassword) c.fail('currentPassword', 'is required');
      validatePassword(c, body?.newPassword, 'newPassword');
      c.done();
      const user = await repos.users.findById(principal.userId);
      const t = throttleOf(user.email);
      if (!(await verifyPassword(body.currentPassword, user.passwordHash))) {
        await repos.throttle.fail(t.key, now(), t);
        throw new AppError(401, 'INVALID_CREDENTIALS', 'Current password is incorrect');
      }
      const updated = await repos.users.update(user.id, { passwordHash: await hashPassword(body.newPassword) });
      await repos.sessions.revokeAllForUser(user.id, now());
      await audit.log({ organizationId: principal.organizationId, actorId: user.id, action: 'user.password_changed', ip: ctx.ip });
      return bundle(updated, await repos.orgs.listForUser(user.id), ctx);
    },

    // Public: finish an admin-issued password reset. The token is single use, expires, and ends all existing sessions.
    async completeReset(body, ctx = {}) {
      const c = check();
      const token = c.str(body?.token, 'token', { max: 200 });
      validatePassword(c, body?.newPassword, 'newPassword');
      c.done();
      const row = await repos.tokens.consume(sha256Hex(token), now());
      if (!row || row.purpose !== 'reset') throw new AppError(400, 'INVALID_TOKEN_LINK', 'This reset link is invalid, already used or expired');
      const user = await repos.users.update(row.userId, { passwordHash: await hashPassword(body.newPassword) });
      if (!user) throw new AppError(400, 'INVALID_TOKEN_LINK', 'This reset link is invalid, already used or expired');
      await repos.sessions.revokeAllForUser(user.id, now());
      await repos.throttle.clear(throttleOf(user.email).key);
      await audit.log({ organizationId: row.organizationId, actorId: user.id, action: 'user.password_reset', ip: ctx.ip });
    },

    // Public: accept an invitation by creating a NEW account (the invited email must not have one yet).
    async acceptInvitation(body, ctx = {}) {
      const c = check();
      const token = c.str(body?.token, 'token', { max: 200 });
      const name = c.str(body?.name, 'name', { max: 100 });
      validatePassword(c, body?.password);
      c.done();
      const hash = sha256Hex(token), at = now();
      const peek = await repos.tokens.findByHash(hash);
      const bad = () => new AppError(400, 'INVALID_TOKEN_LINK', 'This invitation is invalid, already used or expired');
      if (!peek || peek.purpose !== 'invite' || peek.usedAt || peek.revokedAt || new Date(peek.expiresAt) <= at) throw bad();
      if (await repos.users.findByEmail(peek.email)) throw new AppError(409, 'ACCOUNT_EXISTS', 'An account with this email already exists. Sign in, then accept the invitation from your account.');
      const row = await repos.tokens.consume(hash, at);
      if (!row) throw bad();
      const user = await repos.users.create({ email: row.email, name, passwordHash: await hashPassword(body.password) });
      await repos.orgs.addMember(row.organizationId, user.id, row.role);
      await audit.log({ organizationId: row.organizationId, actorId: user.id, action: 'invitation.accepted', target: row.id, ip: ctx.ip, meta: { role: row.role } });
      return bundle(user, await repos.orgs.listForUser(user.id), ctx);
    },

    // Signed-in user with an existing account accepts an invitation addressed to their email.
    async acceptInvitationAsUser(principal, body) {
      if (principal.type !== 'user') throw new AppError(403, 'FORBIDDEN', 'Only signed-in users can do this');
      const c = check();
      const token = c.str(body?.token, 'token', { max: 200 });
      c.done();
      const hash = sha256Hex(token), at = now();
      const bad = () => new AppError(400, 'INVALID_TOKEN_LINK', 'This invitation is invalid, already used or expired');
      const peek = await repos.tokens.findByHash(hash);
      if (!peek || peek.purpose !== 'invite' || peek.usedAt || peek.revokedAt || new Date(peek.expiresAt) <= at) throw bad();
      const user = await repos.users.findById(principal.userId);
      if (user.email !== peek.email) throw new AppError(403, 'INVITATION_EMAIL_MISMATCH', 'This invitation was sent to a different email address');
      const org = await repos.orgs.get(peek.organizationId);
      if (org?.members.some((m) => m.userId === user.id)) throw new AppError(409, 'ALREADY_MEMBER', 'You are already a member of this organization');
      const row = await repos.tokens.consume(hash, at);
      if (!row) throw bad();
      await repos.orgs.addMember(row.organizationId, user.id, row.role);
      await audit.log({ organizationId: row.organizationId, actorId: user.id, action: 'invitation.accepted', target: row.id, meta: { role: row.role } });
      return { organizationId: row.organizationId, role: row.role };
    },
  };
}
