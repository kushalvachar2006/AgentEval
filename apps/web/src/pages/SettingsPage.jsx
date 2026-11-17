import { useEffect, useState } from 'react';
import { api, session } from '../api.js';
import { useToast } from '../components/feedback.jsx';
import { Button, Card, ErrorBox, Field, Input, PageHeader, PasswordInput, Select, Switch } from '../components/ui.jsx';

export default function SettingsPage() {
  const toast = useToast();
  const [form, setForm] = useState({ enabled: false, provider: 'openai_compatible', model: '', baseUrl: '', apiKey: '', temperature: '' });
  const [hasKey, setHasKey] = useState(false);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const org = session.get();

  useEffect(() => {
    api('/evaluator-config').then(({ judge }) => {
      setHasKey(judge.hasApiKey);
      setForm({ enabled: judge.enabled, provider: judge.provider || 'openai_compatible', model: judge.model, baseUrl: judge.baseUrl, apiKey: '', temperature: judge.temperature ?? '' });
    }).catch(setError);
  }, []);

  async function save(e, extra = {}) {
    e?.preventDefault(); setError(null); setBusy(true);
    const judge = { enabled: form.enabled, provider: form.provider, model: form.model, ...(form.baseUrl && { baseUrl: form.baseUrl }), ...(form.apiKey && { apiKey: form.apiKey }), ...(form.temperature !== '' && { temperature: Number(form.temperature) }), ...extra };
    try {
      const r = await api('/evaluator-config', { method: 'PUT', body: { judge } });
      setHasKey(r.judge.hasApiKey); setForm((f) => ({ ...f, apiKey: '' })); toast(extra.clearApiKey ? 'Saved key removed' : 'Evaluator settings saved');
    } catch (err) { setError(err); } finally { setBusy(false); }
  }

  return (
    <div className="space-y-6">
      <PageHeader title="Evaluators" description="Control how answers are scored. Only organization admins can change these settings." />
      <Card title="AI judge (optional)" description="Without a judge, AgentEval still scores answers using rules, reference comparison and evidence matching. A judge adds fuzzy checks such as paraphrase matching.">
        <form onSubmit={save} className="space-y-5">
          <Switch checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} label="Enable the judge for my organization" description="Works with any OpenAI-compatible endpoint (OpenAI, Ollama, vLLM, gateways) or Anthropic. The key is stored encrypted and never shown again." />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Provider"><Select value={form.provider} onChange={(e) => setForm({ ...form, provider: e.target.value })}><option value="openai_compatible">OpenAI-compatible</option><option value="anthropic">Anthropic</option></Select></Field>
            <Field label="Model name"><Input value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} placeholder="The model id from your provider" /></Field>
            <Field label="Base URL (optional)"><Input value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} placeholder={form.provider === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1'} /></Field>
            <Field label={hasKey ? 'API key (saved, type to replace)' : 'API key'}><PasswordInput value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} autoComplete="off" placeholder={hasKey ? '••••••••••••' : ''} /></Field>
            <Field label="Temperature (optional)" hint="Leave empty if your model rejects it."><Input type="number" step="0.1" min="0" max="2" value={form.temperature} onChange={(e) => setForm({ ...form, temperature: e.target.value })} /></Field>
          </div>
          <ErrorBox error={error} />
          <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
            <Button type="submit" loading={busy}>Save changes</Button>
            {hasKey && <Button variant="danger" onClick={() => save(null, { clearApiKey: true })}>Remove saved key</Button>}
            <span className="ml-auto text-xs text-muted">Organization: {org?.organizationName}</span>
          </div>
        </form>
      </Card>
    </div>
  );
}
