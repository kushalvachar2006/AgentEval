import { useEffect, useState } from 'react';
import Backdrop, { useSpotlight } from '../components/Backdrop.jsx';
import Icon from '../components/Icon.jsx';
import Logo from '../components/Logo.jsx';
import Reveal, { useInView } from '../components/Reveal.jsx';
import TraceDemo from '../components/TraceDemo.jsx';
import { Button, IconButton, cx } from '../components/ui.jsx';
import { useTheme } from '../theme.js';

const wrap = 'mx-auto w-full max-w-6xl px-5 sm:px-8';
const jump = (id) => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });

const NAV = [['purpose', 'Purpose'], ['users', 'Who it’s for'], ['how', 'How it works'], ['outcomes', 'Outcomes']];
const METRICS = ['Accuracy', 'Hallucination', 'Groundedness', 'Relevance', 'Completeness', 'Tool usage', 'Instruction adherence', 'Operational'];
const WORKS_WITH = ['LangChain', 'LangGraph', 'Custom agents', 'Python SDK', 'HTTP endpoint'];

const CAPABILITIES = [
  ['traces', 'Trace every run', 'See each model call, tool call and retrieval as a step, with its timing, tokens and cost. Secrets are redacted before anything is stored.'],
  ['bug', 'Debug a bad answer', 'Open any run and get ranked findings that point to the exact step, with the evidence and how certain the finding is.'],
  ['runs', 'Evaluate against what you expect', 'Build test suites with expected answers, then score accuracy, hallucination, groundedness, relevance, completeness, tool use and instruction adherence.'],
  ['monitoring', 'Watch production', 'Sample live traffic, track health, and get alerts on error rate, latency, quality drops, daily cost or silence, in the app or by webhook.'],
];

const USERS = [
  ['AI and ML engineers', 'Add the Python SDK to a LangChain or LangGraph agent, find out why a run failed, and compare each new version with the last.'],
  ['QA and test engineers', 'Turn real questions and expected answers into test suites (import CSV or JSON), run evaluations, and track the pass rate over time.'],
  ['Engineering managers and product owners', 'See reliability, speed, cost and answer quality on one dashboard, and decide with evidence whether a version is ready to ship.'],
  ['Platform teams and administrators', 'Set sampling and budgets, define alert rules and webhooks, manage members and roles, and review the audit log and data retention.'],
];

const STEPS = [
  ['Register your agent', 'Give it a name, a framework and a version. You get an API key right away.'],
  ['Send traces', 'Add the handler to your code. Every run is recorded, whether it succeeds or fails.'],
  ['Evaluate with a test suite', 'Run your questions through the agent and see which answers pass, fail or can’t be judged.'],
  ['Monitor and get alerted', 'Turn on production sampling, then add alert rules for the limits you care about.'],
];

const OUTCOMES = [
  ['Catch regressions before release', 'Compare versions on error rate, latency, tokens and quality score instead of trusting a hunch after a prompt change.'],
  ['Fix problems in minutes, not days', 'Go from “this answer is wrong” to the step that caused it, with the evidence next to it.'],
  ['Fewer unsupported claims reach users', 'Track how often answers state things their sources don’t support, and see which ones contradict the evidence.'],
  ['Production quality you can see', 'A sampled, scored view of live traffic, so a slow decline shows up as an alert and not a support ticket.'],
  ['Costs that don’t surprise you', 'Per-run cost estimates, daily budgets for evaluations and AI-judge calls, and an alert when daily spend crosses your limit.'],
  ['Honest scores', 'When a check lacks data or confidence, it says “inconclusive”. It is never counted as a pass.'],
];

const SNIPPET = [
  'from agenteval import AgentEval',
  '',
  'client = AgentEval(api_key="<your key>", endpoint="https://your-agenteval-host")',
  'handler = client.langchain_handler("<agent id>")',
  '',
  'result = chain.invoke(inputs, config={"callbacks": [handler]})',
  'client.flush()',
];

const THEME_ICON = { system: 'monitor', light: 'sun', dark: 'moon' };
const NEXT_THEME = { system: 'light', light: 'dark', dark: 'system' };
const rise = (ms) => ({ className: 'animate-rise', style: { animationDelay: `${ms}ms` } });

function ThemeToggle({ onHero }) {
  const { preference, setPreference } = useTheme();
  return (
    <IconButton
      icon={THEME_ICON[preference]} label={`Theme: ${preference}. Click to change.`} onClick={() => setPreference(NEXT_THEME[preference])}
      className={onHero ? '!text-white/75 hover:!bg-white/10 hover:!text-white' : ''}
    />
  );
}

function Header() {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const on = () => setScrolled(window.scrollY > 24);
    on(); window.addEventListener('scroll', on, { passive: true });
    return () => window.removeEventListener('scroll', on);
  }, []);
  const onHero = !scrolled;
  return (
    <header className={cx('fixed inset-x-0 top-0 z-30 border-b transition-[background-color,border-color,box-shadow] duration-300', onHero ? 'border-transparent bg-transparent text-white' : 'border-line bg-surface/85 text-ink shadow-[0_8px_30px_-18px_rgba(0,0,0,0.35)] backdrop-blur-md')}>
      <div className={cx(wrap, 'flex h-14 items-center gap-6')}>
        <a href="#/welcome" aria-label="AgentEval home" className="rounded-md"><Logo /></a>
        <nav aria-label="Page sections" className="ml-4 hidden items-center gap-1 md:flex">
          {NAV.map(([id, label]) => (
            <button key={id} type="button" onClick={() => jump(id)} className={cx('rounded-md px-3 py-1.5 text-sm font-medium transition-colors', onHero ? 'text-white/70 hover:bg-white/10 hover:text-white' : 'text-muted hover:bg-sunken hover:text-ink')}>{label}</button>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <ThemeToggle onHero={onHero} />
          <Button variant="ghost" href="#/signin" className={cx('hidden sm:inline-flex', onHero && '!text-white hover:!bg-white/10')}>Sign in</Button>
          <Button href="#/signin?mode=register" className="glow-gold">Get started</Button>
        </div>
      </div>
    </header>
  );
}

function MetricsMarquee() {
  const row = (hidden) => (
    <ul aria-hidden={hidden || undefined} className="flex shrink-0 gap-3 pr-3">
      {METRICS.map((m) => (
        <li key={m} className="inline-flex items-center gap-2 whitespace-nowrap rounded-full border border-white/15 bg-white/[0.05] px-3.5 py-1.5 text-sm text-white/80">
          <span className="h-1.5 w-1.5 rounded-full bg-brand shadow-[0_0_8px_rgba(242,193,78,0.9)]" />{m}
        </li>
      ))}
    </ul>
  );
  return (
    <div className="relative border-t border-white/10 py-5">
      <p className="mb-3 text-center text-sm text-white/60">Every answer can be scored on</p>
      <div className="overflow-hidden [mask-image:linear-gradient(90deg,transparent,#000_12%,#000_88%,transparent)]">
        <div className="flex w-max animate-marquee hover:[animation-play-state:paused] motion-reduce:animate-none">{row(false)}{row(true)}</div>
      </div>
    </div>
  );
}

function Hero() {
  const ref = useSpotlight();
  return (
    <section ref={ref} className="relative overflow-hidden bg-hero text-white">
      <Backdrop />
      <div className={cx(wrap, 'relative grid items-center gap-14 pb-16 pt-32 lg:grid-cols-[1.05fr_1fr] lg:pb-24 lg:pt-40')}>
        <div>
          <h1 {...rise(0)} className="animate-rise text-[2.5rem] font-semibold leading-[1.1] text-cream sm:text-5xl">Know whether your AI agent is right, and why it isn’t.</h1>
          <p {...rise(140)} className="mt-5 max-w-xl animate-rise text-lg text-white/75">AgentEval is a quality platform for teams building AI agents. Trace every step a run takes, test answers against what you expect, and get alerted when production quality slips.</p>
          <div {...rise(280)} className="mt-8 flex animate-rise flex-wrap items-center gap-3">
            <Button href="#/signin?mode=register" className="glow-gold btn-shine !h-11 !px-5 !text-base">Create an account</Button>
            <Button href="#/signin" variant="ghost" className="!h-11 !text-base !text-white hover:!bg-white/10">Sign in</Button>
          </div>
          <ul {...rise(420)} aria-label="Works with" className="mt-8 flex animate-rise flex-wrap gap-2">
            {WORKS_WITH.map((w) => <li key={w} className="rounded-md border border-white/15 bg-white/[0.04] px-2.5 py-1 text-xs text-white/70">{w}</li>)}
          </ul>
        </div>
        <div {...rise(250)} className="animate-rise"><TraceDemo floating /></div>
      </div>
      <MetricsMarquee />
    </section>
  );
}

function SectionHead({ id, title, children, className = '' }) {
  return (
    <Reveal id={id} className={cx('scroll-mt-20 max-w-2xl', className)}>
      <h2 className="text-3xl font-semibold leading-tight">{title}</h2>
      {children && <p className="mt-3 text-lg text-muted">{children}</p>}
    </Reveal>
  );
}

function Step({ i, title, text }) {
  const [ref, seen] = useInView();
  return (
    <li ref={ref} className="relative flex gap-4 pb-9 last:pb-0">
      {i < STEPS.length - 1 && (
        <span aria-hidden="true" className={cx('absolute bottom-1 left-[13px] top-8 w-px origin-top bg-gradient-to-b from-brand to-line-strong transition-transform duration-1000 ease-out', seen ? 'scale-y-100' : 'scale-y-0')} style={{ transitionDelay: `${i * 220 + 250}ms` }} />
      )}
      <span
        className={cx('relative z-10 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand text-sm font-semibold text-brand-on shadow-[0_0_0_4px_rgb(var(--brand)/0.22),0_0_22px_rgb(var(--brand)/0.55)]', !seen && 'opacity-0', seen && 'animate-pop')}
        style={{ animationDelay: `${i * 220}ms` }}
      >{i + 1}</span>
      <div className={cx('transition-[opacity,transform] duration-700 ease-out', seen ? 'translate-x-0 opacity-100' : 'translate-x-4 opacity-0')} style={{ transitionDelay: `${i * 220 + 120}ms` }}>
        <h3 className="font-semibold">{title}</h3>
        <p className="mt-1 text-muted">{text}</p>
      </div>
    </li>
  );
}

// Tiny highlighter: strings in gold, keywords in cream. Enough for a five-line sample.
function Line({ text }) {
  const parts = text.split(/("[^"]*")/g);
  return parts.map((p, i) => (p.startsWith('"')
    ? <span key={i} className="text-brand">{p}</span>
    : <span key={i}>{p.split(/\b(from|import)\b/g).map((q, j) => (q === 'from' || q === 'import' ? <span key={j} className="font-medium text-cream">{q}</span> : q))}</span>));
}

function CodeWindow() {
  const [ref, seen] = useInView({ threshold: 0.3 });
  return (
    <div ref={ref} className="relative">
      <div aria-hidden="true" className="glow-soft absolute -inset-8 -z-10 rounded-full blur-2xl" />
      <div className="overflow-hidden rounded-xl border border-white/10 bg-code-bg shadow-[0_30px_70px_-30px_rgba(0,0,0,0.6)]">
        <div className="flex items-center gap-2 border-b border-white/10 px-4 py-2.5">
          <span className="h-2.5 w-2.5 rounded-full bg-danger-dot/80" /><span className="h-2.5 w-2.5 rounded-full bg-brand/90" /><span className="h-2.5 w-2.5 rounded-full bg-success-dot/80" />
          <span className="ml-3 text-xs text-code-fg/60">agent.py</span>
        </div>
        <pre className="overflow-x-auto p-4 font-mono text-[12.5px] leading-relaxed text-code-fg" aria-label="Python sample">
          <code>
            {SNIPPET.map((l, i) => (
              <span key={i} className={cx('block min-h-[1.4em] transition-[opacity,transform] duration-500 ease-out', seen ? 'translate-x-0 opacity-100' : '-translate-x-2 opacity-0')} style={{ transitionDelay: `${i * 140}ms` }}>
                <Line text={l} />{i === SNIPPET.length - 1 && <span aria-hidden="true" className="ml-0.5 inline-block h-[1em] w-[7px] translate-y-[2px] animate-blink bg-brand motion-reduce:animate-none" />}
              </span>
            ))}
          </code>
        </pre>
      </div>
    </div>
  );
}

export default function Landing() {
  const closing = useSpotlight();
  return (
    <div className="min-h-dvh bg-surface">
      <Header />
      <main>
        <Hero />

        {/* Purpose */}
        <section className="relative overflow-hidden py-24">
          <div aria-hidden="true" className="bg-dots absolute inset-0" />
          <div className={cx(wrap, 'relative')}>
            <SectionHead id="purpose" title="Agents fail in ways a log line won’t show you">
              An answer can read well while the tool behind it returned something else. A prompt tweak can quietly make things worse. AgentEval exists to give your team one place to see what happened, measure how good it was, and notice when it changes.
            </SectionHead>
            <dl className="mt-14 grid gap-5 md:grid-cols-2">
              {CAPABILITIES.map(([icon, title, text], i) => (
                <Reveal key={title} delay={(i % 2) * 120}>
                  <div className="glow-card group h-full rounded-panel border border-line bg-surface p-6">
                    <span className="flex h-11 w-11 items-center justify-center rounded-lg bg-brand-soft text-link transition-[background-color,color,box-shadow] duration-300 group-hover:bg-brand group-hover:text-brand-on group-hover:shadow-[0_0_28px_rgb(var(--brand)/0.7)]"><Icon name={icon} size={20} /></span>
                    <dt className="mt-4 text-lg font-semibold">{title}</dt>
                    <dd className="mt-1.5 text-muted">{text}</dd>
                  </div>
                </Reveal>
              ))}
            </dl>
          </div>
        </section>

        {/* Users */}
        <section className="border-y border-line bg-canvas py-24">
          <div className={wrap}>
            <SectionHead id="users" title="Built for the people who ship and run agents">Everyone in the team sees the same facts, each from the angle they need.</SectionHead>
            <ul className="mt-12 divide-y divide-line border-y border-line">
              {USERS.map(([role, text], i) => (
                <Reveal as="li" key={role} delay={i * 90} className="group relative grid gap-2 py-7 pl-4 before:absolute before:left-0 before:top-5 before:h-[calc(100%-2.5rem)] before:w-0.5 before:origin-center before:scale-y-0 before:rounded-full before:bg-brand before:shadow-[0_0_12px_rgb(var(--brand)/0.8)] before:transition-transform before:duration-300 hover:before:scale-y-100 md:grid-cols-[18rem_1fr] md:gap-10">
                  <h3 className="text-lg font-semibold transition-transform duration-300 group-hover:translate-x-1">{role}</h3>
                  <p className="text-muted">{text}</p>
                </Reveal>
              ))}
            </ul>
          </div>
        </section>

        {/* How it works */}
        <section className="relative overflow-hidden py-24">
          <div className={cx(wrap, 'relative grid gap-14 lg:grid-cols-[1fr_1.1fr]')}>
            <div>
              <SectionHead id="how" title="From first trace to first alert in four steps" />
              <ol className="mt-12">{STEPS.map(([title, text], i) => <Step key={title} i={i} title={title} text={text} />)}</ol>
            </div>
            <Reveal className="self-center" delay={150}>
              <p className="mb-3 text-sm font-medium text-muted">Step 2 is a few lines of Python</p>
              <CodeWindow />
            </Reveal>
          </div>
        </section>

        {/* Outcomes */}
        <section className="border-y border-line bg-canvas py-24">
          <div className={wrap}>
            <SectionHead id="outcomes" title="What you can expect from using it">Concrete changes in how your team builds and runs agents.</SectionHead>
            <ul className="mt-12 grid gap-x-10 gap-y-10 md:grid-cols-2 lg:grid-cols-3">
              {OUTCOMES.map(([title, text], i) => (
                <Reveal as="li" key={title} delay={(i % 3) * 100} className="group flex gap-3">
                  <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-success-bg text-success-fg ring-1 ring-success-fg/25 transition-shadow duration-300 group-hover:shadow-[0_0_16px_rgb(var(--success-dot)/0.7)]"><Icon name="check" size={14} strokeWidth={2.5} /></span>
                  <div><h3 className="font-semibold">{title}</h3><p className="mt-1 text-sm text-muted">{text}</p></div>
                </Reveal>
              ))}
            </ul>
            <Reveal className="mt-14 max-w-3xl">
              <p className="flex gap-3 rounded-lg border border-line bg-surface p-4 text-sm text-muted">
                <Icon name="shield" size={18} className="mt-0.5 shrink-0 text-link" />
                <span>Secret-looking values are redacted from traces, API keys and tokens are stored encrypted, access is role-based, and every administrative action lands in an audit log. You choose how long traces are kept.</span>
              </p>
            </Reveal>
          </div>
        </section>

        {/* Closing call to action */}
        <section ref={closing} className="relative overflow-hidden bg-hero text-white">
          <Backdrop />
          <Reveal className={cx(wrap, 'relative flex flex-wrap items-center justify-between gap-8 py-24')}>
            <div className="max-w-xl">
              <h2 className="text-3xl font-semibold leading-tight text-cream sm:text-4xl">Start with one agent.</h2>
              <p className="mt-3 text-lg text-white/75">Create an account, register an agent, and send your first trace. The checklist on your dashboard guides each step.</p>
            </div>
            <div className="flex flex-wrap gap-3">
              <Button href="#/signin?mode=register" className="glow-gold btn-shine !h-11 !px-5 !text-base">Create an account</Button>
              <Button href="#/signin" variant="ghost" className="!h-11 !text-base !text-white hover:!bg-white/10">Sign in</Button>
            </div>
          </Reveal>
        </section>
      </main>

      <footer className="border-t border-line">
        <div className={cx(wrap, 'flex flex-wrap items-center justify-between gap-4 py-8 text-sm text-muted')}>
          <span className="inline-flex items-center gap-3"><Logo size={22} /><span>AI agent quality engineering platform</span></span>
          <span className="flex gap-5"><a className="hover:text-ink hover:underline" href="#/signin">Sign in</a><a className="hover:text-ink hover:underline" href="#/signin?mode=register">Create an account</a></span>
        </div>
      </footer>
    </div>
  );
}