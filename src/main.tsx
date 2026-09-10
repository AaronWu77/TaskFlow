
import { createRoot } from 'react-dom/client';
import App from './app/App';
import './i18n';
import './styles/index.css';

createRoot(document.getElementById('root')!).render(<App />);

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js');
  });
}
