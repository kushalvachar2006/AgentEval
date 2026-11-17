import Icon from './Icon.jsx';
import { cx } from './ui.jsx';

// A failed agent run, step by step, with the bad step called out. Built for the dark brand surface (bg-hero).
const SPANS = [
  { name: 'agent.run', start: 0, end: 100, time: '4.2 s' },
  { name: 'retrieve_docs', start: 3, end: 22, time: '0.8 s' },
  { name: 'llm.plan', start: 24, end: 47, time: '1.1 s' },
  { name: 'search_products', start: 49, end: 64, time: '0.6 s', bad: true },
  { name: 'llm.answer', start: 66, end: 98, time: '1.4 s' },
];

const chip = 'absolute z-10 flex items-center gap-2 rounded-lg border border-white/15 bg-hero/90 px-3 py-2 text-xs text-white shadow-[0_12px_30px_-10px_rgba(0,0,0,0.6)] backdrop-blur motion-reduce:animate-none';

export default function TraceDemo({ className = '', floating = false }) {
  return (
    <div className={cx('relative', className)}>
      {/* A gold light travels around the card's edge */}
      <div className="relative overflow-hidden rounded-xl p-px shadow-[0_30px_90px_-30px_rgba(242,193,78,0.5)]">
        <span
          aria-hidden="true" className="absolute left-1/2 top-1/2 h-[240%] w-[240%] animate-spin-slow motion-reduce:animate-none"
          style={{ background: 'conic-gradient(from 0deg, transparent 0 60%, rgba(242,193,78,0.95) 80%, transparent 100%)' }}
        />
        <figure className="relative overflow-hidden rounded-[11px] bg-hero bg-gradient-to-b from-white/[0.08] to-white/[0.02] p-5 text-white" aria-label="Example trace of a failed run">
          <span aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 h-px animate-scan bg-gradient-to-r from-transparent via-brand to-transparent motion-reduce:hidden" />
          <figcaption className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <span className="text-white/80">“Find the cheapest laptop below ₹50,000.”</span>
            <span className="inline-flex items-center gap-1.5 rounded-full bg-danger-dot/20 px-2 py-0.5 text-xs font-medium ring-1 ring-inset ring-danger-dot/40">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-danger-dot" />1 problem found
            </span>
          </figcaption>
          <ul className="mt-5 space-y-2.5">
            {SPANS.map((s, i) => {
              const pos = { left: `${s.start}%`, width: `${s.end - s.start}%` };
              return (
                <li key={s.name} className="flex items-center gap-3 text-sm">
                  <span className="w-32 shrink-0 truncate text-white/75">{s.name}</span>
                  <span className="relative h-3 flex-1 rounded-sm bg-white/[0.06]">
                    <span
                      className={cx('absolute inset-y-0 origin-left animate-bar rounded-sm', s.bad ? 'bg-danger-dot shadow-[0_0_14px_rgba(217,45,32,0.8)]' : 'bg-cream/75')}
                      style={{ ...pos, animationDelay: `${350 + i * 120}ms` }}
                    />
                    {s.bad && <span className="absolute inset-y-0 animate-ring-pulse rounded-sm bg-danger-dot motion-reduce:hidden" style={{ ...pos, animationDelay: '1.6s' }} />}
                  </span>
                  <span className="w-12 shrink-0 text-right text-xs tabular-nums text-white/60">{s.time}</span>
                </li>
              );
            })}
          </ul>
          <p className="mt-5 flex animate-rise gap-2 rounded-lg bg-black/25 p-3 text-sm text-white/80" style={{ animationDelay: '1.2s' }}>
            <Icon name="warning" size={16} className="mt-0.5 shrink-0 text-danger-dot" />
            <span>The search tool returned ₹47,999, but the answer says ₹52,999.</span>
          </p>
        </figure>
      </div>

      {floating && (
        <>
          <div aria-hidden="true" className={cx(chip, 'animate-float -right-3 -top-5 hidden sm:flex')}>
            <span className="h-2 w-2 rounded-full bg-danger-dot shadow-[0_0_10px_rgba(217,45,32,0.9)]" />Alert: error rate above 10%
          </div>
          <div aria-hidden="true" className={cx(chip, 'animate-float -bottom-5 -left-4 hidden sm:flex')} style={{ animationDelay: '-3s' }}>
            <span className="h-2 w-2 rounded-full bg-success-dot shadow-[0_0_10px_rgba(18,169,118,0.9)]" />Pass rate 82%
          </div>
        </>
      )}
    </div>
  );
}