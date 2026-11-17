import { Suspense, lazy, useEffect, useState } from 'react';
import { api, session } from './api.js';
import AuthPage from './pages/AuthPage.jsx';
import Landing from './pages/Landing.jsx';
const AgentsPage = lazy(() => import('./pages/AgentsPage.jsx'));
const AgentDetail = lazy(() => import('./pages/AgentDetail.jsx'));
const TraceDetail = lazy(() => import('./pages/TraceDetail.jsx'));
const SuitesPage = lazy(() => import('./pages/SuitesPage.jsx'));
const SuiteDetail = lazy(() => import('./pages/SuiteDetail.jsx'));
const RunsPage = lazy(() => import('./pages/RunsPage.jsx'));
const RunDetail = lazy(() => import('./pages/RunDetail.jsx'));
const SettingsPage = lazy(() => import('./pages/SettingsPage.jsx'));
const Dashboard = lazy(() => import('./pages/Dashboard.jsx'));
const TracesPage = lazy(() => import('./pages/TracesPage.jsx'));
const DebugView = lazy(() => import('./pages/DebugView.jsx'));
const MonitoringPage = lazy(() => import('./pages/MonitoringPage.jsx'));
const AlertsPage = lazy(() => import('./pages/AlertsPage.jsx'));
const OrganizationPage = lazy(() => import('./pages/OrganizationPage.jsx'));
import { InvitePage, ResetPage } from './pages/LinkPages.jsx';
import Onboarding from './components/Onboarding.jsx';
import Shell from './components/Shell.jsx';
import ErrorBoundary from './components/ErrorBoundary.jsx';
import { FeedbackProvider } from './components/feedback.jsx';
import { Button, Empty, LoadingBlock } from './components/ui.jsx';

const useHash = () => {
  const [hash, setHash] = useState(window.location.hash);
  useEffect(() => {
    const on = () => setHash(window.location.hash);
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return hash;
};

const TITLES = {
  dashboard: 'Dashboard', agents: 'Agents', traces: 'Traces', debug: 'Debug trace', suites: 'Test suites', runs: 'Evaluations',
  monitoring: 'Monitoring', alerts: 'Alerts', organization: 'Organization', settings: 'Evaluators',
};

function NotFound() {
  return <Empty icon="search" title="Page not found" className="py-24" action={<Button href="#/dashboard">Go to dashboard</Button>}>That address doesn’t match anything in AgentEval.</Empty>;
}

function pageFor(section, id, query) {
  switch (section) {
    case '': case 'dashboard': return <Dashboard />;
    case 'agents': return id ? <AgentDetail key={id} id={id} /> : <AgentsPage />;
    case 'traces': return id ? <TraceDetail key={id} id={id} /> : <TracesPage key={query || 'all'} query={query} />;
    case 'debug': return id ? <DebugView key={id} id={id} /> : <NotFound />;
    case 'suites': return id ? <SuiteDetail key={id} id={id} /> : <SuitesPage />;
    case 'runs': return id ? <RunDetail key={id} id={id} /> : <RunsPage />;
    case 'monitoring': return <MonitoringPage key={`${id}${query}`} id={id} query={query} />;
    case 'alerts': return <AlertsPage key={id || 'list'} id={id} />;
    case 'organization': return <OrganizationPage />;
    case 'settings': return <SettingsPage />;
    default: return <NotFound />;
  }
}

function Router() {
  const [auth, setAuth] = useState(() => session.get());
  const [alertCount, setAlertCount] = useState({ active: 0, critical: 0 });
  const hash = useHash();

  useEffect(() => {
    const out = () => setAuth(null);
    window.addEventListener('agenteval:logout', out);
    return () => window.removeEventListener('agenteval:logout', out);
  }, []);

  useEffect(() => {   // alert badge: one cheap request every 30 s while the tab is visible
    if (!auth) return undefined;
    const poll = () => { if (!document.hidden) api('/alerts/summary').then(setAlertCount).catch(() => {}); };
    poll(); const t = setInterval(poll, 30_000);
    return () => clearInterval(t);
  }, [auth]);

  // Signed-in users land on the dashboard; signed-out visitors land on the welcome page.
  const home = !hash || hash === '#' || hash === '#/' || hash.startsWith('#/welcome');
  const [path, query] = (auth && home ? '#/dashboard' : hash).split('?');
  const [, rawSection = '', id] = path.split('/');
  const section = auth && rawSection === 'signin' ? 'dashboard' : rawSection;

  useEffect(() => {
    if (!auth && home) { document.title = 'AgentEval: trace, evaluate and monitor AI agents'; return; }
    const base = auth ? TITLES[section || 'dashboard'] : hash.startsWith('#/invite') ? 'Accept invitation' : hash.startsWith('#/reset') ? 'Reset password' : 'Sign in';
    document.title = base ? `${base} · AgentEval` : 'AgentEval';
  }, [auth, section, hash, home]);

  if (hash.startsWith('#/reset')) return <ResetPage />;
  if (hash.startsWith('#/invite')) return <InvitePage onAuthed={() => setAuth(session.get())} />;
  if (!auth && home) return <Landing />;
  if (!auth) return <AuthPage initialMode={query?.includes('mode=register') ? 'register' : 'login'} onAuthed={() => { window.location.hash = '#/dashboard'; setAuth(session.get()); }} />;

  return (
    <Shell auth={auth} section={section} routeKey={path} alertCount={alertCount}>
      <ErrorBoundary key={path}>
        {(!section || section === 'dashboard') && <Onboarding organizationId={auth.organizationId} />}
        <Suspense fallback={<LoadingBlock className="py-24" />}>{pageFor(section, id, query)}</Suspense>
      </ErrorBoundary>
    </Shell>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <FeedbackProvider><Router /></FeedbackProvider>
    </ErrorBoundary>
  );
}
