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

// Inside the desktop app (desktop/) the title bar doubles as the window's, and the window buttons follow the theme.
const desktop = (window as { fleetDesktop?: { setTitleBar(color: string, symbolColor: string): void } }).fleetDesktop;
if (desktop) {
  document.documentElement.dataset.shell = 'desktop';
  const systemDark = matchMedia('(prefers-color-scheme: dark)');
  const sync = () => {
    const pinned = document.documentElement.dataset.theme;
    const dark = pinned ? pinned === 'dark' : systemDark.matches;
    desktop.setTitleBar(dark ? '#0e1114' : '#fefefd', dark ? '#eceef3' : '#13151a');
  };
  sync();
  systemDark.addEventListener('change', sync);
  new MutationObserver(sync).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
