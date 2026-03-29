import { create } from 'zustand';
import type { ViewMode, CommentDragState, CommentType, FeatureKind } from '../core/types';

type AnnotationAction = 'comment' | 'finding' | 'feature' | null;
type Theme = 'dark' | 'light';

export interface DraftComment {
  text: string;
  commentType?: CommentType;
  findingId?: string;
}

interface HighlightRange {
  start: number;
  end: number;
}

export interface SearchMatchRange {
  start: number;
  end: number;
  isCurrent: boolean;
}

interface UIState {
  theme: Theme;
  toggleTheme: () => void;
  viewMode: ViewMode;
  commentDrag: CommentDragState;
  expandedFindingId: string | null;
  scrollTargetLine: number | null;
  highlightRange: HighlightRange | null;
  sidebarOpen: boolean;
  sidebarWidth: number;
  annotationAction: AnnotationAction;
  overviewTreeOpen: boolean;
  overviewTreeWidth: number;
  leftPanelOpen: boolean;
  leftPanelWidth: number;
  /** Per-line search match ranges for in-file search highlighting. Key = 1-indexed line number. */
  inFileSearch: Map<number, SearchMatchRange[]> | null;
  /** Draft comment carried across view transitions (e.g. Overview → Browse). */
  draftComment: DraftComment | null;
  /** Whether the create-feature modal should be shown. */
  showFeatureCreate: boolean;
  /** Request to open the quick-add finding popover from child components. */
  requestFindingCreate: boolean;
  /** Navigate to Findings view and scroll to this finding id. */
  scrollToFindingId: string | null;
  /** Navigate to Features view and scroll to this feature. */
  scrollToFeature: { id: string; kind: FeatureKind } | null;
  setViewMode: (mode: ViewMode) => void;
  setCommentDrag: (drag: Partial<CommentDragState>) => void;
  setExpandedFinding: (id: string | null) => void;
  setScrollTargetLine: (line: number | null) => void;
  setHighlightRange: (range: HighlightRange | null) => void;
  toggleSidebar: () => void;
  setSidebarWidth: (width: number) => void;
  setAnnotationAction: (action: AnnotationAction) => void;
  toggleOverviewTree: () => void;
  setOverviewTreeWidth: (width: number) => void;
  toggleLeftPanel: () => void;
  setLeftPanelWidth: (width: number) => void;
  setInFileSearch: (matches: Map<number, SearchMatchRange[]> | null) => void;
  setDraftComment: (draft: DraftComment | null) => void;
  setShowFeatureCreate: (show: boolean) => void;
  setRequestFindingCreate: (req: boolean) => void;
  setScrollToFindingId: (id: string | null) => void;
  setScrollToFeature: (target: { id: string; kind: FeatureKind } | null) => void;
}

export const useUIStore = create<UIState>((set) => ({
  theme: (localStorage.getItem('bench-theme') as Theme) ?? 'dark',
  toggleTheme: () =>
    set((state) => {
      const next: Theme = state.theme === 'dark' ? 'light' : 'dark';
      localStorage.setItem('bench-theme', next);
      return { theme: next };
    }),
  viewMode: 'browse',
  commentDrag: {
    isActive: false,
    startLine: null,
    endLine: null,
    side: null,
  },
  expandedFindingId: null,
  scrollTargetLine: null,
  highlightRange: null,
  sidebarOpen: !window.matchMedia('(max-width: 639px)').matches,
  sidebarWidth: 500,
  annotationAction: null,
  overviewTreeOpen: false,
  overviewTreeWidth: 260,
  leftPanelOpen: !window.matchMedia('(max-width: 639px)').matches,
  leftPanelWidth: 260,
  inFileSearch: null,
  draftComment: null,
  showFeatureCreate: false,
  requestFindingCreate: false,
  scrollToFindingId: null,
  scrollToFeature: null,

  setViewMode: (mode) => set({ viewMode: mode }),

  setCommentDrag: (drag) =>
    set((state) => ({
      commentDrag: { ...state.commentDrag, ...drag },
    })),

  setExpandedFinding: (id) => set({ expandedFindingId: id }),

  setScrollTargetLine: (line) => set({ scrollTargetLine: line }),

  setHighlightRange: (range) => set({ highlightRange: range }),

  toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),

  setSidebarWidth: (width) => set({ sidebarWidth: width }),

  setAnnotationAction: (action) => set({ annotationAction: action }),

  toggleOverviewTree: () => set((state) => ({ overviewTreeOpen: !state.overviewTreeOpen })),

  setOverviewTreeWidth: (width) => set({ overviewTreeWidth: width }),

  toggleLeftPanel: () => set((state) => ({ leftPanelOpen: !state.leftPanelOpen })),

  setLeftPanelWidth: (width) => set({ leftPanelWidth: width }),

  setInFileSearch: (matches) => set({ inFileSearch: matches }),

  setDraftComment: (draft) => set({ draftComment: draft }),

  setShowFeatureCreate: (show) => set({ showFeatureCreate: show }),

  setRequestFindingCreate: (req) => set({ requestFindingCreate: req }),
  setScrollToFindingId: (id) => set({ scrollToFindingId: id }),
  setScrollToFeature: (target) => set({ scrollToFeature: target }),
}));
