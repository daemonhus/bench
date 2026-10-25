import { useLayoutEffect, useMemo } from 'react';
import { setApiBase } from './core/api';
import { App } from './App';
import { useRepoStore } from './stores/repo-store';
import { WorkbenchExtensionsProvider, type WorkbenchExtensions } from './core/extensions';

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
  /** The project's REST root, '/api/projects/{slug}'. */
  apiBase: string;
  /** Container CSS class. */
  className?: string;
  /** Editor configuration - overrides CSS custom properties for the code viewer. */
  editorConfig?: EditorConfig;
  /** Host-supplied content for workbench pages (see core/extensions). */
  extensions?: WorkbenchExtensions;
}

const NO_EXTENSIONS: WorkbenchExtensions = {};

/**
 * Embeddable workbench component. Wraps the full App with API base URL injection.
 * Render as <WorkbenchView apiBase="/api/projects/project-slug" />.
 */
export function WorkbenchView({ apiBase, className, editorConfig, extensions }: WorkbenchProps) {
  // Another review branch: the pages start again on it.
  const branchEpoch = useRepoStore((s) => s.branchEpoch);
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
    <WorkbenchExtensionsProvider value={extensions ?? NO_EXTENSIONS}>
      <div className={className} style={style}>
        <App key={branchEpoch} />
      </div>
    </WorkbenchExtensionsProvider>
  );
}
