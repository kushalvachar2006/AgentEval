import { useState } from 'react';
import { api, session } from '../api.js';
import Backdrop, { useSpotlight } from '../components/Backdrop.jsx';
import Logo from '../components/Logo.jsx';
import SystemStatus from '../components/SystemStatus.jsx';
import TraceDemo from '../components/TraceDemo.jsx';
import { Button, ErrorBox, Field, Input, PasswordInput, cx, linkCls } from '../components/ui.jsx';

// Staggered entrance: each block rises in a little after the previous one.
const rise = (i) => ({ className: 'animate-rise', style: { animationDelay: `${60 + i * 70}ms` } });

function Hero() {
  const ref = useSpotlight();
  return (
    <div ref={ref} className="relative hidden overflow-hidden bg-hero text-white lg:flex lg:flex-col lg:justify-center lg:px-14 xl:px-20">
      <Backdrop />
      <div className="relative mx-auto w-full max-w-xl">
        <h2 className="animate-rise text-3xl font-semibold leading-tight text-cream">Find out why your agent got it wrong.</h2>
        <p className="mt-3 max-w-md animate-rise text-lg text-white/70" style={{ animationDelay: '120ms' }}>Trace every step, score answers against what you expect, and get alerted when quality drops.</p>
        <div className="mt-12 animate-rise" style={{ animationDelay: '240ms' }}><TraceDemo floating /></div>
      </div>
    </div>
  );
}

export default function AuthPage({ onAuthed, initialMode = 'login' }) {
  const [mode, setMode] = useState(initialMode);
  const [form, setForm] = useState({ name: '', organizationName: '', email: '', password: '' });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const login = mode === 'login';
  const longEnough = form.password.length >= 10;

  async function submit(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const body = login ? { email: form.email, password: form.password } : form;
      const r = await api(`/auth/${login ? 'login' : 'register'}`, { method: 'POST', body });
      const org = r.organizations[0];
      session.set({ token: r.token, refreshToken: r.refreshToken, user: r.user, organizationId: org?.id, organizationName: org?.name, role: org?.role });
      onAuthed();
    } catch (err) { setError(err); } finally { setBusy(false); }
  }

  let n = 0;   // running index for the entrance stagger
  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
      <main className="relative flex min-h-dvh flex-col overflow-hidden bg-canvas px-6 py-8 sm:px-10">
        {/* Soft gold light and a faint dot grid behind the form */}
        <div aria-hidden="true" className="bg-dots absolute inset-0" />
        <div aria-hidden="true" className="glow-soft absolute -left-40 -top-40 h-[28rem] w-[28rem] animate-drift-a rounded-full blur-3xl motion-reduce:animate-none" />
        <div aria-hidden="true" className="glow-soft absolute -bottom-48 -right-32 h-[26rem] w-[26rem] animate-drift-b rounded-full opacity-70 blur-3xl motion-reduce:animate-none" />

        <a href="#/welcome" aria-label="AgentEval home" className="relative w-fit animate-rise rounded-md"><Logo /></a>

        <div className="relative flex flex-1 items-center py-10">
          <div className="mx-auto w-full max-w-sm">
            <div className="rounded-xl border border-line bg-surface/90 p-6 shadow-[0_24px_70px_-28px_rgb(var(--brand)/0.55)] backdrop-blur sm:p-7">
              {/* Re-keyed on mode so switching between sign in and sign up replays the entrance */}
              <div key={mode}>
                <h1 {...rise(n++)} className="animate-rise text-2xl font-semibold">{login ? 'Sign in to AgentEval' : 'Create your account'}</h1>
                <p {...rise(n++)} className="mt-1.5 animate-rise text-sm text-muted">{login ? 'Welcome back. Enter your details to continue.' : 'Set up a workspace for your team. It takes about a minute.'}</p>

                <form onSubmit={submit} className="mt-6 space-y-4">
                  {!login && (
                    <>
                      <div {...rise(n++)}><Field label="Your name"><Input value={form.name} onChange={set('name')} required maxLength={100} autoComplete="name" /></Field></div>
                      <div {...rise(n++)}><Field label="Organization name"><Input value={form.organizationName} onChange={set('organizationName')} required maxLength={100} autoComplete="organization" /></Field></div>
                    </>
                  )}
                  <div {...rise(n++)}><Field label="Email"><Input type="email" value={form.email} onChange={set('email')} required autoComplete="email" autoFocus={login} /></Field></div>
                  <div {...rise(n++)}>
                    <Field label="Password" hint={!login && <span className={cx('transition-colors', longEnough && 'text-success-fg')}>At least 10 characters{longEnough ? ' ✓' : ''}</span>}>
                      <PasswordInput value={form.password} onChange={set('password')} required minLength={login ? 1 : 10} autoComplete={login ? 'current-password' : 'new-password'} />
                    </Field>
                  </div>
                  <ErrorBox error={error} />
                  <div {...rise(n++)}>
                    <Button type="submit" loading={busy} className="glow-gold btn-shine w-full !h-10">{busy ? (login ? 'Signing in…' : 'Creating account…') : login ? 'Sign in' : 'Create account'}</Button>
                  </div>
                </form>
              </div>
            </div>

            <p className="mt-5 text-center text-sm text-muted">
              {login ? 'New to AgentEval?' : 'Already have an account?'}{' '}
              <button type="button" className={linkCls} onClick={() => { setMode(login ? 'register' : 'login'); setError(null); }}>
                {login ? 'Create an account' : 'Sign in'}
              </button>
            </p>
          </div>
        </div>
        <div className="relative mx-auto w-full max-w-sm"><SystemStatus /></div>
      </main>
      <Hero />
    </div>
  );
}