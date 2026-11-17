// Milestone 6: sessions and refresh, brute-force lockout, password change/reset, invitations, members, org settings, audit, demo cleanup.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld, fakeEngine } from '../helpers/world.js';
import { signJwt } from '../../src/lib/jwt.js';

const MIN = 60_000;
function setup(env = {}) {
  const clock = { t: new Date('2026-11-14T10:00:00.000Z') };
  const w = makeWorld(env, { now: () => clock.t, engine: fakeEngine(), logger: { error: () => {}, log: () => {} } });
  const advance = (m) => { clock.t = new Date(clock.t.getTime() + m * MIN); };
  const login = (email, password = 'correct-horse-1') => w.services.auth.login({ email, password });
  return { w, clock, advance, login, auth: w.services.auth, org: w.services.org, repos: w.repos };
}
const code = (p) => p.then(() => null, (e) => e.code ?? e.message);
const AS = (principal, role) => ({ ...principal, role });
// Adds an extra member to an owner's organization the supported way: invitation -> accept.
async function addMember(s, owner, email, role = 'member') {
  const inv = await s.org.invite(owner.principal, { email, role });
  const r = await s.auth.acceptInvitation({ token: inv.token, name: email.split('@')[0], password: 'correct-horse-1' });
  return { ...r, principal: await s.auth.authenticateUser(r.token) };
}

// ---------------- sessions ----------------
test('register/login return an access token AND a refresh token; the access token is bound to a live session', async () => {
  const s = setup(); const A = await s.w.signup('a');
  assert.match(A.refreshToken, /^ae_rt_[A-Za-z0-9_-]{43}$/);
  assert.equal(A.expiresInSeconds, 900);
  assert.equal(A.principal.type, 'user');
  assert.ok(A.principal.sessionId);
  assert.ok(!JSON.stringify(s.repos._db.sessions).includes(A.refreshToken));                    // only the hash is stored
  const L = await s.login(A.email);
  assert.notEqual(L.refreshToken, A.refreshToken);
  assert.equal(s.repos._db.sessions.length, 2);
});

test('access tokens expire quickly; the refresh token renews them and is rotated on every use', async () => {
  const s = setup(); const A = await s.w.signup('a');
  s.advance(16);
  assert.equal(await code(s.auth.authenticateUser(A.token)), 'INVALID_TOKEN');
  const r1 = await s.auth.refresh({ refreshToken: A.refreshToken });
  assert.notEqual(r1.refreshToken, A.refreshToken);
  assert.equal((await s.auth.authenticateUser(r1.token)).userId, A.principal.userId);
  const r2 = await s.auth.refresh({ refreshToken: r1.refreshToken });
  assert.notEqual(r2.refreshToken, r1.refreshToken);
  for (const bad of [undefined, '', 'nope', 'ae_rt_' + 'x'.repeat(43), { $ne: 1 }, 'ae_rt_' + 'a'.repeat(500)]) assert.equal(await code(s.auth.refresh({ refreshToken: bad })), 'INVALID_REFRESH', String(bad));
  assert.equal(await code(s.auth.refresh(null)), 'INVALID_REFRESH');
});

test('replaying a rotated-away refresh token ends ALL of that user\'s sessions (theft signal) and is audited', async () => {
  const s = setup(); const A = await s.w.signup('a');
  const second = await s.login(A.email);
  const r1 = await s.auth.refresh({ refreshToken: A.refreshToken });                              // legitimate rotation
  assert.equal(await code(s.auth.refresh({ refreshToken: A.refreshToken })), 'INVALID_REFRESH');  // attacker replays the old one
  assert.equal(await code(s.auth.authenticateUser(r1.token)), 'INVALID_TOKEN');                  // the new session is dead too
  assert.equal(await code(s.auth.authenticateUser(second.token)), 'INVALID_TOKEN');              // ... and the other device
  assert.ok(s.repos._db.audit.some((e) => e.action === 'session.reuse_detected'));
});

test('parallel refresh of the same token: exactly one wins', async () => {
  const s = setup(); const A = await s.w.signup('a');
  const res = await Promise.allSettled([s.auth.refresh({ refreshToken: A.refreshToken }), s.auth.refresh({ refreshToken: A.refreshToken })]);
  assert.equal(res.filter((r) => r.status === 'fulfilled').length, 1);
});

test('refresh tokens expire after REFRESH_TTL_DAYS; disabled users cannot refresh', async () => {
  const s = setup({ REFRESH_TTL_DAYS: '2' }); const A = await s.w.signup('a'); const B = await s.w.signup('b');
  await s.repos.users.update(B.principal.userId, { disabled: true });
  assert.equal(await code(s.auth.refresh({ refreshToken: B.refreshToken })), 'INVALID_REFRESH');
  assert.equal(await code(s.auth.authenticateUser(B.token)), 'INVALID_TOKEN');
  s.advance(60 * 24 * 3);
  assert.equal(await code(s.auth.refresh({ refreshToken: A.refreshToken })), 'INVALID_REFRESH');
});

test('logout revokes immediately; logout-all revokes every device; a JWT without a session id is rejected', async () => {
  const s = setup(); const A = await s.w.signup('a'); const B = await s.login(A.email);
  const pB = await s.auth.authenticateUser(B.token);
  await s.auth.logout(pB);
  assert.equal(await code(s.auth.authenticateUser(B.token)), 'INVALID_TOKEN');
  assert.equal(await code(s.auth.refresh({ refreshToken: B.refreshToken })), 'INVALID_REFRESH');
  assert.equal((await s.auth.authenticateUser(A.token)).userId, A.principal.userId);              // other device unaffected
  await s.auth.logoutAll(A.principal);
  assert.equal(await code(s.auth.authenticateUser(A.token)), 'INVALID_TOKEN');
  const legacy = signJwt({ sub: A.principal.userId }, { secret: s.w.config.jwtSecret, ttlSeconds: 3600, now: () => s.clock.t.getTime() });   // old-style token (no sid)
  assert.equal(await code(s.auth.authenticateUser(legacy)), 'INVALID_TOKEN');
  const forged = signJwt({ sub: A.principal.userId, sid: '0'.repeat(24) }, { secret: s.w.config.jwtSecret, ttlSeconds: 3600, now: () => s.clock.t.getTime() });
  assert.equal(await code(s.auth.authenticateUser(forged)), 'INVALID_TOKEN');
  assert.equal(await code(s.auth.logout({ type: 'apiKey' })), 'FORBIDDEN');
});

// ---------------- brute force ----------------
test('lockout: 5 wrong passwords lock the ACCOUNT even from other IPs; the right password is refused while locked; it unlocks by itself', async () => {
  const s = setup(); const A = await s.w.signup('a');
  for (let i = 0; i < 4; i++) assert.equal(await code(s.auth.login({ email: A.email, password: 'wrong-password' }, { ip: `10.0.0.${i}` })), 'INVALID_CREDENTIALS');
  assert.equal(await code(s.auth.login({ email: A.email, password: 'wrong-password' }, { ip: '10.9.9.9' })), 'INVALID_CREDENTIALS');   // 5th failure
  const locked = await s.auth.login({ email: A.email, password: 'correct-horse-1' }).catch((e) => e);                                   // correct password, still refused
  assert.deepEqual([locked.status, locked.code], [429, 'TOO_MANY_ATTEMPTS']);
  assert.ok(locked.retryAfterSeconds > 0 && locked.retryAfterSeconds <= 900);
  s.advance(14); assert.equal(await code(s.login(A.email)), 'TOO_MANY_ATTEMPTS');
  s.advance(2); assert.ok((await s.login(A.email)).token);                                                                            // unlocked after 15 min
  assert.ok(s.repos._db.audit.some((e) => e.action === 'user.login_failed' && e.meta.locked));
});

test('lockout reveals nothing: unknown emails lock exactly like real ones, with the same responses', async () => {
  const s = setup(); const A = await s.w.signup('a');
  const trail = async (email) => { const out = []; for (let i = 0; i < 7; i++) out.push(await code(s.auth.login({ email, password: 'wrong-password-x' }))); return out; };
  assert.deepEqual(await trail('ghost@example.com'), await trail(A.email));
  assert.deepEqual((await trail('ghost2@example.com')).slice(4), ['INVALID_CREDENTIALS', 'TOO_MANY_ATTEMPTS', 'TOO_MANY_ATTEMPTS']);
});

test('a successful login clears the failure counter; failures older than the window do not count', async () => {
  const s = setup(); const A = await s.w.signup('a');
  for (let i = 0; i < 4; i++) await code(s.auth.login({ email: A.email, password: 'wrong-password' }));
  await s.login(A.email);                                                                         // success resets
  for (let i = 0; i < 4; i++) await code(s.auth.login({ email: A.email, password: 'wrong-password' }));
  assert.ok((await s.login(A.email)).token);                                                      // still not locked: 4 < 5
  for (let i = 0; i < 4; i++) await code(s.auth.login({ email: A.email, password: 'wrong-password' }));
  s.advance(16);                                                                                  // window expired
  await code(s.auth.login({ email: A.email, password: 'wrong-password' }));
  assert.ok((await s.login(A.email)).token);
});

// ---------------- password change / reset ----------------
test('change password: needs the current one, ends all other sessions, rejects weak passwords, counts failures toward lockout', async () => {
  const s = setup(); const A = await s.w.signup('a'); const other = await s.login(A.email);
  assert.equal(await code(s.auth.changePassword(A.principal, { currentPassword: 'wrong', newPassword: 'another-long-pass-1' })), 'INVALID_CREDENTIALS');
  assert.equal(await code(s.auth.changePassword(A.principal, { currentPassword: 'correct-horse-1', newPassword: 'short' })), 'VALIDATION_ERROR');
  const r = await s.auth.changePassword(A.principal, { currentPassword: 'correct-horse-1', newPassword: 'another-long-pass-1' });
  assert.equal(await code(s.auth.authenticateUser(A.token)), 'INVALID_TOKEN');
  assert.equal(await code(s.auth.authenticateUser(other.token)), 'INVALID_TOKEN');
  assert.ok((await s.auth.authenticateUser(r.token)).userId);                                     // the fresh session works
  assert.equal(await code(s.login(A.email)), 'INVALID_CREDENTIALS');
  assert.ok((await s.login(A.email, 'another-long-pass-1')).token);
  for (let i = 0; i < 5; i++) await code(s.auth.changePassword(await s.auth.authenticateUser(r.token), { currentPassword: 'guess-guess-1', newPassword: 'whatever-long-1' }));
  assert.equal(await code(s.login(A.email, 'another-long-pass-1')), 'TOO_MANY_ATTEMPTS');         // guessing via this endpoint cannot bypass the lockout
});

test('admin-issued reset: single use, expires, ends all sessions, respects roles and tenants', async () => {
  const s = setup(); const owner = await s.w.signup('owner'); const outsider = await s.w.signup('outsider');
  const member = await addMember(s, owner, 'm@example.com', 'member');
  const adminU = await addMember(s, owner, 'ad@example.com', 'admin');
  assert.equal(await code(s.org.issuePasswordReset(AS(member.principal, 'member'), owner.principal.userId)), 'FORBIDDEN');     // members cannot
  assert.equal(await code(s.org.issuePasswordReset(adminU.principal, owner.principal.userId)), 'FORBIDDEN');                  // admins cannot reset owners
  assert.equal(await code(s.org.issuePasswordReset(adminU.principal, adminU.principal.userId)), 'CANNOT_EDIT_SELF');
  assert.equal(await code(s.org.issuePasswordReset(owner.principal, outsider.principal.userId)), 'MEMBER_NOT_FOUND');         // another tenant's user
  const r = await s.org.issuePasswordReset(adminU.principal, member.principal.userId);
  assert.match(r.token, /^ae_rst_/); assert.ok(!JSON.stringify(s.repos._db.tokens).includes(r.token));
  assert.equal(await code(s.auth.completeReset({ token: r.token, newPassword: 'short' })), 'VALIDATION_ERROR');                // a failed attempt does not burn the link
  await s.auth.completeReset({ token: r.token, newPassword: 'brand-new-password-1' });
  assert.equal(await code(s.auth.completeReset({ token: r.token, newPassword: 'brand-new-password-2' })), 'INVALID_TOKEN_LINK');   // single use
  assert.equal(await code(s.auth.authenticateUser(member.token)), 'INVALID_TOKEN');
  assert.ok((await s.login('m@example.com', 'brand-new-password-1')).token);
  const late = await s.org.issuePasswordReset(owner.principal, member.principal.userId);
  s.advance(61);
  assert.equal(await code(s.auth.completeReset({ token: late.token, newPassword: 'brand-new-password-3' })), 'INVALID_TOKEN_LINK');   // expired
  assert.equal(await code(s.auth.completeReset({ token: 'ae_inv_garbage', newPassword: 'brand-new-password-3' })), 'INVALID_TOKEN_LINK');
  const inv = await s.org.invite(owner.principal, { email: 'x@example.com' });
  assert.equal(await code(s.auth.completeReset({ token: inv.token, newPassword: 'brand-new-password-3' })), 'INVALID_TOKEN_LINK');   // an invitation token is not a reset token
});

test('a reset also clears a lockout (the owner of the account got back in)', async () => {
  const s = setup(); const owner = await s.w.signup('owner'); const m = await addMember(s, owner, 'm@example.com');
  for (let i = 0; i < 5; i++) await code(s.auth.login({ email: 'm@example.com', password: 'nope-nope-nope' }));
  assert.equal(await code(s.login('m@example.com')), 'TOO_MANY_ATTEMPTS');
  const r = await s.org.issuePasswordReset(owner.principal, m.principal.userId);
  await s.auth.completeReset({ token: r.token, newPassword: 'brand-new-password-1' });
  assert.ok((await s.login('m@example.com', 'brand-new-password-1')).token);
});

// ---------------- invitations ----------------
test('invitations: token shown once, hashed at rest, role ceiling, duplicates, single use, expiry, revocation', async () => {
  const s = setup(); const owner = await s.w.signup('owner');
  const adminU = await addMember(s, owner, 'ad@example.com', 'admin');
  assert.equal(await code(s.org.invite(adminU.principal, { email: 'x@example.com', role: 'admin' })), 'FORBIDDEN');              // admins cannot mint admins
  assert.equal(await code(s.org.invite(adminU.principal, { email: 'x@example.com', role: 'owner' })), 'FORBIDDEN');
  assert.equal(await code(s.org.invite(AS(owner.principal, 'member'), { email: 'x@example.com' })), 'FORBIDDEN');
  assert.equal(await code(s.org.invite(owner.principal, { email: 'not-an-email' })), 'VALIDATION_ERROR');
  assert.equal(await code(s.org.invite(owner.principal, { email: 'ad@example.com' })), 'ALREADY_MEMBER');
  const inv = await s.org.invite(adminU.principal, { email: 'New@Example.com', role: 'viewer' });
  assert.equal(inv.email, 'new@example.com');
  assert.match(inv.acceptPath, /^#\/invite\?token=ae_inv_/);
  assert.ok(!JSON.stringify(s.repos._db.tokens).includes(inv.token));
  assert.equal(await code(s.org.invite(owner.principal, { email: 'new@example.com' })), 'INVITATION_EXISTS');
  const list = await s.org.listInvitations(owner.principal);
  assert.deepEqual(list.items.map((i) => [i.email, i.role]), [['new@example.com', 'viewer']]);
  assert.ok(!JSON.stringify(list).includes('ae_inv_') && !JSON.stringify(list).includes('tokenHash'));
  const joined = await s.auth.acceptInvitation({ token: inv.token, name: 'Newbie', password: 'correct-horse-1' });
  assert.equal(joined.organizations[0].role, 'viewer'); assert.equal(joined.organizations[0].id, owner.principal.organizationId);
  assert.equal(await code(s.auth.acceptInvitation({ token: inv.token, name: 'Again', password: 'correct-horse-1' })), 'INVALID_TOKEN_LINK');
  assert.equal((await s.org.listInvitations(owner.principal)).items.length, 0);
  const second = await s.org.invite(owner.principal, { email: 'later@example.com' });
  s.advance(60 * 24 * 8);
  assert.equal(await code(s.auth.acceptInvitation({ token: second.token, name: 'Late', password: 'correct-horse-1' })), 'INVALID_TOKEN_LINK');   // 7-day expiry
  const third = await s.org.invite(owner.principal, { email: 'third@example.com' });
  await s.org.revokeInvitation(owner.principal, third.id);
  assert.equal(await code(s.auth.acceptInvitation({ token: third.token, name: 'Rev', password: 'correct-horse-1' })), 'INVALID_TOKEN_LINK');
  assert.equal(await code(s.org.revokeInvitation(owner.principal, third.id)), 'INVITATION_NOT_FOUND');
  assert.equal(await code(s.auth.acceptInvitation({ token: 'ae_inv_nothing', name: 'x', password: 'correct-horse-1' })), 'INVALID_TOKEN_LINK');
});

test('invitations for an email that already has an account: do not burn the token; accepted only by that very user, once', async () => {
  const s = setup(); const A = await s.w.signup('a'); const B = await s.w.signup('b'); const C = await s.w.signup('c');
  const inv = await s.org.invite(A.principal, { email: B.email, role: 'member' });
  assert.equal(await code(s.auth.acceptInvitation({ token: inv.token, name: 'B', password: 'correct-horse-1' })), 'ACCOUNT_EXISTS');
  assert.equal(await code(s.auth.acceptInvitationAsUser(C.principal, { token: inv.token })), 'INVITATION_EMAIL_MISMATCH');          // someone else's link
  const ok = await s.auth.acceptInvitationAsUser(B.principal, { token: inv.token });
  assert.deepEqual(ok, { organizationId: A.principal.organizationId, role: 'member' });
  assert.equal((await s.repos.orgs.listForUser(B.principal.userId)).length, 2);
  assert.equal(await code(s.auth.acceptInvitationAsUser(B.principal, { token: inv.token })), 'INVALID_TOKEN_LINK');
  const again = await s.org.invite(A.principal, { email: 'zzz@example.com' });
  assert.equal(await code(s.org.revokeInvitation(B.principal, again.id)), 'INVITATION_NOT_FOUND');                                // another tenant cannot revoke
  assert.equal(await code(s.org.revokeInvitation(AS(A.principal, 'member'), again.id)), 'FORBIDDEN');
});

// ---------------- members ----------------
test('members: roles can only be changed within your authority; no self-edits; last owner is protected; removal is immediate', async () => {
  const s = setup(); const owner = await s.w.signup('owner'); const outsider = await s.w.signup('out');
  const adminU = await addMember(s, owner, 'ad@example.com', 'admin'); const m = await addMember(s, owner, 'm@example.com', 'member');
  const list = await s.org.listMembers(adminU.principal);
  assert.deepEqual(list.items.map((x) => x.role).sort(), ['admin', 'member', 'owner']);
  assert.ok(list.items.every((x) => x.email));
  assert.equal(await code(s.org.listMembers(m.principal)), 'FORBIDDEN');
  assert.equal(await code(s.org.changeRole(adminU.principal, m.principal.userId, { role: 'admin' })), 'FORBIDDEN');               // cannot promote to admin
  assert.equal(await code(s.org.changeRole(adminU.principal, owner.principal.userId, { role: 'viewer' })), 'FORBIDDEN');          // cannot demote the owner
  assert.equal(await code(s.org.changeRole(owner.principal, owner.principal.userId, { role: 'viewer' })), 'CANNOT_EDIT_SELF');
  assert.equal(await code(s.org.changeRole(owner.principal, m.principal.userId, { role: 'superuser' })), 'VALIDATION_ERROR');
  assert.equal(await code(s.org.changeRole(owner.principal, outsider.principal.userId, { role: 'viewer' })), 'MEMBER_NOT_FOUND');
  await s.org.changeRole(adminU.principal, m.principal.userId, { role: 'viewer' });
  assert.equal((await s.auth.authenticateUser(m.token)).role, 'viewer');                                                          // takes effect on the next request
  await s.org.changeRole(owner.principal, adminU.principal.userId, { role: 'owner' });
  assert.equal(await code(s.org.removeMember(owner.principal, owner.principal.userId)), 'CANNOT_EDIT_SELF');
  const newOwner = await s.auth.authenticateUser(adminU.token);
  await s.org.removeMember(newOwner, owner.principal.userId);                                                                      // two owners: removing one is fine
  assert.equal(await code(s.auth.authenticateUser(owner.token)), 'NO_ORGANIZATION');                                              // removed member is out at once
  const w2 = await s.org.listMembers(newOwner);
  assert.equal(w2.items.filter((x) => x.role === 'owner').length, 1);
});

test('the last owner cannot be removed or demoted by a sole remaining owner flow', async () => {
  const s = setup(); const owner = await s.w.signup('owner'); const adminU = await addMember(s, owner, 'ad@example.com', 'admin');
  assert.equal(await code(s.org.removeMember(adminU.principal, owner.principal.userId)), 'FORBIDDEN');                              // admins cannot touch owners
  await s.org.changeRole(owner.principal, adminU.principal.userId, { role: 'owner' });
  const second = await s.auth.authenticateUser(adminU.token);
  await s.org.removeMember(second, owner.principal.userId);
  assert.equal(await code(s.org.removeMember(second, second.userId)), 'CANNOT_EDIT_SELF');                                         // nobody can orphan the organization
});

// ---------------- org settings, retention, audit, demo data ----------------
test('organization settings: admin-only, validated, audited; retention drives the expiry of newly ingested traces', async () => {
  const s = setup(); const owner = await s.w.signup('owner'); const agent = await s.w.newAgent(owner.principal);
  const viewer = await addMember(s, owner, 'v@example.com', 'viewer');
  assert.equal((await s.org.get(viewer.principal)).settings.traceRetentionDays, 90);
  assert.equal(await code(s.org.update(viewer.principal, { name: 'x' })), 'FORBIDDEN');
  assert.equal(await code(s.org.update(owner.principal, {})), 'VALIDATION_ERROR');
  for (const bad of [0, -3, 3651, 1.5, '30']) assert.equal(await code(s.org.update(owner.principal, { settings: { traceRetentionDays: bad } })), 'VALIDATION_ERROR', String(bad));
  assert.equal(await code(s.org.update(owner.principal, { name: '   ' })), 'VALIDATION_ERROR');
  const t1 = s.w.traceFor(agent.id); await s.w.services.traces.ingestOne(owner.principal, t1);
  const days = async (id) => Math.round((new Date((await s.repos.traces.get(owner.principal.organizationId, id)).expiresAt) - s.clock.t) / 86_400_000);
  assert.equal(await days(t1.traceId), 90);
  const upd = await s.org.update(owner.principal, { name: 'Renamed', settings: { traceRetentionDays: 7 } });
  assert.equal(upd.name, 'Renamed'); assert.match(upd.note, /from now on/);
  s.advance(1);                                                                                   // retention lookups are cached for 30 s
  const t2 = s.w.traceFor(agent.id); await s.w.services.traces.ingestOne(owner.principal, t2);
  assert.equal(await days(t2.traceId), 7);
  assert.equal(await days(t1.traceId), 90);                                                       // existing traces keep their expiry (documented)
  assert.ok(s.repos._db.audit.some((e) => e.action === 'org.update' && e.meta.traceRetentionDays === 7));
});

test('audit viewer: admins only, tenant-scoped, filterable, paginated, resolves actors, never exposes secrets', async () => {
  const s = setup(); const A = await s.w.signup('a'); const B = await s.w.signup('b');
  const inv = await s.org.invite(A.principal, { email: 'x@example.com' });
  await s.org.invite(B.principal, { email: 'other-tenant@example.com' });
  const m = await addMember(s, A, 'm@example.com');
  await s.org.issuePasswordReset(A.principal, m.principal.userId);
  assert.equal(await code(s.org.audit(m.principal)), 'FORBIDDEN');
  const all = await s.org.audit(A.principal, { limit: '100' });
  const actions = all.items.map((e) => e.action);
  for (const a of ['user.register', 'invitation.created', 'invitation.accepted', 'password_reset.issued']) assert.ok(actions.includes(a), a);
  assert.ok(all.items.every((e) => !(e.meta && JSON.stringify(e.meta).includes('other-tenant'))));
  assert.ok(!JSON.stringify(all).includes(inv.token) && !JSON.stringify(all).includes('correct-horse-1') && !/ae_(inv|rst|rt)_/.test(JSON.stringify(all)));
  assert.equal(all.items.find((e) => e.action === 'invitation.created').actorEmail, A.email);
  assert.deepEqual((await s.org.audit(A.principal, { action: 'password_reset.issued' })).items.map((e) => e.action), ['password_reset.issued']);
  const p1 = await s.org.audit(A.principal, { limit: '2' }); assert.equal(p1.items.length, 2); assert.ok(p1.nextCursor);
  const p2 = await s.org.audit(A.principal, { limit: '2', cursor: p1.nextCursor }); assert.ok(p2.items.every((e) => !p1.items.some((x) => x.id === e.id)));
  assert.equal((await s.org.audit(B.principal, { limit: '100' })).items.some((e) => e.action === 'invitation.accepted'), false);
  for (const q of [{ action: 'x; drop' }, { cursor: 'zzz' }, { limit: '0' }]) assert.equal((await s.org.audit(A.principal, q).catch((e) => e)).status, 400, JSON.stringify(q));
});

test('delete demo data: confirmation required, admin only, removes only demo traces of this organization', async () => {
  const s = setup(); const A = await s.w.signup('a'); const B = await s.w.signup('b');
  const agA = await s.w.newAgent(A.principal, 'x'); const agB = await s.w.newAgent(B.principal, 'x');
  const put = (p, ag, demo) => s.w.services.traces.ingestOne(p, { ...s.w.traceFor(ag.id, { environment: 'production', metadata: demo ? { demo: true } : {} }) });
  for (let i = 0; i < 3; i++) { await put(A.principal, agA, true); await put(B.principal, agB, true); }
  await put(A.principal, agA, false);
  assert.equal(await code(s.org.deleteDemoData(A.principal, {})), 'VALIDATION_ERROR');
  assert.equal(await code(s.org.deleteDemoData(AS(A.principal, 'member'), { confirm: 'DELETE_DEMO_DATA' })), 'FORBIDDEN');
  const r = await s.org.deleteDemoData(A.principal, { confirm: 'DELETE_DEMO_DATA' });
  assert.deepEqual([r.deletedTraces, r.deletedRollups > 0], [3, true]);
  const left = (org) => s.repos._db.traces.filter((t) => t.organizationId === org);
  assert.deepEqual([left(A.principal.organizationId).length, left(B.principal.organizationId).length], [1, 3]);   // real trace kept; other tenant untouched
  assert.equal(left(A.principal.organizationId)[0].isDemo, false);
});

test('closed registration: the first account may be created, later sign-ups are refused, invitations still work', async () => {
  const s = setup({ ALLOW_REGISTRATION: 'false' });
  const owner = await s.w.signup('first');
  assert.equal(await code(s.auth.register({ email: 'second@example.com', password: 'correct-horse-1', name: 'S', organizationName: 'S' })), 'REGISTRATION_DISABLED');
  const inv = await s.org.invite(owner.principal, { email: 'invited@example.com' });
  assert.ok((await s.auth.acceptInvitation({ token: inv.token, name: 'Inv', password: 'correct-horse-1' })).token);
  const open = setup(); await open.w.signup('a'); await open.w.signup('b');   // default: open sign-up
});
