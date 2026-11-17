import { useCallback, useEffect, useState } from 'react';
import { api, fmtTime, session, signOut } from '../api.js';
import { useConfirm, useToast } from '../components/feedback.jsx';
import { Button, Card, CopyButton, Empty, ErrorBox, Field, Input, Notice, PageHeader, PasswordInput, Pill, Select, Table, Tabs, tabPanel, linkCls } from '../components/ui.jsx';
import { ago } from '../hooks.js';

const ROLES = ['viewer', 'member', 'admin', 'owner'];
const useLoad = (path) => {
  const [data, setData] = useState(null); const [error, setError] = useState(null);
  const load = useCallback(() => api(path).then((d) => { setData(d); setError(null); }).catch(setError), [path]);
  useEffect(() => { load(); }, [load]);
  return { data, error, load };
};

// One-time secrets (invitation / reset links) are shown once, with a copy button, and never stored by the page.
function OneTime({ title, path, note, onClose }) {
  const link = `${window.location.origin}${window.location.pathname}${path}`;
  return (
    <Notice tone="warning" title={title} className="mt-4">
      <p className="text-xs text-muted">{note}</p>
      <input readOnly aria-label={title} value={link} onFocus={(e) => e.target.select()} className="mt-2 h-9 w-full rounded-md border border-line-strong bg-surface px-3 font-mono text-xs" />
      <div className="mt-2 flex gap-2"><CopyButton text={link} label="Copy link" /><Button variant="secondary" size="sm" onClick={onClose}>Done, hide it</Button></div>
    </Notice>
  );
}

function General() {
  const toast = useToast();
  const { data, error, load } = useLoad('/org');
  const [f, setF] = useState(null); const [err, setErr] = useState(null); const [busy, setBusy] = useState(false);
  useEffect(() => { if (data) setF({ name: data.name, days: data.settings.traceRetentionDays }); }, [data]);
  async function save(e) {
    e.preventDefault(); setErr(null); setBusy(true);
    try { await api('/org', { method: 'PATCH', body: { name: f.name, settings: { traceRetentionDays: Number(f.days) } } }); toast('Organization saved'); load(); } catch (x) { setErr(x); } finally { setBusy(false); }
  }
  return (
    <Card title="Organization" description={data ? `Your role: ${data.role}. Members: ${data.memberCount}.` : undefined}>
      <ErrorBox error={error} />
      {f && (
        <form onSubmit={save} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} maxLength={100} /></Field>
            <Field label="Keep traces for (days)" hint="1 to 3650. A new period applies to traces received from now on; stored traces keep their original expiry."><Input type="number" min="1" max="3650" value={f.days} onChange={(e) => setF({ ...f, days: e.target.value })} /></Field>
          </div>
          <ErrorBox error={err} />
          <Button type="submit" loading={busy}>Save changes</Button>
        </form>
      )}
    </Card>
  );
}

function Members() {
  const confirm = useConfirm();
  const { data, error, load } = useLoad('/org/members');
  const [err, setErr] = useState(null); const [link, setLink] = useState(null);
  const run = async (fn) => { setErr(null); try { await fn(); load(); } catch (e) { setErr(e); } };
  async function remove(m) {
    if (await confirm({ title: `Remove ${m.email}?`, description: 'They lose access to this organization immediately.', confirmLabel: 'Remove member', danger: true })) run(() => api(`/org/members/${m.userId}`, { method: 'DELETE' }));
  }
  return (
    <Card flush title="Members">
      <div className="px-5"><ErrorBox error={error || err} /></div>
      {data && (
        <Table>
          <thead><tr><th>Person</th><th>Role</th><th><span className="sr-only">Actions</span></th></tr></thead>
          <tbody>
            {data.items.map((m) => (
              <tr key={m.userId}>
                <td><span className="font-medium">{m.name}</span> <span className="ml-1 text-muted">{m.email}</span>{m.isYou && <span className="ml-2"><Pill tone="info">you</Pill></span>}</td>
                <td>{m.isYou ? <Pill>{m.role}</Pill> : <Select value={m.role} aria-label={`Role for ${m.email}`} onChange={(e) => run(() => api(`/org/members/${m.userId}`, { method: 'PATCH', body: { role: e.target.value } }))} className="!w-32">{ROLES.map((r) => <option key={r}>{r}</option>)}</Select>}</td>
                <td className="space-x-2 whitespace-nowrap text-right">{!m.isYou && <>
                  <Button variant="secondary" size="xs" onClick={() => run(async () => setLink(await api(`/org/members/${m.userId}/password-reset`, { method: 'POST' })))}>Reset password</Button>
                  <Button variant="danger" size="xs" onClick={() => remove(m)}>Remove</Button></>}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {link && <div className="px-5 pb-5"><OneTime title="Password reset link" path={link.resetPath} note={`${link.note} Expires ${fmtTime(link.expiresAt)}.`} onClose={() => setLink(null)} /></div>}
    </Card>
  );
}

function Invitations() {
  const toast = useToast();
  const { data, error, load } = useLoad('/org/invitations');
  const [f, setF] = useState({ email: '', role: 'member' }); const [err, setErr] = useState(null); const [link, setLink] = useState(null);
  async function invite(e) { e.preventDefault(); setErr(null); try { setLink(await api('/org/invitations', { method: 'POST', body: f })); setF({ ...f, email: '' }); load(); } catch (x) { setErr(x); } }
  return (
    <Card title="Invitations" description="AgentEval does not send email. Creating an invitation gives you a one-time link (valid 7 days) to pass to the person yourself.">
      <form onSubmit={invite} className="flex flex-wrap items-end gap-3">
        <Field label="Email"><Input type="email" required value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} className="!w-72" /></Field>
        <Field label="Role"><Select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })} className="!w-36">{ROLES.map((r) => <option key={r}>{r}</option>)}</Select></Field>
        <Button type="submit" icon="plus">Create invitation</Button>
      </form>
      <div className="mt-4"><ErrorBox error={error || err} /></div>
      {link && <OneTime title={`Invitation for ${link.email} (${link.role})`} path={link.acceptPath} note={link.note} onClose={() => setLink(null)} />}
      {data?.items.length > 0 && (
        <ul className="mt-5 divide-y divide-line rounded-lg border border-line text-sm">
          {data.items.map((i) => (
            <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 px-3.5 py-2.5">
              <span>{i.email} <Pill>{i.role}</Pill> <span className="ml-2 text-xs text-muted">Expires {fmtTime(i.expiresAt)}</span></span>
              <Button variant="secondary" size="xs" onClick={() => api(`/org/invitations/${i.id}`, { method: 'DELETE' }).then(() => { toast('Invitation revoked'); load(); }).catch(setErr)}>Revoke</Button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function Keys() {
  const confirm = useConfirm(); const toast = useToast();
  const { data, error, load } = useLoad('/api-keys'); const [err, setErr] = useState(null);
  const active = data?.items?.filter((k) => !k.revokedAt) ?? [];
  async function revoke(k) {
    if (!(await confirm({ title: `Revoke key “${k.name}”?`, description: 'Programs using it stop working immediately.', confirmLabel: 'Revoke key', danger: true }))) return;
    api(`/api-keys/${k.id}`, { method: 'DELETE' }).then(() => { toast('Key revoked'); load(); }).catch(setErr);
  }
  return (
    <Card flush title="API keys" description="An overview of active keys. Create keys on an agent’s page.">
      <div className="px-5"><ErrorBox error={error || err} /></div>
      {data && (active.length === 0 ? <Empty icon="key" title="No active API keys">Open an agent and create a key to start sending traces.</Empty> : (
        <Table>
          <thead><tr><th>Name</th><th>Prefix</th><th>Agent</th><th>Last used</th><th><span className="sr-only">Actions</span></th></tr></thead>
          <tbody>
            {active.map((k) => (
              <tr key={k.id}>
                <td className="font-medium">{k.name}</td><td className="font-mono text-xs">{k.keyPrefix ?? '—'}…</td>
                <td>{k.agentId ? <a className={linkCls} href={`#/agents/${k.agentId}`}>Open agent</a> : <span className="text-muted">Any agent</span>}</td>
                <td className="text-muted">{ago(k.lastUsedAt)}</td>
                <td className="text-right"><Button variant="danger" size="xs" onClick={() => revoke(k)}>Revoke</Button></td>
              </tr>
            ))}
          </tbody>
        </Table>
      ))}
    </Card>
  );
}

function Audit() {
  const [items, setItems] = useState([]); const [next, setNext] = useState(null); const [action, setAction] = useState(''); const [error, setError] = useState(null);
  const load = useCallback(async (cursor) => {
    try { const r = await api(`/org/audit?limit=25${action ? `&action=${encodeURIComponent(action)}` : ''}${cursor ? `&cursor=${cursor}` : ''}`); setItems((p) => (cursor ? [...p, ...r.items] : r.items)); setNext(r.nextCursor); setError(null); } catch (e) { setError(e); }
  }, [action]);
  useEffect(() => { load(); }, [load]);
  return (
    <Card flush title="Audit log" description="Who did what, and when." action={<Input type="search" value={action} onChange={(e) => setAction(e.target.value.trim())} aria-label="Filter by action" placeholder="Filter, e.g. member.removed" className="!w-60" />}>
      <div className="px-5"><ErrorBox error={error} /></div>
      {items.length === 0 ? <Empty icon="search" title="No matching events" /> : (
        <Table>
          <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Target</th><th>IP</th></tr></thead>
          <tbody>
            {items.map((e) => (
              <tr key={e.id} className="align-top text-xs">
                <td className="whitespace-nowrap">{fmtTime(e.at)}</td><td>{e.actorEmail ?? e.actorId ?? '—'}</td>
                <td className="font-mono">{e.action}{e.meta ? <div className="mt-0.5 font-sans text-muted">{JSON.stringify(e.meta)}</div> : null}</td>
                <td className="font-mono">{e.target ?? '—'}</td><td>{e.ip ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {next && <div className="border-t border-line p-3 text-center"><Button variant="ghost" size="sm" onClick={() => load(next)}>Load more</Button></div>}
    </Card>
  );
}

function Account() {
  const confirm = useConfirm(); const toast = useToast();
  const [f, setF] = useState({ currentPassword: '', newPassword: '' }); const [err, setErr] = useState(null); const [token, setToken] = useState(''); const [joined, setJoined] = useState(null);
  async function change(e) {
    e.preventDefault(); setErr(null);
    try { const r = await api('/auth/change-password', { method: 'POST', body: f }); session.set({ ...session.get(), token: r.token, refreshToken: r.refreshToken }); setF({ currentPassword: '', newPassword: '' }); toast('Password changed. Your other devices were signed out.'); } catch (x) { setErr(x); }
  }
  async function join(e) {
    e.preventDefault(); setErr(null); setJoined(null);
    try { setJoined(await api('/org/invitations/accept', { method: 'POST', body: { token: token.trim().replace(/^.*token=/, '') } })); setToken(''); } catch (x) { setErr(x); }
  }
  async function everywhere() {
    if (await confirm({ title: 'Sign out of every device?', description: 'Any browser or app signed in to this account will need to sign in again.', confirmLabel: 'Sign out everywhere', danger: true })) signOut({ everywhere: true });
  }
  return (
    <div className="space-y-6">
      <Card title="Change password">
        <form onSubmit={change} className="grid gap-4 sm:grid-cols-2">
          <Field label="Current password"><PasswordInput required value={f.currentPassword} onChange={(e) => setF({ ...f, currentPassword: e.target.value })} autoComplete="current-password" /></Field>
          <Field label="New password" hint="At least 10 characters."><PasswordInput required minLength={10} value={f.newPassword} onChange={(e) => setF({ ...f, newPassword: e.target.value })} autoComplete="new-password" /></Field>
          <div className="sm:col-span-2"><Button type="submit">Change password</Button></div>
        </form>
      </Card>
      <Card title="Join another organization" description="Paste an invitation link you were given.">
        <form onSubmit={join} className="flex flex-wrap items-end gap-3">
          <Field label="Invitation link" className="min-w-[16rem] flex-1"><Input value={token} onChange={(e) => setToken(e.target.value)} placeholder="…#/invite?token=ae_inv_…" /></Field>
          <Button type="submit" variant="secondary" disabled={!token.trim()}>Accept invitation</Button>
        </form>
        {joined && <Notice tone="success" className="mt-4">Joined as {joined.role}. Sign out and in again to switch organization.</Notice>}
      </Card>
      <ErrorBox error={err} />
      <Card title="Sessions">
        <div className="flex flex-wrap gap-2"><Button variant="secondary" icon="log-out" onClick={() => signOut()}>Sign out</Button><Button variant="danger" onClick={everywhere}>Sign out everywhere</Button></div>
      </Card>
    </div>
  );
}

function Danger() {
  const confirm = useConfirm();
  const [msg, setMsg] = useState(null); const [err, setErr] = useState(null);
  async function wipe() {
    if (!(await confirm({ title: 'Delete all demo data?', description: 'Demo traces and their rollups are removed. Real data is not touched. This cannot be undone.', confirmLabel: 'Delete demo data', danger: true }))) return;
    setErr(null); try { const r = await api('/org/demo-data/delete', { method: 'POST', body: { confirm: 'DELETE_DEMO_DATA' } }); setMsg(`Deleted ${r.deletedTraces} demo trace(s) and ${r.deletedRollups} rollup row(s).`); } catch (e) { setErr(e); }
  }
  return (
    <Card title="Danger zone" className="border-danger-fg/30">
      <p className="text-sm text-muted">Remove the sample data created by the demo-data generator. Only traces flagged as demo are deleted.</p>
      <div className="mt-4"><Button variant="danger" icon="trash" onClick={wipe}>Delete demo data</Button></div>
      {msg && <Notice tone="success" className="mt-4">{msg}</Notice>}
      <div className="mt-3"><ErrorBox error={err} /></div>
    </Card>
  );
}

const TABS = [['general', 'General'], ['members', 'Members'], ['invitations', 'Invitations'], ['keys', 'API keys'], ['audit', 'Audit log'], ['account', 'Account'], ['danger', 'Danger zone']];
const VIEWS = { general: General, members: Members, invitations: Invitations, keys: Keys, audit: Audit, account: Account, danger: Danger };

export default function OrganizationPage() {
  const [tab, setTab] = useState('general');
  const View = VIEWS[tab];
  return (
    <div>
      <PageHeader title="Organization" description="People, access, retention and your account." />
      <Tabs idPrefix="org" label="Organization sections" tabs={TABS} value={tab} onChange={setTab} />
      <div {...tabPanel('org', tab)} className="mt-6"><View /></div>
    </div>
  );
}
