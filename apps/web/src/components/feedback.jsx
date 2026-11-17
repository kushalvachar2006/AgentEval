import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import Icon from './Icon.jsx';
import { Dialog } from './Dialog.jsx';
import { Button, IconButton, cx } from './ui.jsx';

// Toasts confirm that an action happened ("Saved", "Deleted"). Confirm replaces window.confirm with an accessible dialog.
const Ctx = createContext({
  toast: () => {},
  confirm: async ({ title }) => window.confirm(title),
});

const TOAST = {
  success: ['check-circle', 'text-success-fg'],
  error: ['x-circle', 'text-danger-fg'],
  info: ['info', 'text-info-fg'],
};

export function FeedbackProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const [ask, setAsk] = useState(null);
  const next = useRef(0);

  const dismiss = useCallback((id) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const toast = useCallback((message, { tone = 'success', duration } = {}) => {
    const id = ++next.current;
    setToasts((t) => [...t.slice(-2), { id, message, tone }]);
    setTimeout(() => dismiss(id), duration ?? (tone === 'error' ? 7000 : 4000));
  }, [dismiss]);
  const confirm = useCallback((opts) => new Promise((resolve) => setAsk({ ...opts, resolve })), []);
  const settle = (value) => { ask?.resolve(value); setAsk(null); };
  const value = useMemo(() => ({ toast, confirm }), [toast, confirm]);

  return (
    <Ctx.Provider value={value}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-0 z-[60] flex flex-col items-center gap-2 p-4 sm:items-end">
        {toasts.map((t) => (
          <div key={t.id} role={t.tone === 'error' ? 'alert' : 'status'} className="pointer-events-auto flex w-full max-w-sm animate-toast-in items-start gap-3 rounded-lg border border-line bg-surface p-3 text-sm shadow-pop">
            <Icon name={TOAST[t.tone][0]} size={16} className={cx('mt-0.5', TOAST[t.tone][1])} />
            <p className="min-w-0 flex-1 break-words">{t.message}</p>
            <IconButton icon="x" label="Dismiss" size={14} onClick={() => dismiss(t.id)} className="-m-1 !h-6 !w-6" />
          </div>
        ))}
      </div>
      <Dialog
        open={Boolean(ask)} onClose={() => settle(false)} size="sm" title={ask?.title ?? ''} description={ask?.description}
        footer={<>
          <Button variant="secondary" data-autofocus onClick={() => settle(false)}>Cancel</Button>
          <Button variant={ask?.danger ? 'dangerSolid' : 'primary'} onClick={() => settle(true)}>{ask?.confirmLabel ?? 'Confirm'}</Button>
        </>}
      >
        {ask?.children}
      </Dialog>
    </Ctx.Provider>
  );
}

export const useToast = () => useContext(Ctx).toast;
export const useConfirm = () => useContext(Ctx).confirm;
