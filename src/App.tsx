import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { useBreakpoint } from './hooks/useBreakpoint';
import { useRepoStore } from './stores/repo-store';
import { useDiffStore } from './stores/diff-store';
import { useAnnotationStore } from './stores/annotation-store';
import { useUIStore } from './stores/ui-store';
import { useNavigationStore } from './stores/navigation-store';
import { useReconcileStore } from './stores/reconcile-store';
import { useBaselineStore } from './stores/baseline-store';
import { findingsApi, commentsApi, gitApi, reconcileApi, featuresApi } from './core/api';
import { useEvents } from './core/use-events';
import { useBranchMap } from './core/use-branch-map';
import { parseRoute, buildRoute, onRouteChange } from './core/router';
import { BrowseView } from './components/BrowseView';
import { DiffView } from './components/DiffView';
import { FileTree, type SeverityIndicator } from './components/FileTree';
import { Sidebar } from './components/Sidebar';
import { ConnectorOverlay } from './components/ConnectorOverlay';
import { GitTreePanel } from './components/GitTreePanel';
import { FileSearchModal } from './components/FileSearchModal';
import { ContentSearchModal } from './components/ContentSearchModal';
import { InFileSearchBar } from './components/InFileSearchBar';
import { DeltaView } from './components/DeltaView';
import { DeltaSidebar } from './components/DeltaSidebar';
import { FindingsView } from './components/FindingsView';
import { FeaturesView } from './components/FeaturesView';
import { FolderView } from './components/FolderView';
import { KeyboardShortcutsModal } from './components/KeyboardShortcutsModal';
import type { ViewMode, Severity, FindingStatus, CommentType, Finding, Feature } from './core/types';
import { COMMENT_TYPE_ICON, COMMENT_TYPE_LABEL } from './core/types';
import { getDiffEmptyMessage } from './core/diff-utils';
import './App.css';

export function App() {
  const repoName = useRepoStore((s) => s.repoName);
  const commits = useRepoStore((s) => s.commits);
  const branches = useRepoStore((s) => s.branches);
  const currentCommit = useRepoStore((s) => s.currentCommit);
  const files = useRepoStore((s) => s.files);
  const selectedFilePath = useRepoStore((s) => s.selectedFilePath);
  const fileContent = useRepoStore((s) => s.fileContent);
  const isLoading = useRepoStore((s) => s.isLoading);
  const error = useRepoStore((s) => s.error);
  const loadCommits = useRepoStore((s) => s.loadCommits);
  const refreshGitData = useRepoStore((s) => s.refreshGitData);
  const selectCommit = useRepoStore((s) => s.selectCommit);
  const selectFile = useRepoStore((s) => s.selectFile);

  const loadDiffFromApi = useDiffStore((s) => s.loadDiffFromApi);
  const clearDiff = useDiffStore((s) => s.clear);
  const changes = useDiffStore((s) => s.changes);

  const loadFindings = useAnnotationStore((s) => s.loadFindings);
  const loadComments = useAnnotationStore((s) => s.loadComments);
  const loadFeatures = useAnnotationStore((s) => s.loadFeatures);
  const addFinding = useAnnotationStore((s) => s.addFinding);
  const addComment = useAnnotationStore((s) => s.addComment);
  // Project-level findings for file tree severity indicators
  const [allFindings, setAllFindings] = useState<Finding[]>([]);

  const bp = useBreakpoint();
  const isMobile = bp === 'mobile';

  const viewMode = useUIStore((s) => s.viewMode);
  const setViewMode = useUIStore((s) => s.setViewMode);
  const sidebarOpen = useUIStore((s) => s.sidebarOpen);
  const sidebarWidth = useUIStore((s) => s.sidebarWidth);
  const setSidebarWidth = useUIStore((s) => s.setSidebarWidth);
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);
  const leftPanelOpen = useUIStore((s) => s.leftPanelOpen);
  const leftPanelWidth = useUIStore((s) => s.leftPanelWidth);
  const setLeftPanelWidth = useUIStore((s) => s.setLeftPanelWidth);
  const toggleLeftPanel = useUIStore((s) => s.toggleLeftPanel);
  const annotationAction = useUIStore((s) => s.annotationAction);
  const setAnnotationAction = useUIStore((s) => s.setAnnotationAction);
  const commentDrag = useUIStore((s) => s.commentDrag);

  // Reconciliation
  const reconciledHead = useReconcileStore((s) => s.head);
  const fetchReconciledHead = useReconcileStore((s) => s.fetchHead);
  const startReconcile = useReconcileStore((s) => s.startReconcile);
  const activeJob = useReconcileStore((s) => s.activeJob);

  // Navigation history
  const pushFile = useNavigationStore((s) => s.pushFile);
  const goBack = useNavigationStore((s) => s.goBack);
  const goForward = useNavigationStore((s) => s.goForward);
  const clearNavHistory = useNavigationStore((s) => s.clear);
  const navHistory = useNavigationStore((s) => s.history);
  const navIndex = useNavigationStore((s) => s.currentIndex);
  const canGoBack = navIndex > 0;
  const canGoForward = navIndex < navHistory.length - 1;
  const isHistoryNav = useRef(false);

  // Diff mode: compare between two commits
  const [compareFrom, setCompareFrom] = useState<string>('');
  const [compareTo, setCompareTo] = useState<string>('');
  const [diffLoading, setDiffLoading] = useState(false);

  // Delta view: optional specific baseline ID
  const [routeBaselineId, setRouteBaselineId] = useState<string | undefined>(undefined);

  // Delta sidebar
  const [deltaSidebarOpen, setDeltaSidebarOpen] = useState(true);
  const [deltaSidebarWidth, setDeltaSidebarWidth] = useState(300);
  const deltaResizingRef = useRef(false);

  // Git tree panel
  const [gitTreeOpen, setGitTreeOpen] = useState(false);
  const [diffSelectTarget, setDiffSelectTarget] = useState<'from' | 'to' | null>(null);
  const [fileSearchOpen, setFileSearchOpen] = useState(false);
  const [contentSearchOpen, setContentSearchOpen] = useState(false);
  const [contentSearchInitialQuery, setContentSearchInitialQuery] = useState('');
  const [inFileSearchOpen, setInFileSearchOpen] = useState(false);
  const [inFileSearchInitialQuery, setInFileSearchInitialQuery] = useState('');
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [browseDir, setBrowseDir] = useState<string | null>(null);
  const [diffFiles, setDiffFiles] = useState<string[] | null>(null);

  // Quick-add finding/comment popover
  type QuickAddTarget = { kind: 'finding' | 'comment' | 'feature'; scope: 'project' | 'file'; lineRange?: { start: number; end: number } } | null;
  const [quickAdd, setQuickAdd] = useState<QuickAddTarget>(null);
  const [quickTitle, setQuickTitle] = useState('');
  const [quickText, setQuickText] = useState('');
  const [quickSeverity, setQuickSeverity] = useState<Severity>('medium');
  const [quickStatus, setQuickStatus] = useState<FindingStatus>('open');
  const [quickCwe, setQuickCwe] = useState('');
  const [quickCve, setQuickCve] = useState('');
  const [quickScore, setQuickScore] = useState('');
  const [quickCategory, setQuickCategory] = useState('');
  const [quickCommentType, setQuickCommentType] = useState<CommentType>('');
  const [quickConfirmDiscard, setQuickConfirmDiscard] = useState(false);
  const quickRef = useRef<HTMLDivElement>(null);

  // Watch for finding-create requests from child components (e.g. feed pill)
  const requestFindingCreate = useUIStore((s) => s.requestFindingCreate);
  useEffect(() => {
    if (requestFindingCreate) {
      useUIStore.getState().setRequestFindingCreate(false);
      setQuickAdd({ kind: 'finding', scope: 'project' });
      setQuickTitle(''); setQuickText(''); setQuickConfirmDiscard(false);
    }
  }, [requestFindingCreate]);

  // Track whether initial route has been applied
  const initialRouteApplied = useRef(false);
  const initialCommitApplied = useRef(false);
  const prevJobStatus = useRef<string | null>(null);
  // Set to true when updating app state in response to a browser back/forward event,
  // so updateRoute uses replaceState instead of pushState (avoids duplicate history entries).
  const isHandlingHashChange = useRef(false);

  // Sidebar resize
  const resizingRef = useRef(false);

  const handleResizeMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      resizingRef.current = true;
      const onMouseMove = (ev: MouseEvent) => {
        if (!resizingRef.current) return;
        const newWidth = Math.max(200, Math.min(800, window.innerWidth - ev.clientX));
        setSidebarWidth(newWidth);
      };
      const onMouseUp = () => {
        resizingRef.current = false;
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      };
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    },
    [setSidebarWidth],
  );

  // Left panel resize
  const leftResizingRef = useRef(false);

  const handleLeftPanelResizeMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      leftResizingRef.current = true;
      const onMouseMove = (ev: MouseEvent) => {
        if (!leftResizingRef.current) return;
        const newWidth = Math.max(180, Math.min(500, ev.clientX));
        setLeftPanelWidth(newWidth);
      };
      const onMouseUp = () => {
        leftResizingRef.current = false;
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      };
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    },
    [setLeftPanelWidth],
  );

  // Delta sidebar resize
  const handleDeltaSidebarResizeMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      deltaResizingRef.current = true;
      const onMouseMove = (ev: MouseEvent) => {
        if (!deltaResizingRef.current) return;
        const newWidth = Math.max(200, Math.min(600, window.innerWidth - ev.clientX));
        setDeltaSidebarWidth(newWidth);
      };
      const onMouseUp = () => {
        deltaResizingRef.current = false;
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      };
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    },
    [],
  );

  // Auto-close panels when switching to mobile
  useEffect(() => {
    if (isMobile) {
      if (leftPanelOpen) toggleLeftPanel();
      if (sidebarOpen) toggleSidebar();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMobile]);

  // On mobile, line-anchored annotation actions open the quick-add modal instead of sidebar
  useEffect(() => {
    if (!isMobile || annotationAction === null) return;
    const lineRange =
      commentDrag.startLine !== null && commentDrag.endLine !== null
        ? { start: commentDrag.startLine, end: commentDrag.endLine }
        : undefined;
    setQuickAdd({ kind: annotationAction, scope: 'file', lineRange });
    setQuickTitle(''); setQuickText(''); setQuickConfirmDiscard(false);
    setAnnotationAction(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMobile, annotationAction]);

  // File selection wrapper: pushes to navigation history
  const handleSelectFile = useCallback(
    (path: string) => {
      setBrowseDir(null);
      if (!isHistoryNav.current) {
        pushFile(path);
      }
      isHistoryNav.current = false;
      selectFile(path);
    },
    [selectFile, pushFile],
  );

  // Back/forward handlers
  const handleGoBack = useCallback(() => {
    const path = goBack();
    if (path) {
      isHistoryNav.current = true;
      selectFile(path);
    }
  }, [goBack, selectFile]);

  const handleGoForward = useCallback(() => {
    const path = goForward();
    if (path) {
      isHistoryNav.current = true;
      selectFile(path);
    }
  }, [goForward, selectFile]);

  // Commit change: clear nav history
  const handleCommitChange = useCallback(
    (hash: string) => {
      clearNavHistory();
      selectCommit(hash);
      setGitTreeOpen(false);
    },
    [selectCommit, clearNavHistory],
  );

  // Quick-add submit
  const handleQuickAddSubmit = useCallback(() => {
    if (!quickAdd) return;
    const fileId = quickAdd.scope === 'file' || quickAdd.lineRange ? (selectedFilePath ?? '') : '';
    const commitId = currentCommit ?? '';
    const anchor = quickAdd.lineRange
      ? { fileId, commitId, lineRange: quickAdd.lineRange }
      : { fileId, commitId };

    if (quickAdd.kind === 'finding') {
      const trimmed = quickTitle.trim();
      if (!trimmed) return;
      addFinding({
        id: `FND-${Date.now()}`,
        anchor,
        severity: quickSeverity,
        status: quickStatus,
        title: trimmed,
        description: quickText.trim(),
        cwe: quickCwe.trim(),
        cve: quickCve.trim(),
        vector: '',
        score: quickScore !== '' ? parseFloat(quickScore) : 0,
        category: quickCategory.trim() || undefined,
        source: 'manual',
      });
    } else {
      const trimmed = quickText.trim();
      if (!trimmed) return;
      addComment({
        id: `CMT-${Date.now()}`,
        anchor,
        author: 'you',
        text: trimmed,
        commentType: quickCommentType || undefined,
        timestamp: new Date().toISOString(),
        threadId: `T-${Date.now()}`,
      });
    }
    setQuickAdd(null);
    setQuickTitle(''); setQuickText('');
    setQuickSeverity('medium'); setQuickStatus('open');
    setQuickCwe(''); setQuickCve(''); setQuickScore(''); setQuickCategory('');
    setQuickCommentType('');
  }, [quickAdd, quickTitle, quickText, quickSeverity, quickStatus, quickCwe, quickCve, quickScore, quickCategory, quickCommentType, selectedFilePath, currentCommit, addFinding, addComment]);

  // Cancel quick-add: confirm if there's unsaved input
  const handleQuickAddCancel = useCallback(() => {
    const hasDirtyInput = quickTitle.trim() !== '' || quickText.trim() !== '';
    if (hasDirtyInput && !quickConfirmDiscard) {
      setQuickConfirmDiscard(true);
      return;
    }
    setQuickAdd(null);
    setQuickTitle(''); setQuickText('');
    setQuickSeverity('medium'); setQuickStatus('open');
    setQuickCwe(''); setQuickCve(''); setQuickScore(''); setQuickCategory('');
    setQuickCommentType('');
    setQuickConfirmDiscard(false);
  }, [quickTitle, quickText, quickConfirmDiscard]);

  // Close quick-add on click outside
  useEffect(() => {
    if (!quickAdd) return;
    const handler = (e: MouseEvent) => {
      if (quickRef.current && !quickRef.current.contains(e.target as Node)) {
        handleQuickAddCancel();
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [quickAdd, handleQuickAddCancel]);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      const inEditable = tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement)?.isContentEditable;
      if (!inEditable && (e.altKey && e.key === 'ArrowLeft' || (e.metaKey || e.ctrlKey) && e.key === '[')) {
        e.preventDefault();
        handleGoBack();
      } else if (!inEditable && (e.altKey && e.key === 'ArrowRight' || (e.metaKey || e.ctrlKey) && e.key === ']')) {
        e.preventDefault();
        handleGoForward();
      } else if ((e.metaKey || e.ctrlKey) && e.key === 'g') {
        e.preventDefault();
        setFileSearchOpen(true);
      } else if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'f') {
        e.preventDefault();
        setContentSearchInitialQuery(window.getSelection()?.toString().trim() ?? '');
        setContentSearchOpen(true);
      } else if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault();
        const selected = window.getSelection()?.toString().trim() ?? '';
        setInFileSearchInitialQuery(selected);
        setInFileSearchOpen(true);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [handleGoBack, handleGoForward]);

  // Close in-file search when file or view changes
  useEffect(() => {
    setInFileSearchOpen(false);
    setInFileSearchInitialQuery('');
  }, [selectedFilePath, viewMode]);

  // Load commits + reconciled HEAD + review state on mount
  useEffect(() => {
    loadCommits();
    fetchReconciledHead();
    useBaselineStore.getState().refreshAll();
  }, [loadCommits, fetchReconciledHead]);

  // Apply initial route after commits are loaded
  useEffect(() => {
    if (initialRouteApplied.current || commits.length === 0) return;
    initialRouteApplied.current = true;

    const route = parseRoute(window.location.hash);
    setViewMode(route.mode);
    if (route.mode === 'diff' && route.from && route.to) {
      setCompareFrom(route.from);
      setCompareTo(route.to);
    }
    if (route.mode === 'delta') {
      setRouteBaselineId(route.baselineId);
    }
    if (route.path) {
      handleSelectFile(route.path);
    }
  }, [commits, setViewMode, handleSelectFile]);

  // Listen for hash changes
  useEffect(() => {
    return onRouteChange((route) => {
      isHandlingHashChange.current = true;
      setViewMode(route.mode);
      if (route.mode === 'diff' && route.from && route.to) {
        setCompareFrom(route.from);
        setCompareTo(route.to);
      }
      if (route.mode === 'delta') {
        setRouteBaselineId(route.baselineId);
      } else {
        setRouteBaselineId(undefined);
      }
      if (route.path) {
        handleSelectFile(route.path);
      }
    });
  }, [setViewMode, handleSelectFile]);

  // Update hash when user changes mode/file
  const updateRoute = useCallback(
    (mode: ViewMode, from?: string, to?: string, path?: string) => {
      const newHash = buildRoute(mode as Parameters<typeof buildRoute>[0], from, to, path);
      if (window.location.hash !== newHash) {
        if (isHandlingHashChange.current) {
          window.history.replaceState(null, '', newHash);
        } else {
          window.history.pushState(null, '', newHash);
        }
      }
      isHandlingHashChange.current = false;
    },
    [],
  );

  // Sync route when viewMode, file, or compare commits change
  useEffect(() => {
    if (!initialRouteApplied.current) return;
    updateRoute(
      viewMode,
      viewMode === 'diff' ? compareFrom : undefined,
      viewMode === 'diff' ? compareTo : undefined,
      selectedFilePath ?? undefined,
    );
  }, [viewMode, compareFrom, compareTo, selectedFilePath, updateRoute]);

  // Clear selected file when entering directory view so annotations don't persist
  useEffect(() => {
    if (browseDir !== null) {
      useRepoStore.setState({ selectedFilePath: null, fileContent: null, fileLanguage: null });
    }
  }, [browseDir]);

  // Load annotations when file changes (pass commit for position enrichment)
  useEffect(() => {
    if (!selectedFilePath) {
      loadFindings([]);
      loadComments([]);
      loadFeatures([]);
      return;
    }
    const commit = currentCommit ?? undefined;
    findingsApi.list(selectedFilePath, commit).then(loadFindings).catch(() => loadFindings([]));
    commentsApi.list(selectedFilePath, commit).then(loadComments).catch(() => loadComments([]));
    featuresApi.list(selectedFilePath, undefined, undefined, commit).then((f) => loadFeatures(f as Feature[])).catch(() => loadFeatures([]));
  }, [selectedFilePath, currentCommit, loadFindings, loadComments, loadFeatures]);

  // Load all findings for file tree severity dots.
  useEffect(() => {
    findingsApi.list().then(setAllFindings).catch(() => setAllFindings([]));
  }, [currentCommit]);

  const findingSeverityMap = useMemo(() => {
    const map = new Map<string, SeverityIndicator>();
    const ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
    const OPEN = new Set(['draft', 'open', 'in-progress']);
    for (const f of allFindings) {
      const path = f.anchor.fileId;
      if (!path) continue;
      const existing = map.get(path);
      const isOpen = OPEN.has(f.status);
      if (!existing ||
          ORDER[f.severity] < ORDER[existing.severity] ||
          (ORDER[f.severity] === ORDER[existing.severity] && isOpen && !existing.isOpen)) {
        map.set(path, { severity: f.severity as Severity, isOpen });
      }
    }
    return map;
  }, [allFindings]);

  // Trigger background reconciliation when switching commits (once per commit)
  const reconciledForCommit = useRef<string | null>(null);
  useEffect(() => {
    if (!currentCommit) return;
    if (reconciledForCommit.current === currentCommit) return;
    if (reconciledHead && !reconciledHead.isFullyReconciled) {
      reconciledForCommit.current = currentCommit;
      startReconcile(currentCommit);
    }
  }, [currentCommit, reconciledHead, startReconcile]);

  // Re-fetch annotations when reconciliation job completes (live transition)
  useEffect(() => {
    if (!activeJob) return;
    const prev = prevJobStatus.current;
    prevJobStatus.current = activeJob.status;
    if (activeJob.status === 'done' && prev !== 'done') {
      if (selectedFilePath) {
        const commit = currentCommit ?? undefined;
        findingsApi.list(selectedFilePath, commit).then(loadFindings).catch(() => loadFindings([]));
        commentsApi.list(selectedFilePath, commit).then(loadComments).catch(() => loadComments([]));
        featuresApi.list(selectedFilePath, undefined, undefined, commit).then((f) => loadFeatures(f as Feature[])).catch(() => {});
      }
    }
  }, [activeJob, selectedFilePath, currentCommit, loadFindings, loadComments, loadFeatures]);

  // SSE-driven refresh: annotations and git data
  const refreshAnnotations = useCallback(() => {
    if (document.hidden) return;
    if (useUIStore.getState().viewMode === 'delta') return;
    const file = useRepoStore.getState().selectedFilePath;
    const commit = useRepoStore.getState().currentCommit ?? undefined;
    if (file) {
      findingsApi.list(file, commit).then(loadFindings).catch(() => {});
      commentsApi.list(file, commit).then(loadComments).catch(() => {});
      featuresApi.list(file, undefined, undefined, commit).then((f) => loadFeatures(f as Feature[])).catch(() => {});
    }
    findingsApi.list().then(setAllFindings).catch(() => {});
  }, [loadFindings, loadComments, loadFeatures]);

  useEvents('annotations', refreshAnnotations);
  useEvents('git', refreshGitData);

  // Default to reconciled HEAD on first load
  useEffect(() => {
    if (initialCommitApplied.current) return;
    if (commits.length === 0 || reconciledHead === null) return;
    initialCommitApplied.current = true;
    if (reconciledHead.reconciledHead) {
      const exists = commits.some((c) => c.hash === reconciledHead.reconciledHead);
      if (exists && currentCommit !== reconciledHead.reconciledHead) {
        selectCommit(reconciledHead.reconciledHead);
      }
    }
  }, [commits, reconciledHead, currentCommit, selectCommit]);

  // When switching to diff mode, default "to" to current HEAD
  // When switching to browse mode, clear diff
  useEffect(() => {
    if (viewMode === 'browse') {
      clearDiff();
    } else if (viewMode === 'diff' && !compareTo && currentCommit) {
      setCompareTo(currentCommit);
    }
  }, [viewMode, clearDiff, compareTo, currentCommit]);

  // Fetch changed files when diff commits change
  useEffect(() => {
    if (viewMode !== 'diff' || !compareFrom || !compareTo) {
      setDiffFiles(null);
      return;
    }
    setDiffFiles(null);
    gitApi.getDiffFiles(compareFrom, compareTo)
      .then(setDiffFiles)
      .catch(() => setDiffFiles([]));
  }, [viewMode, compareFrom, compareTo]);

  // Auto-compare when both commits and a file are selected in diff mode
  useEffect(() => {
    if (viewMode !== 'diff' || !compareFrom || !compareTo || !selectedFilePath) return;
    setDiffLoading(true);
    loadDiffFromApi(compareFrom, compareTo, selectedFilePath)
      .catch((err) => console.error('Failed to load diff:', err))
      .finally(() => setDiffLoading(false));
  }, [viewMode, compareFrom, compareTo, selectedFilePath, loadDiffFromApi]);

  // Git tree panel handlers
  const handleGraphSelectCommit = useCallback(
    (hash: string) => {
      handleCommitChange(hash);
    },
    [handleCommitChange],
  );

  const handleGraphSelectDiffCommit = useCallback(
    (hash: string, which: 'from' | 'to') => {
      if (which === 'from') {
        setCompareFrom(hash);
      } else {
        setCompareTo(hash);
      }
      setDiffSelectTarget(null);
      setGitTreeOpen(false);
    },
    [],
  );

  // Compute diff stats
  const additions = changes.filter((c) => c.type === 'insert').length;
  const deletions = changes.filter((c) => c.type === 'delete').length;

  const currentCommitInfo = commits.find((c) => c.hash === currentCommit);
  const fromCommitInfo = commits.find((c) => c.hash === compareFrom);
  const toCommitInfo = commits.find((c) => c.hash === compareTo);

  const branchMap = useBranchMap();
  const gitHead = reconciledHead?.gitHead ?? null;

  const renderCommitBadges = (hash: string | undefined | null) => {
    if (!hash) return null;
    const isHead = gitHead === hash;
    const branchNames = branchMap.get(hash);
    return (
      <>
        {isHead && <span className="commit-head-badge">HEAD</span>}
        {branchNames?.map((name) => (
          <span key={name} className="commit-branch-badge">{name}</span>
        ))}
      </>
    );
  };

  // In diff mode, show only changed files; in browse mode, show full tree
  const treeFiles = viewMode === 'diff' && diffFiles !== null
    ? diffFiles.map((p) => ({ path: p, type: 'blob' }))
    : files;

  const isCodeView = viewMode === 'browse' || viewMode === 'diff';

  const gridColumns = isMobile
    ? '1fr'
    : viewMode === 'delta'
    ? deltaSidebarOpen ? `1fr ${deltaSidebarWidth}px` : '1fr 28px'
    : !isCodeView
    ? '1fr'
    : leftPanelOpen
      ? sidebarOpen
        ? `${leftPanelWidth}px 1fr ${sidebarWidth}px`
        : `${leftPanelWidth}px 1fr 28px`
      : sidebarOpen
        ? `1fr ${sidebarWidth}px`
        : '1fr 28px';

  return (
    <div className="app-shell">
      {/* Tab bar — primary view navigation */}
      <div className="tab-bar">
        <div className="tab-bar-tabs">
          {repoName && (
            <span className="tab-bar-project-name">{repoName}</span>
          )}
          <div className="quick-add-buttons">
            <button
              className="quick-add-btn quick-add-comment"
              onClick={() => {
                const scope = isCodeView && selectedFilePath && browseDir === null ? 'file' : 'project';
                setQuickAdd({ kind: 'comment', scope }); setQuickTitle(''); setQuickText(''); setQuickConfirmDiscard(false);
              }}
              data-tooltip={isCodeView && selectedFilePath && browseDir === null ? 'Add comment (file scope)' : 'Add comment (project scope)'}
            >
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M2 2h12v9H5l-3 3V2z" />
              </svg>
            </button>
            <button
              className="quick-add-btn quick-add-vuln"
              onClick={() => {
                const scope = isCodeView && selectedFilePath && browseDir === null ? 'file' : 'project';
                setQuickAdd({ kind: 'finding', scope }); setQuickTitle(''); setQuickText(''); setQuickConfirmDiscard(false);
              }}
              data-tooltip={isCodeView && selectedFilePath && browseDir === null ? 'Add finding (file scope)' : 'Add finding (project scope)'}
            >
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M8 1.5l6.5 12H1.5z" />
                <line x1="8" y1="7" x2="8" y2="9.5" />
                <circle cx="8" cy="11.5" r="0.5" fill="currentColor" />
              </svg>
            </button>
            <button
              className="quick-add-btn quick-add-feature"
              onClick={() => {
                useUIStore.getState().setShowFeatureCreate(true);
                setViewMode('features');
              }}
              data-tooltip="Add feature"
            >
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="8" cy="8" r="3" />
                <path d="M8 1v2M8 13v2M1 8h2M13 8h2M3.1 3.1l1.4 1.4M11.5 11.5l1.4 1.4M3.1 12.9l1.4-1.4M11.5 4.5l1.4-1.4" />
              </svg>
            </button>
          </div>
          {([
            { mode: 'browse' as ViewMode, label: 'Browse', icon: <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M2 2h5l1 2h6v9H2V2z" /></svg> },
            { mode: 'delta' as ViewMode, label: 'Changes', icon: <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M13 8H3M8 3v10M3 5l5-4 5 4" /></svg> },
            { mode: 'findings' as ViewMode, label: 'Findings', icon: <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M8 1L1 14h14L8 1z" /><line x1="8" y1="6" x2="8" y2="9" /><circle cx="8" cy="11.5" r="0.5" fill="currentColor" /></svg> },
            { mode: 'features' as ViewMode, label: 'Features', icon: <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="8" cy="8" r="3" /><path d="M8 1v2M8 13v2M1 8h2M13 8h2M3.1 3.1l1.4 1.4M11.5 11.5l1.4 1.4M3.1 12.9l1.4-1.4M11.5 4.5l1.4-1.4" /></svg> },
          ]).map(({ mode, label, icon }) => {
            const isActive = mode === 'browse'
              ? viewMode === 'browse' || viewMode === 'diff'
              : viewMode === mode;
            return (
              <button
                key={mode}
                className={`tab-bar-tab${isActive ? ' tab-bar-tab-active' : ''}`}
                onClick={() => setViewMode(mode)}
              >
                {icon}{label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="app-layout" style={{ gridTemplateColumns: gridColumns }}>
      {/* Mobile backdrops for drawers */}
      {isMobile && leftPanelOpen && (
        <div className="mobile-drawer-backdrop" onClick={toggleLeftPanel} />
      )}
      {isMobile && sidebarOpen && (
        <div className="mobile-drawer-backdrop" onClick={toggleSidebar} />
      )}

      {/* Left panel: commit selector + git tree + file tree */}
      {isCodeView && (leftPanelOpen || isMobile) && (
        <div className={`left-panel${isMobile ? ' left-panel-drawer' : ''}${isMobile && leftPanelOpen ? ' left-panel-drawer-open' : ''}`}>
          <div className="commit-selector">
            {viewMode === 'browse' ? (
              <>
                <div className="commit-label-row">
                  <div className="view-mode-toggle">
                    <button className="view-mode-btn view-mode-btn-active">Browse</button>
                    <button className="view-mode-btn" onClick={() => setViewMode('diff')}>Compare</button>
                  </div>
                  <button
                    className="panel-drawer-btn"
                    onClick={toggleLeftPanel}
                    data-tooltip="Hide file panel"
                    style={{ marginLeft: 'auto' }}
                  >
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="1" y="2" width="14" height="12" rx="1" />
                      <line x1="5.5" y1="2" x2="5.5" y2="14" />
                    </svg>
                  </button>
                </div>
                {branches.length > 1 && (
                  <select
                    className="branch-select"
                    value={
                      branches.find((b) => {
                        const c = commits.find(c => c.shortHash === b.head || c.hash.startsWith(b.head));
                        return c?.hash === currentCommit;
                      })?.name ?? ''
                    }
                    onChange={(e) => {
                      const branchName = e.target.value;
                      if (!branchName) return;
                      const branch = branches.find((b) => b.name === branchName);
                      if (branch) {
                        const commit = commits.find(
                          (c) => c.shortHash === branch.head || c.hash.startsWith(branch.head)
                        );
                        if (commit) handleCommitChange(commit.hash);
                      }
                    }}
                  >
                    <option value="">Branch...</option>
                    {branches.map((b) => (
                      <option key={b.name} value={b.name}>
                        {b.name}{b.isCurrent ? ' \u2713' : ''}
                      </option>
                    ))}
                  </select>
                )}
                <button
                  className="commit-button"
                  onClick={() => {
                    setDiffSelectTarget(null);
                    setGitTreeOpen((prev) => !prev);
                  }}
                >
                  <span className="commit-button-hash">{currentCommitInfo?.shortHash ?? '...'}</span>
                  {renderCommitBadges(currentCommit)}
                  <span className="commit-button-subject">{currentCommitInfo?.subject ?? 'Select commit'}</span>
                  <span className="commit-button-chevron">{gitTreeOpen ? '\u25B4' : '\u25BE'}</span>
                </button>
              </>
            ) : (
              <>
                <div className="commit-label-row">
                  <div className="view-mode-toggle">
                    <button className="view-mode-btn" onClick={() => setViewMode('browse')}>Browse</button>
                    <button className="view-mode-btn view-mode-btn-active">Compare</button>
                  </div>
                  <button
                    className="panel-drawer-btn"
                    onClick={toggleLeftPanel}
                    data-tooltip="Hide file panel"
                    style={{ marginLeft: 'auto' }}
                  >
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="1" y="2" width="14" height="12" rx="1" />
                      <line x1="5.5" y1="2" x2="5.5" y2="14" />
                    </svg>
                  </button>
                </div>
                <div className="diff-commit-buttons">
                  <button
                    className={`commit-button commit-button-small ${diffSelectTarget === 'to' ? 'commit-button-active' : ''}`}
                    onClick={() => {
                      setDiffSelectTarget('to');
                      setGitTreeOpen(true);
                    }}
                  >
                    <span className="commit-button-label">To</span>
                    <span className="commit-button-hash">{toCommitInfo?.shortHash ?? '...'}</span>
                    {renderCommitBadges(compareTo)}
                    <span className="commit-button-subject">{toCommitInfo?.subject ?? 'Select'}</span>
                  </button>
                  <button
                    className={`commit-button commit-button-small ${diffSelectTarget === 'from' ? 'commit-button-active' : ''}`}
                    onClick={() => {
                      setDiffSelectTarget('from');
                      setGitTreeOpen(true);
                    }}
                  >
                    <span className="commit-button-label">From</span>
                    <span className="commit-button-hash">{fromCommitInfo?.shortHash ?? '...'}</span>
                    {renderCommitBadges(compareFrom)}
                    <span className="commit-button-subject">{fromCommitInfo?.subject ?? 'Select'}</span>
                  </button>
                </div>
              </>
            )}
          </div>

          <GitTreePanel
            isOpen={gitTreeOpen}
            currentCommit={currentCommit}
            compareFrom={compareFrom}
            compareTo={compareTo}
            viewMode={viewMode}
            diffSelectTarget={diffSelectTarget}
            reconciledHead={reconciledHead}
            onSelectCommit={handleGraphSelectCommit}
            onSelectDiffCommit={handleGraphSelectDiffCommit}
            onClose={() => { setGitTreeOpen(false); setDiffSelectTarget(null); }}
          />

          <FileTree files={treeFiles} selectedFile={selectedFilePath} onSelectFile={handleSelectFile} severityMap={findingSeverityMap} />
          {error && <div className="error-banner">{error}</div>}
          <div className="left-panel-resize-handle" onMouseDown={handleLeftPanelResizeMouseDown} />
        </div>
      )}

      {/* Center: code viewer */}
      <main className="main-panel">
        {/* File sub-header — breadcrumb + nav (browse/diff only) */}
        {(viewMode === 'browse' || viewMode === 'diff') && (
        <header className="file-header">
          <div className="file-header-left">
            {!leftPanelOpen && (
              <button
                className="panel-drawer-btn"
                onClick={toggleLeftPanel}
                data-tooltip="Show file panel"
              >
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="1" y="2" width="14" height="12" rx="1" />
                  <line x1="5.5" y1="2" x2="5.5" y2="14" />
                </svg>
              </button>
            )}
            <h1>
              <span
                className={`slug-home ${viewMode === 'browse' && browseDir === '' ? 'slug-home-active' : ''}`}
                onClick={viewMode !== 'browse' || browseDir !== '' ? () => { setBrowseDir(''); setViewMode('browse'); } : undefined}
                data-tooltip="Root directory"
              >~</span>
              <span className="path-sep">/</span>
              {selectedFilePath && (browseDir === null || browseDir === undefined)
                ? (() => {
                    const segments = selectedFilePath.split('/');
                    return segments.map((seg, i) => {
                      const dirPath = segments.slice(0, i + 1).join('/');
                      return (
                        <span key={i}>
                          {i > 0 && <span className="path-sep">/</span>}
                          {i < segments.length - 1 ? (
                            <span className="path-segment" onClick={() => setBrowseDir(dirPath)}>{seg}</span>
                          ) : (
                            <span className="path-filename">{seg}</span>
                          )}
                        </span>
                      );
                    });
                  })()
                : browseDir
                  ? (() => {
                      const segments = browseDir.split('/');
                      return segments.map((seg, i) => {
                        const dirPath = segments.slice(0, i + 1).join('/');
                        return (
                          <span key={i}>
                            {i > 0 && <span className="path-sep">/</span>}
                            {i < segments.length - 1 ? (
                              <span className="path-segment" onClick={() => setBrowseDir(dirPath)}>{seg}</span>
                            ) : (
                              <span className="path-filename">{seg}</span>
                            )}
                          </span>
                        );
                      });
                    })()
                  : <span className="no-file-hint" onClick={() => setFileSearchOpen(true)}>Go to file...</span>}
            </h1>
          </div>
          <div className="file-header-right">
            <div className="nav-buttons">
              <button
                className="nav-btn"
                disabled={!canGoBack}
                onClick={handleGoBack}
                data-tooltip="Go back (Alt+Left)"
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M10 3L5 8l5 5" />
                </svg>
              </button>
              <button
                className="nav-btn"
                disabled={!canGoForward}
                onClick={handleGoForward}
                data-tooltip="Go forward (Alt+Right)"
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M6 3l5 5-5 5" />
                </svg>
              </button>
            </div>
            {viewMode === 'diff' && changes.length > 0 && (
              <div className="file-stats">
                <span className="stat-additions">+{additions}</span>
                <span className="stat-deletions">-{deletions}</span>
              </div>
            )}
            {!sidebarOpen && (
              <button className="panel-drawer-btn" onClick={toggleSidebar} data-tooltip="Open sidebar">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="1" y="2" width="14" height="12" rx="1" />
                  <line x1="10.5" y1="2" x2="10.5" y2="14" />
                </svg>
              </button>
            )}
          </div>
        </header>
        )}

        {inFileSearchOpen && (viewMode === 'browse' || viewMode === 'diff') && (
          <InFileSearchBar
            content={viewMode === 'browse' ? (fileContent ?? '') : changes.map((c) => c.content).join('\n')}
            onClose={() => setInFileSearchOpen(false)}
            initialQuery={inFileSearchInitialQuery}
          />
        )}

        {isLoading && <div className="empty-state">Loading...</div>}
        {!isLoading && viewMode === 'findings' && <FindingsView />}
        {!isLoading && viewMode === 'delta' && <DeltaView baselineId={routeBaselineId} />}
        {!isLoading && viewMode === 'features' && <FeaturesView />}
        {!isLoading && viewMode === 'browse' && browseDir !== null && (
          <FolderView
            files={files}
            dirPath={browseDir}
            onSelectFile={(path) => {
              setBrowseDir(null);
              handleSelectFile(path);
            }}
            onNavigateDir={setBrowseDir}
          />
        )}
        {!isLoading && viewMode === 'browse' && browseDir === null && <BrowseView />}
        {!isLoading && viewMode === 'diff' && (() => {
          const msg = getDiffEmptyMessage({
            changesCount: changes.length,
            selectedFilePath,
            diffLoading,
            compareFrom,
            compareTo,
          });
          return msg ? <div className="empty-state">{msg}</div> : <DiffView />;
        })()}
      </main>

      {/* Delta sidebar: changed files panel */}
      {viewMode === 'delta' && (
        deltaSidebarOpen ? (
          <div className="delta-sidebar-wrapper">
            <div className="delta-sidebar-resize-handle" onMouseDown={handleDeltaSidebarResizeMouseDown} />
            <button
              className="panel-drawer-btn delta-sidebar-close"
              onClick={() => setDeltaSidebarOpen(false)}
              data-tooltip="Hide panel"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <rect x="1" y="2" width="14" height="12" rx="1" />
                <line x1="10.5" y1="2" x2="10.5" y2="14" />
              </svg>
            </button>
            <DeltaSidebar />
          </div>
        ) : (
          <div className="sidebar-collapsed">
            <button
              className="panel-drawer-btn"
              onClick={() => setDeltaSidebarOpen(true)}
              data-tooltip="Show changed files"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <rect x="1" y="2" width="14" height="12" rx="1" />
                <line x1="10.5" y1="2" x2="10.5" y2="14" />
              </svg>
            </button>
          </div>
        )
      )}

      {/* Mobile FAB: show changed files when delta sidebar is hidden */}
      {isMobile && viewMode === 'delta' && !deltaSidebarOpen && (
        <button
          onClick={() => setDeltaSidebarOpen(true)}
          style={{
            position: 'fixed',
            bottom: '16px',
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 'var(--z-fab)',
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            padding: '10px 20px',
            borderRadius: '999px',
            background: 'var(--color-accent)',
            color: 'var(--color-on-accent, #fff)',
            border: 'none',
            cursor: 'pointer',
            fontSize: '14px',
            fontWeight: 500,
            boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
          }}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M2 4h8l2 2v6a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z" />
            <path d="M12 6h1a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H5" />
          </svg>
          Files
        </button>
      )}

      {/* Sidebar wrapper (resize handle is inside, absolutely positioned) */}
      {isCodeView && (
        <div className={`sidebar-wrapper${isMobile ? ' sidebar-wrapper-drawer' : ''}${isMobile && sidebarOpen ? ' sidebar-wrapper-drawer-open' : ''}`}>
          {sidebarOpen && !isMobile && (
            <div className="sidebar-resize-handle" onMouseDown={handleResizeMouseDown} />
          )}
          <Sidebar />
        </div>
      )}

      {/* SVG connector from sidebar finding card to code line */}
      {isCodeView && !isMobile && <ConnectorOverlay />}

      {/* Quick-add finding/comment popover */}
      {quickAdd && (
        <div className="quick-add-overlay" onClick={handleQuickAddCancel}>
          <div
            className="quick-add-popover"
            ref={quickRef}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); handleQuickAddCancel(); } }}
          >
            <div className="quick-add-popover-header">
              {quickAdd.kind === 'finding' ? 'New Finding' : 'New Comment'}
              <span className="quick-add-scope">
                {quickAdd.scope === 'project' ? 'Project' : selectedFilePath?.split('/').pop() ?? 'File'}
              </span>
            </div>
            {quickConfirmDiscard && (
              <div className="quick-add-confirm-discard">
                <span>You have unsaved input. Discard?</span>
                <div className="quick-add-confirm-actions">
                  <button className="finding-delete-yes" onClick={() => { setQuickAdd(null); setQuickTitle(''); setQuickText(''); setQuickConfirmDiscard(false); }}>Discard</button>
                  <button className="finding-delete-no" onClick={() => setQuickConfirmDiscard(false)}>Keep editing</button>
                </div>
              </div>
            )}
            {!quickConfirmDiscard && (
              <>
                {quickAdd.kind === 'finding' && (
                  <>
                    <input
                      className="finding-edit-input"
                      placeholder="Finding title"
                      value={quickTitle}
                      onChange={(e) => setQuickTitle(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleQuickAddSubmit(); }}
                      autoFocus
                    />
                    <div className="quick-add-row-pair">
                      <div className="finding-edit-row">
                        <label className="finding-edit-label">Severity</label>
                        <select
                          className="finding-edit-select"
                          value={quickSeverity}
                          onChange={(e) => setQuickSeverity(e.target.value as Severity)}
                        >
                          <option value="critical">Critical</option>
                          <option value="high">High</option>
                          <option value="medium">Medium</option>
                          <option value="low">Low</option>
                          <option value="info">Info</option>
                        </select>
                      </div>
                      <div className="finding-edit-row">
                        <label className="finding-edit-label">Status</label>
                        <select
                          className="finding-edit-select"
                          value={quickStatus}
                          onChange={(e) => setQuickStatus(e.target.value as FindingStatus)}
                        >
                          <option value="draft">Draft</option>
                          <option value="open">Open</option>
                          <option value="in-progress">In progress</option>
                          <option value="false-positive">False positive</option>
                          <option value="accepted">Accepted</option>
                          <option value="closed">Closed</option>
                        </select>
                      </div>
                    </div>
                    <div className="quick-add-row-pair">
                      <div className="finding-edit-row">
                        <label className="finding-edit-label">CWE</label>
                        <input
                          className="finding-edit-input finding-edit-input-sm"
                          placeholder="CWE-79"
                          value={quickCwe}
                          onChange={(e) => setQuickCwe(e.target.value)}
                        />
                      </div>
                      <div className="finding-edit-row">
                        <label className="finding-edit-label">CVE</label>
                        <input
                          className="finding-edit-input finding-edit-input-sm"
                          placeholder="CVE-2024-…"
                          value={quickCve}
                          onChange={(e) => setQuickCve(e.target.value)}
                        />
                      </div>
                    </div>
                    <div className="quick-add-row-pair">
                      <div className="finding-edit-row">
                        <label className="finding-edit-label">CVSS</label>
                        <input
                          className="finding-edit-input finding-edit-input-sm"
                          placeholder="0.0–10.0"
                          value={quickScore}
                          onChange={(e) => setQuickScore(e.target.value)}
                          type="number"
                          min="0"
                          max="10"
                          step="0.1"
                        />
                      </div>
                      <div className="finding-edit-row">
                        <label className="finding-edit-label">Category</label>
                        <input
                          className="finding-edit-input finding-edit-input-sm"
                          placeholder="e.g. injection"
                          value={quickCategory}
                          onChange={(e) => setQuickCategory(e.target.value)}
                        />
                      </div>
                    </div>
                  </>
                )}
                {quickAdd.kind === 'comment' && (
                  <div className="finding-edit-row">
                    <label className="finding-edit-label">Type</label>
                    <div className="comment-type-toggle quick-add-type-toggle">
                      {(['feature', 'improvement', 'question', 'concern'] as const).map((t) => (
                        <button
                          key={t}
                          className={`comment-type-toggle-btn quick-add-type-btn${quickCommentType === t ? ' active' : ''}`}
                          onClick={() => setQuickCommentType(quickCommentType === t ? '' : t)}
                        >
                          <span className="quick-add-type-icon">{COMMENT_TYPE_ICON[t]}</span>
                          <span className="quick-add-type-label">{COMMENT_TYPE_LABEL[t]}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                <textarea
                  className="finding-edit-textarea"
                  placeholder={quickAdd.kind === 'finding' ? 'Description (optional)' : 'Comment text'}
                  value={quickText}
                  onChange={(e) => setQuickText(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleQuickAddSubmit(); }}
                  rows={3}
                  autoFocus={quickAdd.kind === 'comment'}
                />
                <div className="finding-edit-actions">
                  <button className="finding-edit-save" onClick={handleQuickAddSubmit}>
                    {quickAdd.kind === 'finding' ? 'Add Finding' : 'Add Comment'}
                  </button>
                  <button className="finding-edit-cancel" onClick={handleQuickAddCancel}>Cancel</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Fuzzy file search modal (Cmd+G) */}
      {fileSearchOpen && (
        <FileSearchModal
          files={files}
          onSelect={(path) => {
            setFileSearchOpen(false);
            handleSelectFile(path);
          }}
          onClose={() => setFileSearchOpen(false)}
        />
      )}

      {/* Content search modal (Cmd+Shift+F) */}
      {contentSearchOpen && currentCommit && (
        <ContentSearchModal
          currentCommit={currentCommit}
          onSelect={(file, line) => {
            setContentSearchOpen(false);
            handleSelectFile(file);
            useUIStore.getState().setScrollTargetLine(line);
            useUIStore.getState().setHighlightRange({ start: line, end: line });
          }}
          onClose={() => setContentSearchOpen(false)}
          initialQuery={contentSearchInitialQuery}
        />
      )}

      {/* Keyboard shortcuts button — fixed bottom-right */}
      <button
        className="shortcuts-fab"
        data-tooltip="Keyboard shortcuts"
        data-tooltip-pos="above"
        onClick={() => setShortcutsOpen(true)}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="1" y="4" width="14" height="9" rx="1.5" />
          <line x1="4" y1="7" x2="5" y2="7" />
          <line x1="7.5" y1="7" x2="8.5" y2="7" />
          <line x1="11" y1="7" x2="12" y2="7" />
          <line x1="4" y1="10" x2="12" y2="10" />
        </svg>
      </button>
      {shortcutsOpen && <KeyboardShortcutsModal onClose={() => setShortcutsOpen(false)} />}
    </div>
    </div>
  );
}
