// apps/web — entrypoint. CAP-001 stub.
// Real router + providers land with later capabilities.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles/tokens.css';

const rootEl = document.getElementById('root');
if (!rootEl) {
  throw new Error('Root element #root missing from index.html');
}

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
