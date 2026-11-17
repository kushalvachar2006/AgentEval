// Runs before first paint so the page never flashes the wrong theme. Keep in sync with src/theme.js.
(function () {
  var pref = 'system';
  try { var v = localStorage.getItem('agenteval.theme'); if (v === 'light' || v === 'dark') pref = v; } catch (e) { /* storage blocked: follow the system */ }
  var dark = pref === 'dark' || (pref === 'system' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
})();
