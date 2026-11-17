import { useEffect, useRef, useState } from 'react';
import { cx } from './ui.jsx';

// True once the element has scrolled into view (and stays true). Falls back to "visible" where IntersectionObserver is missing.
export function useInView(options = { threshold: 0.15, rootMargin: '0px 0px -8% 0px' }) {
  const ref = useRef(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    if (!('IntersectionObserver' in window)) { setSeen(true); return undefined; }
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) { setSeen(true); io.disconnect(); } }, options);
    io.observe(el);
    return () => io.disconnect();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return [ref, seen];
}

// Fades and lifts its children in the first time they scroll into view. `delay` (ms) staggers siblings.
export default function Reveal({ as: Tag = 'div', delay = 0, className = '', children, ...p }) {
  const [ref, seen] = useInView();
  return (
    <Tag ref={ref} {...p} style={{ transitionDelay: seen ? `${delay}ms` : '0ms' }}
      className={cx('transition-[opacity,transform,background-color] duration-700 ease-out', seen ? 'translate-y-0 opacity-100' : 'translate-y-6 opacity-0', className)}>
      {children}
    </Tag>
  );
}