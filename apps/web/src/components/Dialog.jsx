import { createContext, useContext, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Icon from './Icon.jsx';
import { IconButton, cx } from './ui.jsx';

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]):not([type=hidden]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
const SIZE = { sm: 'sm:max-w-md', md: 'sm:max-w-xl', lg: 'sm:max-w-3xl' };

// Accessible modal: labelled, Esc and backdrop close, focus is trapped and returned to the trigger, page scroll is locked.
// Pass `onSubmit` to wrap body and footer in a <form> so the footer's submit button works.
export function Dialog({ open, onClose, title, description, children, footer, size = 'md', onSubmit }) {
  const panel = useRef(null);
  const body = useRef(null);
  const titleId = useId();
  const descId = useId();

  useEffect(() => {
    if (!open) return undefined;
    const previous = document.activeElement;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const target = panel.current?.querySelector('[data-autofocus]') || body.current?.querySelector('input:not([type=hidden]):not([disabled]),select:not([disabled]),textarea:not([disabled])') || panel.current?.querySelector('footer button:last-child');
    (target || panel.current)?.focus();
    return () => { document.body.style.overflow = overflow; if (previous && document.contains(previous)) previous.focus(); };
  }, [open]);

  if (!open) return null;

  function onKeyDown(e) {
    if (e.key === 'Escape') { e.stopPropagation(); onClose(); return; }
    if (e.key !== 'Tab') return;
    const items = [...panel.current.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null);
    if (!items.length) { e.preventDefault(); return; }
    const first = items[0]; const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  const Inner = onSubmit ? 'form' : 'div';
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-4" onKeyDown={onKeyDown}>
      <div className="absolute inset-0 animate-fade-in bg-black/50" onMouseDown={onClose} aria-hidden="true" />
      <div
        ref={panel} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={description ? descId : undefined} tabIndex={-1}
        className={cx('relative flex max-h-[calc(100dvh-1rem)] w-full animate-pop-in flex-col rounded-t-xl border border-line bg-surface shadow-pop focus:outline-none sm:max-h-[calc(100dvh-2rem)] sm:rounded-xl', SIZE[size])}
      >
        <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
          <div className="min-w-0">
            <h2 id={titleId} className="text-lg font-semibold">{title}</h2>
            {description && <p id={descId} className="mt-1 text-sm text-muted">{description}</p>}
          </div>
          <IconButton icon="x" label="Close" onClick={onClose} className="-mr-2 -mt-1" />
        </div>
        <Inner onSubmit={onSubmit} className="flex min-h-0 flex-1 flex-col">
          {children ? <div ref={body} className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div> : <div ref={body} />}
          {footer && <footer className="flex flex-wrap justify-end gap-2 border-t border-line bg-sunken/40 px-5 py-3">{footer}</footer>}
        </Inner>
      </div>
    </div>,
    document.body,
  );
}

/* ------------------------------------------------------------------- menus */

const MenuContext = createContext(() => {});

export function Menu({ renderTrigger, children, placement = 'top', className = '' }) {
  const [open, setOpen] = useState(false);
  const root = useRef(null);
  const trigger = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (!root.current?.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') { setOpen(false); trigger.current?.focus(); } };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    root.current?.querySelector('[role^=menuitem]')?.focus();
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  function onPanelKey(e) {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const items = [...root.current.querySelectorAll('[role^=menuitem]')];
    const i = items.indexOf(document.activeElement);
    e.preventDefault();
    items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
  }

  return (
    <div ref={root} className={cx('relative', className)}>
      {renderTrigger({ ref: trigger, onClick: () => setOpen((o) => !o), 'aria-haspopup': 'menu', 'aria-expanded': open })}
      {open && (
        <div role="menu" onKeyDown={onPanelKey} className={cx('absolute left-0 z-40 w-full min-w-[15rem] animate-pop-in rounded-lg border border-line bg-surface p-1 shadow-pop', placement === 'top' ? 'bottom-full mb-2' : 'top-full mt-2')}>
          <MenuContext.Provider value={() => setOpen(false)}>{children}</MenuContext.Provider>
        </div>
      )}
    </div>
  );
}

export function MenuItem({ icon, children, onClick, href, tone, keepOpen = false, checked, role = 'menuitem' }) {
  const close = useContext(MenuContext);
  const cls = cx(
    'flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm hover:bg-sunken focus-visible:bg-sunken focus-visible:outline-offset-[-2px]',
    tone === 'danger' ? 'text-danger-fg' : 'text-ink',
  );
  const click = (e) => { onClick?.(e); if (!keepOpen) close(); };
  const content = <>{icon && <Icon name={icon} size={15} className="text-muted" />}<span className="flex-1">{children}</span>{checked && <Icon name="check" size={15} className="text-link" />}</>;
  if (href) return <a role={role} href={href} onClick={click} className={cls}>{content}</a>;
  return <button type="button" role={role} aria-checked={checked} onClick={click} className={cls}>{content}</button>;
}
