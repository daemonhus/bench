import React, { useState, useEffect } from 'react';
import ReactDOM from 'react-dom/client';
import './styles/reset.css';
import { WorkbenchView, type EditorConfig } from './WorkbenchView';
import { settingsApi } from './core/api';

function StandaloneApp() {
  const [editorConfig, setEditorConfig] = useState<EditorConfig | undefined>();

  useEffect(() => {
    settingsApi.get()
      .then((s) => {
        if (s.editor) {
          try {
            const parsed = JSON.parse(s.editor);
            const cfg: EditorConfig = {};
            if (typeof parsed.fontSize === 'number') cfg.fontSize = parsed.fontSize;
            if (typeof parsed.tabSize === 'number') cfg.tabSize = parsed.tabSize;
            if (typeof parsed.wordWrap === 'boolean') cfg.wordWrap = parsed.wordWrap;
            if (Object.keys(cfg).length > 0) setEditorConfig(cfg);
          } catch {}
        }
      })
      .catch(() => {});
  }, []);

  return <WorkbenchView apiBase="" editorConfig={editorConfig} />;
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <StandaloneApp />
  </React.StrictMode>,
);
