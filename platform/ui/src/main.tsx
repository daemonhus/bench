import React from 'react';
import ReactDOM from 'react-dom/client';
import '@bench/styles/reset.css';
import { PlatformShell } from './PlatformShell';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <PlatformShell />
  </React.StrictMode>,
);
