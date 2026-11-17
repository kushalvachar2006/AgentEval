import { Component } from 'react';
import Icon from './Icon.jsx';
import { Button } from './ui.jsx';

// Catches render errors so one broken page never blanks the whole app. The shell keys it by route, so navigating away resets it.
export default class ErrorBoundary extends Component {
  state = { error: null };

  static getDerivedStateFromError(error) { return { error }; }

  componentDidCatch(error, info) { console.error('UI error:', error, info?.componentStack); }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div role="alert" className="mx-auto flex max-w-md flex-col items-center px-6 py-20 text-center">
        <span className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-danger-bg text-danger-fg"><Icon name="warning" size={22} /></span>
        <h1 className="text-xl font-semibold">Something went wrong</h1>
        <p className="mt-2 text-sm text-muted">This page hit an unexpected error. Reloading usually fixes it. If it keeps happening, tell your administrator what you were doing.</p>
        <div className="mt-5 flex gap-2">
          <Button onClick={() => window.location.reload()} icon="refresh">Reload page</Button>
          <Button variant="secondary" href="#/dashboard" onClick={() => this.setState({ error: null })}>Go to dashboard</Button>
        </div>
        <details className="mt-6 w-full text-left text-xs text-muted">
          <summary className="cursor-pointer text-center hover:text-ink">Technical details</summary>
          <pre className="mt-2 overflow-auto rounded-md bg-sunken p-3 font-mono">{String(error?.message || error)}</pre>
        </details>
      </div>
    );
  }
}
