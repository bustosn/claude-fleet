import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

// A file dropped anywhere a view does not take it would make the browser navigate to it. Views that accept files handle the drop first.
for (const type of ['dragover', 'drop'] as const) window.addEventListener(type, e => { if (e.dataTransfer?.types.includes('Files')) e.preventDefault(); });

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
