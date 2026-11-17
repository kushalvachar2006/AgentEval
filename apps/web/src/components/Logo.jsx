// The mark is a tiny span waterfall: three offset bars, the shape of a trace.
export function LogoMark({ size = 28, className = '' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" className={`shrink-0 ${className}`} aria-hidden="true">
      <rect width="32" height="32" rx="8" fill="rgb(var(--brand))" />
      <rect x="7" y="8" width="14" height="3.5" rx="1.75" fill="rgb(var(--on-brand))" />
      <rect x="11" y="14.25" width="14" height="3.5" rx="1.75" fill="rgb(var(--on-brand))" fillOpacity=".75" />
      <rect x="9" y="20.5" width="9" height="3.5" rx="1.75" fill="rgb(var(--on-brand))" fillOpacity=".55" />
    </svg>
  );
}

export default function Logo({ size = 28, className = '' }) {
  return (
    <span className={`inline-flex items-center gap-2.5 ${className}`}>
      <LogoMark size={size} />
      <span className="text-lg font-semibold tracking-tight">AgentEval</span>
    </span>
  );
}