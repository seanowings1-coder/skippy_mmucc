import App from './App';
import './index.scss';

const app = new App();
// Exposed for manual testing from the browser DevTools console (e.g. hitting
// a session-gated proxy route directly with window.app.sessionToken) — not
// a new attack surface, this session already has full page access.
window.app = app;

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
