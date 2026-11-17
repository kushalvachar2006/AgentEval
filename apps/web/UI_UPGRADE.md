# UI/UX upgrade notes

No API calls, routes, data flows or business logic were changed. This is a presentation and interaction upgrade.

## What changed
- **Landing page** (`#/welcome`, shown to signed-out visitors): purpose, who it is for, how it works, expected outcomes. Sign-in lives at `#/signin` (`#/signin?mode=register` opens sign-up).
- **Design system**: semantic colour tokens in `src/index.css` (light and dark), IBM Plex Sans/Mono bundled locally (CSP-safe, no CDN), one component kit in `src/components/ui.jsx`.
- **Dark mode**: System / Light / Dark from the account menu. `public/theme-init.js` applies it before first paint (external file because the CSP forbids inline scripts).
- **App shell**: grouped sidebar, mobile drawer, account menu, skip link, per-route document titles, focus moved to content on navigation.
- **Interaction**: in-app confirm dialogs and toasts replace `window.confirm` and inline "Saved" text; create flows (agent, suite, evaluation, test case, import) are dialogs with focus trap and Esc to close.
- **Data display**: stat strips instead of card grids, themed charts with custom tooltips, status pills with dots, relative times, span tree with duration bars, segmented progress bars.
- **Robustness**: error boundary (app and per page), 404 page, skeleton loading, empty states with a next action, password show/hide.
- **Performance**: pages are lazy-loaded; entry JS fell from about 730 KB to about 210 KB (67 KB gzip) and charts load only where used.
- **Accessibility**: visible focus ring, labelled dialogs, tabs with arrow keys, `aria-current`, `prefers-reduced-motion` respected, status never conveyed by colour alone.

## Dependencies added
`@fontsource-variable/ibm-plex-sans`, `@fontsource/ibm-plex-mono` (self-hosted fonts). `package-lock.json` is updated; `npm ci` verified.

## Where to change things
- Colours / dark theme: `src/index.css` (variables) and `tailwind.config.js`.
- Landing copy: `src/pages/Landing.jsx` (arrays at the top of the file).
- Navigation: `NAV` in `src/components/Shell.jsx`.
