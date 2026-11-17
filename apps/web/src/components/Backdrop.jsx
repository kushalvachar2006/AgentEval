import { useEffect, useRef } from 'react';

// Pointer-following light: sets --mx/--my on the element so the .spotlight layer can follow the cursor. Skipped on touch and for reduced motion.
export function useSpotlight() {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || !window.matchMedia('(pointer: fine)').matches || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return undefined;
    let raf = 0;
    const move = (e) => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const r = el.getBoundingClientRect();
        el.style.setProperty('--mx', `${e.clientX - r.left}px`);
        el.style.setProperty('--my', `${e.clientY - r.top}px`);
      });
    };
    el.addEventListener('pointermove', move);
    return () => { el.removeEventListener('pointermove', move); cancelAnimationFrame(raf); };
  }, []);
  return ref;
}

// Decorative atmosphere for dark brand surfaces: a faint grid, slowly drifting gold/slate light, and the cursor spotlight.
// export default function Backdrop() {
//   return (
//     <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
//       <div className="bg-grid absolute inset-0" />
//       <div className="aurora-gold absolute -left-40 -top-48 h-[34rem] w-[34rem] animate-drift-a rounded-full blur-3xl motion-reduce:animate-none" />
//       <div className="aurora-slate absolute -right-32 top-10 h-[32rem] w-[32rem] animate-drift-b rounded-full blur-3xl motion-reduce:animate-none" />
//       <div className="aurora-cream absolute bottom-[-12rem] left-1/3 h-[26rem] w-[26rem] animate-drift-a rounded-full blur-3xl motion-reduce:animate-none" />
//       <div className="spotlight absolute inset-0" />
//     </div>
//   );
// }
export default function Backdrop() { }