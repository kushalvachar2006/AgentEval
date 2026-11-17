// Shared by the agent page and the evaluation-run page, so every command a user copies points at the DEPLOYED site
// (not at a local clone or localhost).

// Where the Python SDK sends data. Optional Netlify env VITE_API_URL = your API URL; otherwise this site's own origin
// is used (the /api proxy forwards it to the API).
export const apiUrl = (import.meta.env.VITE_API_URL || window.location.origin).replace(/\/$/, '');

// Where `pip` downloads the SDK from. Optional Netlify env VITE_SDK_REPO overrides it (for a fork).
export const repoUrl = import.meta.env.VITE_SDK_REPO || 'https://github.com/kushalvachar2006/AgentEval.git';

export const installCommand = (extra = '') => `pip install "agenteval${extra} @ git+${repoUrl}#subdirectory=sdk/python"`;

export const keyCommand = `# macOS / Linux
export AGENTEVAL_API_KEY="<PASTE YOUR KEY>"
# Windows PowerShell
$env:AGENTEVAL_API_KEY="<PASTE YOUR KEY>"`;
