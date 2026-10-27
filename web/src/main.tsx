/// <reference types="vite/client" />
import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

// A file dropped anywhere a view does not take it would make the browser navigate to it. Views that accept files handle the drop first.
for (const type of ['dragover', 'drop'] as const) window.addEventListener(type, e => { if (e.dataTransfer?.types.includes('Files')) e.preventDefault(); });

// Makes Fleet installable as an app (Edge/Chrome: Install Fleet) and shows a "server not running" page when it is down.
// Built app only: under Vite's dev server it would sit in front of HMR.
if (import.meta.env.PROD && 'serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
