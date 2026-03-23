import { useLayoutEffect, useMemo } from 'react';
import { setApiBase } from './core/api';
import { App } from './App';
import type { Route } from './core/router';

/** Editor configuration that affects the code viewer. */
export interface EditorConfig {
  /** Code font size in pixels. Default: 13 */
  fontSize?: number;
  /** Tab width in spaces. Default: 4 */
  tabSize?: number;
  /** Wrap long lines instead of horizontal scroll. Default: false */
  wordWrap?: boolean;
}

export interface WorkbenchProps {
  /** API base URL. Empty string for standalone, '/api/p/slug' for platform. */
  apiBase: string;
  /** Optional initial route — overrides hash parsing on mount. */
  initialRoute?: Route;
  /** Container CSS class. */
  className?: string;
  /** Editor configuration — overrides CSS custom properties for the code viewer. */
  editorConfig?: EditorConfig;
}

/**
 * Embeddable workbench component. Wraps the full App with API base URL injection.
 * In standalone mode, render as <WorkbenchView apiBase="" />.
 * In platform mode, render as <WorkbenchView apiBase="/api/p/project-slug" />.
 */
export function WorkbenchView({ apiBase, className, editorConfig }: WorkbenchProps) {
  // useLayoutEffect fires before any regular useEffect (including App's
  // data-loading effects), so apiBase is always set before fetches start.
  // This also survives StrictMode's mount→cleanup→mount cycle.
  useLayoutEffect(() => {
    setApiBase(apiBase);
    return () => setApiBase('');
  }, [apiBase]);

  const style = useMemo(() => {
    if (!editorConfig) return undefined;
    const vars: Record<string, string> = {};
    if (editorConfig.fontSize != null) {
      vars['--font-size-code'] = `${editorConfig.fontSize}px`;
      // Scale line height to 1.54x font size (20px at 13px default)
      vars['--line-height'] = `${Math.round(editorConfig.fontSize * 1.54)}px`;
    }
    if (editorConfig.tabSize != null) {
      vars['--tab-size'] = String(editorConfig.tabSize);
    }
    if (editorConfig.wordWrap != null) {
      vars['--code-white-space'] = editorConfig.wordWrap ? 'pre-wrap' : 'pre';
      vars['--code-word-break'] = editorConfig.wordWrap ? 'break-all' : 'normal';
    }
    return Object.keys(vars).length > 0 ? vars as React.CSSProperties : undefined;
  }, [editorConfig]);

  return (
    <div className={className} style={style}>
      <App />
    </div>
  );
}
