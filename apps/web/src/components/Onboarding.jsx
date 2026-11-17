import { useEffect, useState } from 'react';
import { api } from '../api.js';
import Icon from './Icon.jsx';
import { Button, SegmentedBar, cx } from './ui.jsx';

const KEY = (org) => `agenteval.onboarding.dismissed.${org}`;
const read = (k) => { try { return localStorage.getItem(k); } catch { return null; } };

// First-run checklist: shown until the basics are done (or dismissed). Each step is derived from real data, never self-reported.
export default function Onboarding({ organizationId }) {
  const [s, setS] = useState(null);
  const [hidden, setHidden] = useState(() => read(KEY(organizationId)) === '1');
  useEffect(() => {
    if (hidden) return;
    Promise.all([api('/agents?limit=1'), api('/traces?limit=1'), api('/test-suites?limit=1'), api('/evaluations?limit=1'), api('/alert-rules?limit=1')])
      .then(([a, t, su, ev, ru]) => setS({ agent: a.items.length > 0, trace: t.items.length > 0, suite: su.items.length > 0, run: ev.items.length > 0, rule: ru.items.length > 0 }))
      .catch(() => setS(null));
  }, [hidden]);
  if (hidden || !s) return null;

  const steps = [
    [s.agent, 'Register an agent', '#/agents', 'Give your AI agent a name and a version.'],
    [s.trace, 'Send your first trace', '#/agents', 'Create an API key on the agent page and use the Python SDK (see the code sample there).'],
    [s.suite, 'Create a test suite', '#/suites', 'A set of questions your agent should answer well.'],
    [s.run, 'Run an evaluation', '#/runs', 'Score what your agent says and does against the suite.'],
    [s.rule, 'Set up monitoring and an alert', '#/monitoring', 'Turn on production sampling, then add an alert rule.'],
  ];
  const done = steps.filter(([ok]) => ok).length;
  if (done === steps.length) return null;
  const current = steps.findIndex(([ok]) => !ok);
  const dismiss = () => { try { localStorage.setItem(KEY(organizationId), '1'); } catch { /* ignore */ } setHidden(true); };

  return (
    <section aria-labelledby="onboarding-title" className="mb-6 rounded-panel border border-line bg-surface">
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 pt-4">
        <div>
          <h2 id="onboarding-title" className="text-base font-semibold">Get started</h2>
          <p className="text-sm text-muted">{done} of {steps.length} steps done</p>
        </div>
        <Button variant="ghost" size="sm" onClick={dismiss}>Hide this</Button>
      </div>
      <div className="px-5 pt-3"><SegmentedBar label={`${done} of ${steps.length} steps done`} segments={[{ value: done, tone: 'brand' }]} total={steps.length} /></div>
      <ol className="mt-2 divide-y divide-line px-2 pb-2">
        {steps.map(([ok, title, href, hint], i) => (
          <li key={title} className="flex items-center gap-3 rounded-lg px-3 py-3">
            <span className={cx('flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold', ok ? 'bg-success-dot text-white' : i === current ? 'bg-brand text-brand-on' : 'border border-line-strong text-muted')}>
              {ok ? <Icon name="check" size={13} strokeWidth={2.5} /> : i + 1}
            </span>
            <div className="min-w-0 flex-1">
              <p className={cx('text-sm font-medium', ok && 'text-muted line-through')}>{title}</p>
              {!ok && <p className="text-xs text-muted">{hint}</p>}
            </div>
            {i === current && <Button size="sm" href={href}>Start</Button>}
          </li>
        ))}
      </ol>
    </section>
  );
}