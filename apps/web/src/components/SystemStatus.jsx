import { useCallback, useEffect, useState } from 'react';
import { Button, Pill } from './ui.jsx';

export default function SystemStatus() {
  const [api, setApi] = useState('checking');
  const [mongo, setMongo] = useState('checking');
  const check = useCallback(async () => {
    setApi('checking'); setMongo('checking');
    try {
      const h = await fetch('/api/v1/health');
      if (!h.ok) throw new Error();
      setApi('up');
      setMongo((await (await fetch('/api/v1/health/ready')).json()).dependencies?.mongo ?? 'down');
    } catch { setApi('down'); setMongo('down'); }
  }, []);
  useEffect(() => { check(); }, [check]);
  const problem = api === 'down' || mongo === 'down';
  return (
    <section aria-label="System status" className="rounded-lg border border-line bg-surface px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-medium">System status</h2>
        <Button variant="ghost" size="xs" icon="refresh" onClick={check}>Re-check</Button>
      </div>
      <ul className="mt-2 space-y-1.5 text-sm">
        <li className="flex items-center justify-between"><span className="text-muted">API server</span><Pill>{api}</Pill></li>
        <li className="flex items-center justify-between"><span className="text-muted">MongoDB</span><Pill>{mongo}</Pill></li>
      </ul>
      {problem && <p className="mt-3 text-xs text-muted">Can’t reach everything yet. Make sure the server and database are running, then re-check.</p>}
    </section>
  );
}
