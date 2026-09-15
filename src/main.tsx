
import { createRoot } from 'react-dom/client';
import App from './app/App';
import './i18n';
import './styles/index.css';

createRoot(document.getElementById('root')!).render(<App />);

// Capacitor already serves immutable bundled assets. Registering a service worker
// for the capacitor:// origin adds a second cache and can preserve stale bundles.
if (import.meta.env.PROD && window.location.protocol.startsWith('http') && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js');
  });
}
