import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { WorkbenchView, type EditorConfig } from '@bench/WorkbenchView';
import { useUIStore } from '@bench/stores/ui-store';
import { OverviewPage } from './OverviewPage';
import { HomePage } from './HomePage';
import { FeatureFlowsCard } from './FeatureFlowsCard';
import { SettingsPage } from './SettingsPage';
import { FlowsListPage, FlowDetailPage } from './flows';
import { ServiceMapPage } from './ServiceMap';
import { SearchPage, type SearchState } from './SearchPage';
import { parseSearch, searchPath } from './searchModel';
import { TabBarSearch } from './TabBarSearch';
import { ActivityPage } from './ActivityPage';
import { otherProjectsFor } from './otherProjects';
import { getSettings } from './api';
import './tokens.css';
import './platform.css';
import './bench-overrides.css';

// Settings isn't wired to enough yet to be worth showing: no rail button, and /settings lands on
// the home page. Flip this to bring the page back (it, and its API, are unchanged).
const SETTINGS_ENABLED = false;

type View =
  | { kind: 'home' }
  | { kind: 'projects' }
  | { kind: 'workbench'; slug: string }
  | { kind: 'settings' }
  | { kind: 'flows'; folder?: string }
  | { kind: 'map' }
  | { kind: 'activity' }
  | { kind: 'search'; search: SearchState }
  | { kind: 'flow'; id: string };

function parseView(): View {
  const path = window.location.pathname;
  if (path.startsWith('/p/')) {
    const slug = path.slice(3).replace(/\/.*$/, '');
    if (slug) return { kind: 'workbench', slug };
  }
  if (path.startsWith('/flows/')) {
    const id = path.slice(7).replace(/\/.*$/, '');
    if (id) return { kind: 'flow', id };
  }
  if (path === '/flows') {
    const folder = new URLSearchParams(window.location.search).get('folder') ?? '';
    return folder ? { kind: 'flows', folder } : { kind: 'flows' };
  }
  if (path === '/map') return { kind: 'map' };
  if (path === '/activity') return { kind: 'activity' };
  if (path === '/search') return { kind: 'search', search: parseSearch(window.location.search) };
  if (SETTINGS_ENABLED && path === '/settings') return { kind: 'settings' };
  if (path === '/projects') return { kind: 'projects' };
  return { kind: 'home' };
}

function viewToPath(view: View): string {
  if (view.kind === 'workbench') return `/p/${view.slug}`;
  if (view.kind === 'flow') return `/flows/${view.id}`;
  if (view.kind === 'flows') return view.folder ? `/flows?folder=${encodeURIComponent(view.folder)}` : '/flows';
  if (view.kind === 'map') return '/map';
  if (view.kind === 'activity') return '/activity';
  if (view.kind === 'search') return searchPath(view.search.q, view.search.kind, view.search.project);
  if (view.kind === 'settings') return '/settings';
  if (view.kind === 'projects') return '/projects';
  return '/';
}

function CogIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="8" cy="8" r="2.5" />
      <path d="M6.8 1.5h2.4l.3 1.8.9.4 1.6-.9 1.7 1.7-.9 1.6.4.9 1.8.3v2.4l-1.8.3-.4.9.9 1.6-1.7 1.7-1.6-.9-.9.4-.3 1.8H6.8l-.3-1.8-.9-.4-1.6.9-1.7-1.7.9-1.6-.4-.9-1.8-.3V6.8l1.8-.3.4-.9-.9-1.6L4 2.3l1.6.9.9-.4z" />
    </svg>
  );
}

function ActivityIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1.5 8.5h3l2-5 3 9 2-4h3" />
    </svg>
  );
}

function ProjectsIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="1.75" y="1.75" width="5.5" height="5.5" rx="1" />
      <rect x="8.75" y="1.75" width="5.5" height="5.5" rx="1" />
      <rect x="1.75" y="8.75" width="5.5" height="5.5" rx="1" />
      <rect x="8.75" y="8.75" width="5.5" height="5.5" rx="1" />
    </svg>
  );
}

function FlowsIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="3.25" cy="8" r="1.75" />
      <circle cx="12.75" cy="3.75" r="1.75" />
      <circle cx="12.75" cy="12.25" r="1.75" />
      <path d="M4.9 7.3 11.1 4.4M4.9 8.7l6.2 2.9" />
    </svg>
  );
}

function MapIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="1.75" y="2.25" width="4.5" height="4" rx="1" />
      <rect x="9.75" y="2.25" width="4.5" height="4" rx="1" />
      <rect x="5.75" y="9.75" width="4.5" height="4" rx="1" />
      <path d="M6.25 4.25h3.5M4 6.25v1.5c0 .8.6 1.5 1.5 1.5h.25M12 6.25v1.5c0 .8-.6 1.5-1.5 1.5h-.25" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M13.5 9.6A5.7 5.7 0 0 1 6.4 2.5a5.7 5.7 0 1 0 7.1 7.1z" />
    </svg>
  );
}

function SunIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="8" cy="8" r="3" />
      <path d="M8 1v2M8 13v2M1 8h2M13 8h2M3.2 3.2l1.4 1.4M11.4 11.4l1.4 1.4M3.2 12.8l1.4-1.4M11.4 4.6l1.4-1.4" />
    </svg>
  );
}

type Theme = 'dark' | 'light';

export function PlatformShell() {
  const [view, setView] = useState<View>(parseView);
  // A route that is turned off (e.g. /settings) shows the home page; put "/" in the address bar too.
  useEffect(() => {
    if (view.kind === 'home' && window.location.pathname !== '/') window.history.replaceState(null, '', '/');
  }, [view]);
  const savedHashes = useRef<Record<string, string>>({});
  const [editorConfig, setEditorConfig] = useState<EditorConfig | undefined>();
  // One theme setting, shared with the embedded workbench: both read and write the workbench's UI
  // store. (Two independent copies used to drift, so a toggle in one left the other stale and a
  // freshly mounted workbench snapped the page back to its old theme.)
  const theme: Theme = useUIStore((s) => s.theme);
  const toggleTheme = useUIStore((s) => s.toggleTheme);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  useEffect(() => {
    getSettings()
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

  // Restore the workbench hash from the URL on initial load
  if (view.kind === 'workbench' && window.location.hash) {
    savedHashes.current[view.slug] = window.location.hash;
  }

  const navigate = useCallback((next: View) => {
    // Save current workbench hash before leaving.
    if (view.kind === 'workbench') {
      savedHashes.current[view.slug] = window.location.hash;
    }
    // Build the new URL: path + optional hash.
    const path = viewToPath(next);
    const hash = next.kind === 'workbench' ? (savedHashes.current[next.slug] ?? '') : '';
    window.history.pushState(null, '', path + hash);
    setView(next);
  }, [view]);

  // Opening a project from the platform lands on its Overview; a deep link (a finding, a
  // feature, a filtered list) goes straight to its target instead.
  const openProject = useCallback((slug: string, hash?: string) => {
    savedHashes.current[slug] = hash || '#/overview';
    navigate({ kind: 'workbench', slug });
  }, [navigate]);

  // Links to other projects' features: search them, resolve them, open them there. One per
  // project, so the workbench's lookups don't rerun on every render of the shell.
  const openProjectRef = useRef(openProject);
  openProjectRef.current = openProject;
  const workbenchSlug = view.kind === 'workbench' ? view.slug : '';
  const otherProjects = useMemo(
    () => (workbenchSlug ? otherProjectsFor(workbenchSlug, (slug, hash) => openProjectRef.current(slug, hash)) : undefined),
    [workbenchSlug],
  );

  // After a route change the control that was clicked/activated is usually gone
  // (its page unmounted) and focus drops to <body>. Park it on the content
  // region so keyboard users continue from the new page, not from the top.
  const mainRef = useRef<HTMLElement>(null);
  const firstRoute = useRef(true);
  const routeKey = view.kind === 'workbench' ? `w:${view.slug}` : view.kind === 'flow' ? `f:${view.id}`
    : view.kind === 'flows' ? `flows:${view.folder ?? ''}` : view.kind;
  useEffect(() => {
    if (firstRoute.current) { firstRoute.current = false; return; }
    const id = requestAnimationFrame(() => {
      const a = document.activeElement;
      if (!a || a === document.body || !a.isConnected) mainRef.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(id);
  }, [routeKey]);

  // Handle browser back/forward.
  useEffect(() => {
    const onPopState = () => setView(parseView());
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  return (
    <div className="platform-shell">
      <nav className="platform-rail" aria-label="Sections">
        {/* The logo is Home: the Bench dashboard. */}
        <button
          type="button"
          className={`platform-rail-logo${view.kind === 'home' ? ' platform-rail-logo-active' : ''}`}
          title="Bench"
          aria-label="Bench"
          aria-current={view.kind === 'home' ? 'page' : undefined}
          onClick={() => navigate({ kind: 'home' })}
        >
          {/* The README's "| ▔▔▔ |" mark: two legs, the bench top between them. */}
          <svg width="22" height="22" viewBox="0 0 64 64" fill="currentColor" aria-hidden="true">
            <rect x="8" y="10" width="7" height="44" rx="1.5"/>
            <rect x="49" y="10" width="7" height="44" rx="1.5"/>
            <rect x="21" y="10" width="22" height="7" rx="1.5"/>
          </svg>
          <span className="platform-rail-label platform-rail-logo-label">Bench</span>
        </button>

        <div className="platform-rail-group">
          <button
            className={`platform-rail-btn${view.kind === 'activity' ? ' platform-rail-btn-active' : ''}`}
            title="Activity"
            aria-current={view.kind === 'activity' ? 'page' : undefined}
            onClick={() => navigate({ kind: 'activity' })}
          >
            <ActivityIcon />
            <span className="platform-rail-label">Activity</span>
          </button>
          <button
            className={`platform-rail-btn${view.kind === 'projects' || view.kind === 'workbench' ? ' platform-rail-btn-active' : ''}`}
            title="Projects"
            aria-current={view.kind === 'projects' || view.kind === 'workbench' ? 'page' : undefined}
            onClick={() => navigate({ kind: 'projects' })}
          >
            <ProjectsIcon />
            <span className="platform-rail-label">Projects</span>
          </button>
          <button
            className={`platform-rail-btn${view.kind === 'flows' || view.kind === 'flow' ? ' platform-rail-btn-active' : ''}`}
            title="Flows"
            aria-current={view.kind === 'flows' || view.kind === 'flow' ? 'page' : undefined}
            onClick={() => navigate({ kind: 'flows' })}
          >
            <FlowsIcon />
            <span className="platform-rail-label">Flows</span>
          </button>
          <button
            className={`platform-rail-btn${view.kind === 'map' ? ' platform-rail-btn-active' : ''}`}
            title="Service map"
            aria-current={view.kind === 'map' ? 'page' : undefined}
            onClick={() => navigate({ kind: 'map' })}
          >
            <MapIcon />
            <span className="platform-rail-label">Map</span>
          </button>
        </div>

        <div className="platform-rail-group platform-rail-group-end">
          <button
            className="platform-rail-btn"
            title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            onClick={toggleTheme}
          >
            {theme === 'dark' ? <MoonIcon /> : <SunIcon />}
            <span className="platform-rail-label">{theme === 'dark' ? 'Dark' : 'Light'}</span>
          </button>
          {SETTINGS_ENABLED && <button
            className={`platform-rail-btn${view.kind === 'settings' ? ' platform-rail-btn-active' : ''}`}
            title="Settings"
            aria-current={view.kind === 'settings' ? 'page' : undefined}
            onClick={() => navigate({ kind: 'settings' })}
          >
            <CogIcon />
            <span className="platform-rail-label">Settings</span>
          </button>}
        </div>
      </nav>
      {/* The embedded workbench brings its own banner and <main>; nesting a second
          <main> around it is invalid, so that route gets a plain container. */}
      <PageRegion as={view.kind === 'workbench' ? 'div' : 'main'} refObj={mainRef}>
        {view.kind !== 'workbench' && <h1 className="sr-only">{pageTitle(view)}</h1>}
        {view.kind === 'home' && (
          <HomePage
            onOpenProject={openProject}
            onOpenFlow={(id) => navigate({ kind: 'flow', id })}
            onOpenProjects={() => navigate({ kind: 'projects' })}
            onSearch={(q, kind) => navigate({ kind: 'search', search: { q, kind } })}
          />
        )}
        {view.kind === 'projects' && (
          <OverviewPage
            onSelect={(slug) => openProject(slug)}
            onOpen={openProject}
          />
        )}
        {view.kind === 'workbench' && (
          <WorkbenchView
            // One workbench per project: the tab bar's search can open another project from here.
            key={view.slug}
            apiBase={`/api/projects/${view.slug}`}
            className="platform-workbench"
            editorConfig={editorConfig}
            extensions={{
              otherProjects,
              featureDetailAside: (featureId) => (
                <FeatureFlowsCard projectSlug={view.slug} featureId={featureId} onOpenFlow={(id) => navigate({ kind: 'flow', id })} />
              ),
              tabBarSearch: (
                <TabBarSearch
                  // A hit in this project moves the workbench by its hash; another project opens.
                  onOpen={(slug, hash) => {
                    if (slug === view.slug) window.location.hash = hash || '#/overview';
                    else openProject(slug, hash);
                  }}
                  onSearch={(q, kind) => navigate({ kind: 'search', search: { q, kind } })}
                />
              ),
            }}
          />
        )}
        {view.kind === 'flows' && (
          <FlowsListPage
            folderId={view.folder ?? ''}
            onOpen={(id) => navigate({ kind: 'flow', id })}
            onOpenFolder={(folder) => navigate(folder ? { kind: 'flows', folder } : { kind: 'flows' })}
          />
        )}
        {view.kind === 'flow' && (
          <FlowDetailPage
            flowId={view.id}
            onBack={(folder) => navigate(folder ? { kind: 'flows', folder } : { kind: 'flows' })}
            onOpenProject={openProject}
          />
        )}
        {view.kind === 'activity' && (
          <ActivityPage onOpen={openProject} onOpenFlow={(id) => navigate({ kind: 'flow', id })} />
        )}
        {view.kind === 'map' && (
          <ServiceMapPage onOpenFlow={(id) => navigate({ kind: 'flow', id })} onOpenProject={openProject} />
        )}
        {view.kind === 'search' && (
          <SearchPage
            state={view.search}
            onChange={(search, opts) => {
              const next: View = { kind: 'search', search };
              // Typing follows in the address without filling the history; a filter is a step back.
              if (opts?.replace) { window.history.replaceState(null, '', viewToPath(next)); setView(next); }
              else navigate(next);
            }}
            onOpen={openProject}
            onOpenFlow={(id) => navigate({ kind: 'flow', id })}
          />
        )}
        {view.kind === 'settings' && <SettingsPage />}
      </PageRegion>
    </div>
  );
}

function pageTitle(view: View): string {
  switch (view.kind) {
    case 'home': return 'Bench';
    case 'projects': return 'Projects';
    case 'flows': return 'Flows';
    case 'flow': return 'Flow';
    case 'map': return 'Service map';
    case 'activity': return 'Activity';
    case 'search': return 'Search';
    case 'settings': return 'Settings';
    default: return 'Bench';
  }
}

/** The content region: <main> normally, a plain <div> when the page supplies its own landmarks. */
function PageRegion({ as: Tag, refObj, children }: { as: 'main' | 'div'; refObj: React.RefObject<HTMLElement>; children: React.ReactNode }) {
  return (
    <Tag className="platform-main" ref={refObj as React.RefObject<HTMLDivElement>} tabIndex={-1}>
      {children}
    </Tag>
  );
}
