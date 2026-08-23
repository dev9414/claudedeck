/**
 * Renderer entry point: import the stylesheet layer once, then mount the shell.
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './theme/base.css';
import App from './App';

const host = document.getElementById('root');
if (!host) {
  // A programmer error, not a user-facing failure: index.html is ours.
  throw new Error('ClaudeDeck: #root is missing from index.html');
}

createRoot(host).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
