/// <reference types="vite/client" />
import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App.tsx';
import WebGate from './WebGate.tsx';
import './style.css';

// For what the stylesheet lays out differently by system: the window buttons' side of the title bar.
document.documentElement.dataset.platform = window.desktop?.platform ?? 'browser';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {!window.desktop && !import.meta.env.DEV ? <WebGate /> : <App />}
  </React.StrictMode>,
);
