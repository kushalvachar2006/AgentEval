import { Children, useRef, useState } from 'react';
import Icon from './Icon.jsx';
import { fmtTime } from '../api.js';
import { ago, humanize } from '../hooks.js';

export const cx = (...parts) => parts.filter(Boolean).join(' ');
export const linkCls = 'font-medium text-link underline-offset-2 hover:underline';

/* ------------------------------------------------------------------ feedback */

export function Spinner({ size = 16, className = '' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={cx('animate-spin', className)} aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity=".25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export const Skeleton = ({ className = '' }) => <div aria-hidden="true" className={cx('animate-pulse rounded-md bg-sunken', className)} />;

export function LoadingBlock({ label = 'Loading…', className = '' }) {
  return (
    <div role="status" className={cx('flex items-center justify-center gap-2.5 py-12 text-sm text-muted', className)}>
      <Spinner /> {label}
    </div>
  );
}

export function TableSkeleton({ rows = 5, cols = 5 }) {
  return (
    <div role="status" aria-label="Loading" className="divide-y divide-line">
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} className="flex items-center gap-6 px-4 py-3.5">
          {Array.from({ length: cols }, (_, c) => <Skeleton key={c} className={cx('h-4', c === 0 ? 'w-40' : 'w-20 max-w-[7rem] flex-1')} />)}
        </div>
      ))}
    </div>
  );
}

const NOTICE = {
  info: ['border-info-fg/20 bg-info-bg', 'text-info-fg', 'info'],
  success: ['border-success-fg/20 bg-success-bg', 'text-success-fg', 'check-circle'],
  warning: ['border-warning-fg/25 bg-warning-bg', 'text-warning-fg', 'warning'],
  danger: ['border-danger-fg/20 bg-danger-bg', 'text-danger-fg', 'x-circle'],
};

export function Notice({ tone = 'info', title, children, action, className = '', ...rest }) {
  const [box, iconCls, icon] = NOTICE[tone];
  return (
    <div {...rest} className={cx('flex flex-wrap gap-3 rounded-lg border p-3.5 text-sm sm:flex-nowrap', box, className)}>
      <Icon name={icon} size={16} className={cx('mt-0.5', iconCls)} />
      <div className="min-w-0 flex-1 basis-[calc(100%-2rem)] sm:basis-0">
        {title && <p className={cx('font-medium', iconCls)}>{title}</p>}
        {children && <div className={cx('text-ink', title && 'mt-1')}>{children}</div>}
      </div>
      {action && <div className="shrink-0 sm:self-center">{action}</div>}
    </div>
  );
}

export function ErrorBox({ error }) {
  if (!error) return null;
  return (
    <Notice tone="danger" role="alert" title={error.message}>
      {Array.isArray(error.details) && (
        <ul className="list-disc space-y-0.5 pl-5">
          {error.details.slice(0, 8).map((d, i) => <li key={i}>{d.row ? `Row ${d.row}: ` : ''}<code>{d.path || 'request'}</code> {d.message}</li>)}
        </ul>
      )}
    </Notice>
  );
}

export function Empty({ icon = 'inbox', title, children, action, className = '' }) {
  return (
    <div className={cx('flex flex-col items-center px-6 py-10 text-center', className)}>
      <span className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-sunken text-muted"><Icon name={icon} size={18} /></span>
      {title && <p className="text-base font-semibold">{title}</p>}
      {children && <p className={cx('max-w-md text-sm text-muted', title && 'mt-1')}>{children}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

/* ------------------------------------------------------------------- buttons */

const BUTTON = {
  primary: 'bg-brand text-brand-on hover:bg-brand-strong',
  secondary: 'border border-line-strong bg-surface text-ink hover:bg-sunken',
  ghost: 'text-muted hover:bg-sunken hover:text-ink',
  danger: 'border border-line-strong bg-surface text-danger-fg hover:border-danger-dot/60 hover:bg-danger-bg',
  dangerSolid: 'bg-danger-solid text-white hover:opacity-90',
};
const BUTTON_SIZE = { md: 'h-9 px-3.5 text-sm', sm: 'h-8 px-3 text-sm', xs: 'h-7 px-2.5 text-xs' };

// Pass `href` to render a link that looks like a button (never nest a <button> inside an <a>).
export function Button({ variant = 'primary', size = 'md', icon, loading = false, href, className = '', children, disabled, ...p }) {
  const cls = cx(
    'inline-flex shrink-0 select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium transition-colors disabled:pointer-events-none disabled:opacity-50',
    BUTTON[variant], BUTTON_SIZE[size], className,
  );
  const lead = loading ? <Spinner size={size === 'xs' ? 12 : 14} /> : icon ? <Icon name={icon} size={size === 'xs' ? 13 : 15} /> : null;
  if (href && !disabled) return <a href={href} className={cls} {...p}>{lead}{children}</a>;
  return (
    <button type="button" {...p} disabled={disabled || loading} aria-busy={loading || undefined} className={cls}>
      {lead}{children}
    </button>
  );
}

export function IconButton({ icon, label, size = 16, className = '', ...p }) {
  return (
    <button type="button" aria-label={label} title={label} {...p} className={cx('inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-sunken hover:text-ink disabled:opacity-50', className)}>
      <Icon name={icon} size={size} />
    </button>
  );
}

export function CopyButton({ text, label = 'Copy', size = 'sm' }) {
  const [done, setDone] = useState(false);
  async function copy() {
    try { await navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1600); } catch { window.prompt('Copy this value:', text); }
  }
  return (
    <Button variant="secondary" size={size} icon={done ? 'check' : 'copy'} onClick={copy} aria-live="polite">
      {done ? 'Copied' : label}
    </Button>
  );
}

/* --------------------------------------------------------------------- forms */

const inputCore = 'block w-full rounded-md border border-line-strong bg-surface px-3 text-sm text-ink placeholder:text-faint hover:border-faint/70 focus:border-link focus:outline-none focus:ring-[3px] focus:ring-brand/40 disabled:cursor-not-allowed disabled:bg-sunken disabled:text-faint';

export function Field({ label, hint, children, className = '' }) {
  return (
    <label className={cx('block text-sm', className)}>
      <span className="mb-1.5 block font-medium text-ink">{label}</span>
      {children}
      {hint && <span className="mt-1.5 block text-xs text-muted">{hint}</span>}
    </label>
  );
}

export const Input = ({ className = '', ...p }) => <input {...p} className={cx(inputCore, 'h-9 read-only:bg-sunken', className)} />;
export const Textarea = ({ className = '', ...p }) => <textarea {...p} className={cx(inputCore, 'py-2 font-mono text-[12.5px] leading-relaxed read-only:bg-sunken', className)} />;

// className goes on the wrapper so width overrides such as "!w-40" behave as expected.
export function Select({ className = '', children, ...p }) {
  return (
    <span className={cx('relative block w-full', className)}>
      <select {...p} className={cx(inputCore, 'h-9 appearance-none pr-9')}>{children}</select>
      <Icon name="chevron-down" size={15} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-muted" />
    </span>
  );
}

export function PasswordInput({ className = '', ...p }) {
  const [show, setShow] = useState(false);
  return (
    <span className="relative block">
      <input {...p} type={show ? 'text' : 'password'} className={cx(inputCore, 'h-9 pr-10', className)} />
      <button
        type="button" onClick={() => setShow(!show)} aria-pressed={show} aria-label={show ? 'Hide value' : 'Show value'}
        className="absolute right-1 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded text-muted hover:bg-sunken hover:text-ink"
      >
        <Icon name={show ? 'eye-off' : 'eye'} size={15} />
      </button>
    </span>
  );
}

export function Checkbox({ children, className = '', ...p }) {
  return (
    <label className={cx('inline-flex cursor-pointer items-center gap-2 text-sm text-ink has-[:disabled]:cursor-not-allowed has-[:disabled]:text-faint', className)}>
      <input type="checkbox" {...p} className="h-4 w-4 rounded border-line-strong accent-brand" />
      {children}
    </label>
  );
}

export function Switch({ label, description, className = '', ...p }) {
  return (
    <label className={cx('flex cursor-pointer items-start gap-3 has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60', className)}>
      <span className="relative mt-0.5 inline-flex shrink-0">
        <input type="checkbox" role="switch" {...p} className="peer sr-only" />
        <span className="h-5 w-9 rounded-full bg-line-strong transition-colors peer-checked:bg-brand peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-link" />
        <span className="pointer-events-none absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform peer-checked:translate-x-4" />
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-medium text-ink">{label}</span>
        {description && <span className="mt-0.5 block text-xs text-muted">{description}</span>}
      </span>
    </label>
  );
}

/* ------------------------------------------------------------------- layout */

export function Card({ title, description, action, children, className = '', flush = false, ...p }) {
  const header = title || action;
  return (
    <section {...p} className={cx('rounded-panel border border-line bg-surface', className)}>
      {header && (
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-line px-5 py-3.5">
          <div className="min-w-0">
            <h2 className="text-base font-semibold">{title}</h2>
            {description && <p className="mt-0.5 text-sm text-muted">{description}</p>}
          </div>
          {action && <div className="flex flex-wrap items-center gap-2">{action}</div>}
        </div>
      )}
      <div className={flush ? '' : 'p-5'}>{children}</div>
    </section>
  );
}

export function Breadcrumbs({ items }) {
  return (
    <nav aria-label="Breadcrumb" className="mb-2">
      <ol className="flex flex-wrap items-center gap-1 text-sm text-muted">
        {items.map(([label, href], i) => (
          <li key={label + i} className="flex min-w-0 items-center gap-1">
            {i > 0 && <Icon name="chevron-right" size={13} className="text-faint" />}
            {href ? <a href={href} className="rounded px-0.5 hover:text-ink hover:underline">{label}</a> : <span aria-current="page" className="truncate text-ink">{label}</span>}
          </li>
        ))}
      </ol>
    </nav>
  );
}

export function PageHeader({ title, description, actions, breadcrumbs, badge, children }) {
  return (
    <header className="mb-6">
      {breadcrumbs && <Breadcrumbs items={breadcrumbs} />}
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          <h1 className="flex flex-wrap items-center gap-x-3 gap-y-1 text-2xl font-semibold">{title}{badge}</h1>
          {description && <p className="mt-1 max-w-2xl text-sm text-muted">{description}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children && <div className="mt-3">{children}</div>}
    </header>
  );
}

// Facts on one line, separated by hairlines drawn in CSS (no "·" characters to read aloud).
export function Meta({ children, className = '' }) {
  const items = Children.toArray(children).filter(Boolean);
  return (
    <div className={cx('flex flex-wrap items-center gap-y-1 text-sm text-muted [&>*+*]:before:mx-3 [&>*+*]:before:inline-block [&>*+*]:before:h-3.5 [&>*+*]:before:w-px [&>*+*]:before:bg-line-strong [&>*+*]:before:content-[""] [&>*]:inline-flex [&>*]:items-center', className)}>
      {items.map((c, i) => <span key={i}>{c}</span>)}
    </div>
  );
}

// A row of key figures divided by hairlines (one container, not a grid of separate cards).
export function StatStrip({ children, className = 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-5' }) {
  return (
    <div className="overflow-hidden rounded-panel border border-line bg-surface">
      <dl className={cx('-mb-px -mr-px grid', className)}>{children}</dl>
    </div>
  );
}

export function Stat({ label, value, hint, tone, compact = false }) {
  return (
    <div className="min-w-0 border-b border-r border-line px-4 py-3.5">
      <dt className="text-sm text-muted">{label}</dt>
      <dd className={cx('mt-1 truncate font-semibold tracking-tight tabular-nums', compact ? 'text-xl' : 'text-2xl', tone === 'bad' ? 'text-danger-fg' : tone === 'good' ? 'text-success-fg' : 'text-ink')}>{value}</dd>
      {hint && <p className="mt-0.5 text-xs text-muted">{hint}</p>}
    </div>
  );
}

export function Tabs({ tabs, value, onChange, label, idPrefix = 'tab', className = '' }) {
  const refs = useRef({});
  function onKeyDown(e) {
    const i = tabs.findIndex((t) => t[0] === value);
    let n = null;
    if (e.key === 'ArrowRight') n = (i + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') n = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') n = 0;
    else if (e.key === 'End') n = tabs.length - 1;
    if (n === null) return;
    e.preventDefault(); onChange(tabs[n][0]); refs.current[tabs[n][0]]?.focus();
  }
  return (
    <div role="tablist" aria-label={label} onKeyDown={onKeyDown} className={cx('flex gap-1 overflow-x-auto border-b border-line', className)}>
      {tabs.map(([key, text, count]) => {
        const selected = key === value;
        return (
          <button
            key={key} ref={(el) => { refs.current[key] = el; }} type="button" role="tab" id={`${idPrefix}-${key}`}
            aria-selected={selected} aria-controls={`${idPrefix}-panel-${key}`} tabIndex={selected ? 0 : -1} onClick={() => onChange(key)}
            className={cx('-mb-px whitespace-nowrap border-b-2 px-3 py-2.5 text-sm font-medium transition-colors', selected ? 'border-brand text-ink' : 'border-transparent text-muted hover:text-ink')}
          >
            {text}
            {count != null && <span className="ml-1.5 rounded-full bg-sunken px-1.5 py-0.5 text-xs tabular-nums text-muted">{count}</span>}
          </button>
        );
      })}
    </div>
  );
}
export const tabPanel = (idPrefix, key) => ({ role: 'tabpanel', id: `${idPrefix}-panel-${key}`, 'aria-labelledby': `${idPrefix}-${key}` });

/* --------------------------------------------------------------------- tables */

// Style the native table via descendant selectors so pages can write plain <thead>/<tr>/<td>.
export function Table({ children, className = '' }) {
  return (
    <div className="overflow-x-auto">
      <table className={cx(
        'w-full text-left text-sm tabular-nums',
        '[&_th]:whitespace-nowrap [&_th]:border-b [&_th]:border-line [&_th]:bg-sunken/60 [&_th]:px-4 [&_th]:py-2.5 [&_th]:text-xs [&_th]:font-medium [&_th]:text-muted',
        '[&_td]:px-4 [&_td]:py-3 [&_td]:align-middle',
        '[&_tbody_tr]:border-b [&_tbody_tr]:border-line [&_tbody_tr:last-child]:border-b-0 [&_tbody_tr:hover]:bg-sunken/50',
        className,
      )}>{children}</table>
    </div>
  );
}

export function RelTime({ iso, className = '' }) {
  if (!iso) return <span className={cx('text-faint', className)}>Never</span>;
  return <time dateTime={iso} title={fmtTime(iso)} className={className}>{ago(iso)}</time>;
}

/* --------------------------------------------------------------------- status */

const TONE = {
  success: ['bg-success-bg text-success-fg ring-success-fg/20', 'bg-success-dot'],
  danger: ['bg-danger-bg text-danger-fg ring-danger-fg/20', 'bg-danger-dot'],
  warning: ['bg-warning-bg text-warning-fg ring-warning-fg/20', 'bg-warning-dot'],
  info: ['bg-info-bg text-info-fg ring-info-fg/20', 'bg-info-dot'],
  neutral: ['bg-sunken text-muted ring-line-strong', 'bg-faint'],
};
const STATUS_TONE = {
  success: 'success', connected: 'success', up: 'success', passed: 'success', pass: 'success', completed: 'success', healthy: 'success', resolved: 'success', ok: 'success', active: 'success',
  error: 'danger', down: 'danger', failed: 'danger', fail: 'danger', failing: 'danger', open: 'danger', critical: 'danger', firing: 'danger',
  inconclusive: 'warning', degraded: 'warning', acknowledged: 'warning', warning: 'warning', pending: 'warning', timeout: 'warning',
  running: 'info', awaiting_traces: 'info', checking: 'info',
  queued: 'neutral', no_data: 'neutral', insufficient_data: 'neutral', cancelled: 'neutral', archived: 'neutral', disabled: 'neutral',
};

// A status with a dot: colour is never the only signal, the label is always shown.
export function Pill({ children, tone, pulse }) {
  const key = typeof children === 'string' ? children : '';
  const [box, dot] = TONE[tone ?? STATUS_TONE[key] ?? 'neutral'];
  const live = pulse ?? (key === 'running' || key === 'awaiting_traces' || key === 'checking');
  return (
    <span className={cx('inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset', box)}>
      <span className={cx('h-1.5 w-1.5 rounded-full', dot, live && 'animate-pulse')} />
      {typeof children === 'string' ? humanize(children) : children}
    </span>
  );
}

const TAG = {
  neutral: 'bg-sunken text-muted',
  brand: 'bg-brand-soft text-link',
  success: 'bg-success-bg text-success-fg',
  danger: 'bg-danger-bg text-danger-fg',
  warning: 'bg-warning-bg text-warning-fg',
  info: 'bg-info-bg text-info-fg',
};
// A small label for categories (span type, metric name, "demo"). Rectangular on purpose: statuses are round.
export const Tag = ({ children, tone = 'neutral', className = '', ...p }) => (
  <span {...p} className={cx('inline-flex items-center whitespace-nowrap rounded-sm px-1.5 py-0.5 text-xs font-medium', TAG[tone], className)}>{children}</span>
);

const BAR = { success: 'bg-success-dot', danger: 'bg-danger-dot', warning: 'bg-warning-dot', info: 'bg-info-dot', neutral: 'bg-line-strong', brand: 'bg-brand' };
export function SegmentedBar({ segments, total, label, className = '' }) {
  const t = total || segments.reduce((a, s) => a + s.value, 0) || 1;
  return (
    <div role="img" aria-label={label} className={cx('flex h-2 w-full overflow-hidden rounded-full bg-sunken', className)}>
      {segments.filter((s) => s.value > 0).map((s, i) => <div key={i} className={cx('h-full transition-[width] duration-500', BAR[s.tone])} style={{ width: `${(s.value / t) * 100}%` }} />)}
    </div>
  );
}

/* ----------------------------------------------------------------- misc blocks */

export function Code({ children, wrap = true, className = '', ...p }) {
  return (
    <pre tabIndex={0} {...p} className={cx('max-h-[28rem] overflow-auto rounded-md bg-code-bg p-3.5 font-mono text-[12.5px] leading-relaxed text-code-fg', wrap && 'whitespace-pre-wrap break-words', className)}>
      {children}
    </pre>
  );
}

export function Avatar({ name = '', size = 32 }) {
  const initial = (name.trim()[0] || '?').toUpperCase();
  return (
    <span aria-hidden="true" style={{ width: size, height: size }} className="inline-flex shrink-0 items-center justify-center rounded-full bg-brand-soft text-sm font-semibold text-link">
      {initial}
    </span>
  );
}

export const A = ({ className = '', ...p }) => <a {...p} className={cx(linkCls, className)} />;