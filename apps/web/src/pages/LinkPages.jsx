import { useState } from 'react';
import { api, session } from '../api.js';
import Logo from '../components/Logo.jsx';
import { Button, ErrorBox, Field, Input, Notice, PasswordInput, linkCls } from '../components/ui.jsx';

const tokenOf = () => new URLSearchParams((window.location.hash.split('?')[1]) || '').get('token') || '';

function Shell({ title, description, children }) {
  return (
    <main className="flex min-h-dvh flex-col items-center px-4 py-10">
      <a href="#/dashboard" aria-label="AgentEval home" className="rounded-md"><Logo /></a>
      <div className="mt-12 w-full max-w-sm">
        <h1 className="text-2xl font-semibold">{title}</h1>
        {description && <p className="mt-1.5 text-sm text-muted">{description}</p>}
        <div className="mt-6">{children}</div>
        <p className="mt-6 text-center text-sm"><a className={linkCls} href="#/dashboard">Go to sign in</a></p>
      </div>
    </main>
  );
}

// #/invite?token=...  : create the account an administrator invited you to
export function InvitePage({ onAuthed }) {
  const [f, setF] = useState({ name: '', password: '' });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  async function submit(e) {
    e.preventDefault(); setBusy(true); setError(null);
    try {
      const r = await api('/auth/invitations/accept', { method: 'POST', auth: false, body: { token: tokenOf(), ...f } });
      const org = r.organizations[0];
      session.set({ token: r.token, refreshToken: r.refreshToken, user: r.user, organizationId: org?.id, organizationName: org?.name, role: org?.role });
      window.location.hash = '#/dashboard'; onAuthed();
    } catch (x) { setError(x); } finally { setBusy(false); }
  }
  return (
    <Shell title="Accept your invitation" description="Create your account to join the organization that invited you.">
      <form onSubmit={submit} className="space-y-4">
        {!tokenOf() && <Notice tone="danger" role="alert">This link has no invitation token. Ask your administrator for a new one.</Notice>}
        <Field label="Your name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required maxLength={100} autoComplete="name" /></Field>
        <Field label="Choose a password" hint="At least 10 characters."><PasswordInput value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} required minLength={10} autoComplete="new-password" /></Field>
        <ErrorBox error={error} />
        {error?.code === 'ACCOUNT_EXISTS' && <p className="text-sm text-muted">You already have an account. Sign in, open <b className="text-ink">Organization</b>, then <b className="text-ink">Account</b>, and paste this link under “Join another organization”.</p>}
        <Button type="submit" loading={busy} disabled={!tokenOf()} className="w-full">{busy ? 'Creating account…' : 'Create account and join'}</Button>
      </form>
    </Shell>
  );
}

// #/reset?token=...  : choose a new password with a link an administrator gave you
export function ResetPage() {
  const [pw, setPw] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  async function submit(e) {
    e.preventDefault(); setError(null); setBusy(true);
    try { await api('/auth/password-reset/complete', { method: 'POST', auth: false, body: { token: tokenOf(), newPassword: pw } }); session.clear(); setDone(true); }
    catch (x) { setError(x); } finally { setBusy(false); }
  }
  return (
    <Shell title="Choose a new password" description="Use the link your administrator gave you to set a new password.">
      {done ? (
        <div className="space-y-4">
          <Notice tone="success" title="Password changed">You were signed out everywhere. Sign in with your new password.</Notice>
          <Button href="#/dashboard" className="w-full">Go to sign in</Button>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          {!tokenOf() && <Notice tone="danger" role="alert">This link has no reset token. Ask your administrator for a new one.</Notice>}
          <Field label="New password" hint="At least 10 characters."><PasswordInput value={pw} onChange={(e) => setPw(e.target.value)} required minLength={10} autoComplete="new-password" /></Field>
          <ErrorBox error={error} />
          <Button type="submit" loading={busy} className="w-full" disabled={!tokenOf()}>Set password</Button>
        </form>
      )}
    </Shell>
  );
}
