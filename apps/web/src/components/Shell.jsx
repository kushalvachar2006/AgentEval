import { useEffect, useRef, useState } from 'react';
import { signOut } from '../api.js';
import { useTheme } from '../theme.js';
import Icon from './Icon.jsx';
import Logo from './Logo.jsx';
import { Avatar, IconButton, Tag, cx } from './ui.jsx';
import { Menu, MenuItem } from './Dialog.jsx';
import { useConfirm } from './feedback.jsx';

// [route key, label, icon]. Route keys are the first segment of the hash route (#/agents/...).
const NAV = [
  { items: [['dashboard', 'Dashboard', 'dashboard']] },
  { label: 'Build', items: [['agents', 'Agents', 'agents'], ['suites', 'Test suites', 'suites'], ['runs', 'Evaluations', 'runs']] },
  { label: 'Production', items: [['traces', 'Traces', 'traces'], ['monitoring', 'Monitoring', 'monitoring'], ['alerts', 'Alerts', 'alerts']] },
  { label: 'Workspace', items: [['organization', 'Organization', 'organization'], ['settings', 'Evaluators', 'settings']] },
];
const THEMES = [['system', 'System', 'monitor'], ['light', 'Light', 'sun'], ['dark', 'Dark', 'moon']];

const isActive = (key, section) => section === key || (key === 'traces' && section === 'debug') || (key === 'dashboard' && !section);

function AlertBadge({ alertCount }) {
  if (!alertCount.active) return null;
  return (
    <span
      title={`${alertCount.active} active alert(s)`}
      className={cx('min-w-[1.25rem] rounded-full px-1.5 text-center text-xs font-semibold tabular-nums', alertCount.critical ? 'bg-danger-solid text-white' : 'bg-warning-bg text-warning-fg ring-1 ring-inset ring-warning-fg/25')}
    >
      {alertCount.active}<span className="sr-only"> active alerts</span>
    </span>
  );
}

function AccountMenu({ auth }) {
  const { preference, setPreference } = useTheme();
  const confirm = useConfirm();
  const name = auth.user?.name || auth.user?.email || '';
  async function signOutEverywhere() {
    const ok = await confirm({ title: 'Sign out of every device?', description: 'Any browser or app signed in to this account will need to sign in again.', confirmLabel: 'Sign out everywhere', danger: true });
    if (ok) signOut({ everywhere: true });
  }
  return (
    <Menu
      placement="top"
      renderTrigger={(p) => (
        <button type="button" {...p} className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors hover:bg-sunken">
          <Avatar name={name} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{auth.organizationName}</span>
            <span className="block truncate text-xs text-muted">{auth.user?.email}</span>
          </span>
          <Icon name="chevrons-up-down" size={15} className="text-muted" />
        </button>
      )}
    >
      <div className="px-2.5 py-2">
        <p className="truncate text-sm font-medium">{auth.user?.name || auth.user?.email}</p>
        <p className="truncate text-xs text-muted">{auth.user?.email}</p>
        {auth.role && <Tag className="mt-1.5">{auth.role}</Tag>}
      </div>
      <div className="my-1 border-t border-line" />
      <p className="px-2.5 pb-1 pt-1.5 text-xs font-medium text-muted">Theme</p>
      {THEMES.map(([value, label, icon]) => (
        <MenuItem key={value} role="menuitemradio" keepOpen icon={icon} checked={preference === value} onClick={() => setPreference(value)}>{label}</MenuItem>
      ))}
      <div className="my-1 border-t border-line" />
      <MenuItem href="#/organization" icon="organization">Organization settings</MenuItem>
      <MenuItem icon="log-out" onClick={() => signOut()}>Sign out</MenuItem>
      <MenuItem icon="log-out" tone="danger" onClick={signOutEverywhere}>Sign out everywhere</MenuItem>
    </Menu>
  );
}

function SidebarContent({ auth, section, alertCount, onNavigate }) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-14 shrink-0 items-center px-4">
        <a href="#/dashboard" onClick={onNavigate} aria-label="AgentEval home" className="rounded-md"><Logo /></a>
      </div>
      <nav aria-label="Main" className="flex-1 overflow-y-auto px-3 pb-4 pt-1">
        {NAV.map((group, gi) => (
          <div key={gi} className={gi ? 'mt-5' : ''}>
            {group.label && <p className="mb-1 px-2.5 text-xs font-medium text-faint">{group.label}</p>}
            <ul className="space-y-0.5">
              {group.items.map(([key, label, icon]) => {
                const active = isActive(key, section);
                return (
                  <li key={key}>
                    <a
                      href={`#/${key}`} onClick={onNavigate} aria-current={active ? 'page' : undefined}
                      className={cx('flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm font-medium transition-colors', active ? 'bg-brand-soft text-link' : 'text-muted hover:bg-sunken hover:text-ink')}
                    >
                      <Icon name={icon} size={17} />
                      <span className="flex-1">{label}</span>
                      {key === 'alerts' && <AlertBadge alertCount={alertCount} />}
                    </a>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>
      <div className="border-t border-line p-3"><AccountMenu auth={auth} /></div>
    </div>
  );
}

export default function Shell({ auth, section, routeKey, alertCount, children }) {
  const [drawer, setDrawer] = useState(false);
  const main = useRef(null);
  const first = useRef(true);

  // New page: close the drawer, scroll to top and move focus to the content so screen readers announce the change.
  useEffect(() => {
    setDrawer(false);
    if (first.current) { first.current = false; return; }
    window.scrollTo(0, 0);
    main.current?.focus({ preventScroll: true });
  }, [routeKey]);

  useEffect(() => {
    if (!drawer) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setDrawer(false); };
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', onKey);
    return () => { document.body.style.overflow = overflow; document.removeEventListener('keydown', onKey); };
  }, [drawer]);

  return (
    <div className="min-h-dvh">
      <button type="button" onClick={() => main.current?.focus()} className="sr-only z-[70] rounded-md bg-brand px-3 py-2 text-sm font-medium text-brand-on focus:not-sr-only focus:fixed focus:left-3 focus:top-3">
        Skip to content
      </button>

      <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 border-r border-line bg-surface lg:block">
        <SidebarContent auth={auth} section={section} alertCount={alertCount} />
      </aside>

      {drawer && (
        <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
          <div className="absolute inset-0 animate-fade-in bg-black/50" onClick={() => setDrawer(false)} aria-hidden="true" />
          <aside className="absolute inset-y-0 left-0 w-72 max-w-[85vw] animate-drawer-in border-r border-line bg-surface shadow-pop">
            <div className="absolute right-2 top-3"><IconButton icon="x" label="Close navigation" onClick={() => setDrawer(false)} /></div>
            <SidebarContent auth={auth} section={section} alertCount={alertCount} onNavigate={() => setDrawer(false)} />
          </aside>
        </div>
      )}

      <div className="lg:pl-60" inert={drawer ? '' : undefined}>
        <header className="sticky top-0 z-20 flex h-14 items-center gap-2 border-b border-line bg-surface/90 px-3 backdrop-blur lg:hidden">
          <IconButton icon="menu" label="Open navigation" onClick={() => setDrawer(true)} aria-expanded={drawer} />
          <a href="#/dashboard" aria-label="AgentEval home" className="rounded-md"><Logo size={24} /></a>
          <a href="#/alerts" className="ml-auto flex h-8 items-center gap-2 rounded-md px-2 text-muted hover:bg-sunken hover:text-ink" aria-label="Alerts">
            <Icon name="alerts" size={17} /><AlertBadge alertCount={alertCount} />
          </a>
        </header>
        <main ref={main} id="main" tabIndex={-1} className="mx-auto w-full max-w-7xl px-4 py-6 focus:outline-none sm:px-6 lg:px-10 lg:py-8">
          {children}
        </main>
      </div>
    </div>
  );
}