import App from './App';
import './index.scss';

const app = new App();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
