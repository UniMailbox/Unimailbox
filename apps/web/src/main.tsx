import { getLanguage } from './infrastructure/i18n/locale';
import { initializeTheme } from './components/ThemeSwitch';
// apps/web — entrypoint. CAP-001 stub.
// Real router + providers land with later capabilities.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles/index.css';

const rootEl = document.getElementById('root');
if (!rootEl) {
  throw new Error('Root element #root missing from index.html');
}

initializeTheme();
document.documentElement.lang = getLanguage();

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
