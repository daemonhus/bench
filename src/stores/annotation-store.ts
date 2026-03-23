import { create } from 'zustand';
import type { Finding, Comment, FindingStatus, CommentType, Feature } from '../core/types';
import { getEffectiveLineRange, getConfidence } from '../core/types';
import { findingsApi, commentsApi, featuresApi } from '../core/api';

interface AnnotationState {
  findings: Finding[];
  comments: Comment[];
  features: Feature[];
  hasReconciliationData: boolean;
  loadFindings: (findings: Finding[]) => void;
  loadComments: (comments: Comment[]) => void;
  loadFeatures: (features: Feature[]) => void;
  addFinding: (finding: Finding) => void;
  updateFinding: (id: string, updates: Partial<Finding>) => void;
  updateFindingStatus: (id: string, status: FindingStatus) => void;
  deleteFinding: (id: string) => void;
  addComment: (comment: Comment) => void;
  updateComment: (id: string, text: string, commentType?: CommentType) => void;
  resolveComment: (id: string, resolvedCommit: string | null) => void;
  deleteComment: (id: string) => void;
  addFeature: (feature: Feature) => void;
  updateFeature: (id: string, updates: Partial<Feature>) => void;
  deleteFeature: (id: string) => void;
  getFindingsForLine: (line: number) => Finding[];
  getCommentsForLine: (line: number) => Comment[];
  getFeaturesForLine: (line: number) => Feature[];
  fetchCommentsForFinding: (findingId: string) => Promise<void>;
  getCommentsForFinding: (findingId: string) => Comment[];
  fetchCommentsForFeature: (featureId: string) => Promise<void>;
  getCommentsForFeature: (featureId: string) => Comment[];
}

export const useAnnotationStore = create<AnnotationState>((set, get) => ({
  findings: [],
  comments: [],
  features: [],
  hasReconciliationData: false,

  loadFindings: (findings) => {
    const hasRecon = findings.some((f) => getConfidence(f) !== undefined);
    set((state) => ({
      findings,
      hasReconciliationData: hasRecon || state.comments.some((c) => getConfidence(c) !== undefined),
    }));
  },

  loadComments: (comments) => {
    const hasRecon = comments.some((c) => getConfidence(c) !== undefined);
    set((state) => ({
      comments,
      hasReconciliationData: hasRecon || state.findings.some((f) => getConfidence(f) !== undefined),
    }));
  },

  loadFeatures: (features) => {
    set({ features });
  },

  addFinding: (finding) => {
    set((state) => ({
      findings: [...state.findings, finding],
    }));
    findingsApi.create(finding).catch((err) => {
      console.error('Failed to create finding:', err);
      set((state) => ({
        findings: state.findings.filter((f) => f.id !== finding.id),
      }));
    });
  },

  updateFinding: (id, updates) => {
    const prev = get().findings;
    set((state) => ({
      findings: state.findings.map((f) =>
        f.id === id ? { ...f, ...updates } : f,
      ),
    }));
    findingsApi.update(id, updates).catch((err) => {
      console.error('Failed to update finding:', err);
      set({ findings: prev });
    });
  },

  updateFindingStatus: (id, status) => {
    const prev = get().findings;
    set((state) => ({
      findings: state.findings.map((f) =>
        f.id === id ? { ...f, status } : f,
      ),
    }));
    findingsApi.update(id, { status }).catch((err) => {
      console.error('Failed to update finding status:', err);
      set({ findings: prev });
    });
  },

  deleteFinding: (id) => {
    const prev = get().findings;
    const prevComments = get().comments;
    set((state) => ({
      findings: state.findings.filter((f) => f.id !== id),
      // Nullify findingId on linked comments (matches backend cascade)
      comments: state.comments.map((c) =>
        c.findingId === id ? { ...c, findingId: undefined } : c,
      ),
    }));
    findingsApi.delete(id).catch((err) => {
      console.error('Failed to delete finding:', err);
      set({ findings: prev, comments: prevComments });
    });
  },

  addFeature: (feature) => {
    set((state) => ({
      features: [...state.features, feature],
    }));
    featuresApi.create(feature).catch((err) => {
      console.error('Failed to create feature:', err);
      set((state) => ({
        features: state.features.filter((f) => f.id !== feature.id),
      }));
    });
  },

  updateFeature: (id, updates) => {
    const prev = get().features;
    set((state) => ({
      features: state.features.map((f) =>
        f.id === id ? { ...f, ...updates } : f,
      ),
    }));
    featuresApi.update(id, updates).catch((err) => {
      console.error('Failed to update feature:', err);
      set({ features: prev });
    });
  },

  deleteFeature: (id) => {
    const prev = get().features;
    set((state) => ({
      features: state.features.filter((f) => f.id !== id),
    }));
    featuresApi.delete(id).catch((err) => {
      console.error('Failed to delete feature:', err);
      set({ features: prev });
    });
  },

  addComment: (comment) => {
    set((state) => ({
      comments: [...state.comments, comment],
    }));
    commentsApi.create(comment).catch((err) => {
      console.error('Failed to create comment:', err);
      set((state) => ({
        comments: state.comments.filter((c) => c.id !== comment.id),
      }));
    });
  },

  updateComment: (id, text, commentType?) => {
    const prev = get().comments;
    const apiUpdates: Record<string, unknown> = { text };
    if (commentType !== undefined) apiUpdates.commentType = commentType;
    set((state) => ({
      comments: state.comments.map((c) =>
        c.id === id ? { ...c, text, ...(commentType !== undefined ? { commentType } : {}) } : c,
      ),
    }));
    commentsApi.update(id, apiUpdates).catch((err) => {
      console.error('Failed to update comment:', err);
      set({ comments: prev });
    });
  },

  resolveComment: (id, resolvedCommit) => {
    const prev = get().comments;
    set((state) => ({
      comments: state.comments.map((c) =>
        c.id === id ? { ...c, resolvedCommit: resolvedCommit ?? undefined } : c,
      ),
    }));
    commentsApi.update(id, { resolvedCommit }).catch((err) => {
      console.error('Failed to resolve comment:', err);
      set({ comments: prev });
    });
  },

  deleteComment: (id) => {
    const prev = get().comments;
    set((state) => ({
      comments: state.comments.filter((c) => c.id !== id),
    }));
    commentsApi.delete(id).catch((err) => {
      console.error('Failed to delete comment:', err);
      set({ comments: prev });
    });
  },

  getFeaturesForLine: (line) => {
    const { features } = get();
    return features.filter((f) => {
      const fp = f as Feature & { effectiveAnchor?: { lineRange?: { start: number; end: number } } };
      const range = fp.effectiveAnchor?.lineRange ?? f.anchor.lineRange;
      if (!range) return false;
      return line >= range.start && line <= range.end;
    });
  },

  getFindingsForLine: (line) => {
    const { findings } = get();
    return findings.filter((f) => {
      const range = getEffectiveLineRange(f);
      if (!range) return false;
      return line >= range.start && line <= range.end;
    });
  },

  getCommentsForLine: (line) => {
    const { comments } = get();
    return comments.filter((c) => {
      const range = getEffectiveLineRange(c);
      if (!range) return false;
      return line >= range.start && line <= range.end;
    });
  },

  fetchCommentsForFinding: async (findingId) => {
    const fetched = await commentsApi.list(undefined, undefined, findingId);
    // Merge into store: replace any existing comments for this finding, add new ones
    set((state) => {
      const existingIds = new Set(state.comments.map((c) => c.id));
      const newComments = (fetched as Comment[]).filter((c) => !existingIds.has(c.id));
      return { comments: [...state.comments, ...newComments] };
    });
  },

  getCommentsForFinding: (findingId) => {
    return get().comments.filter((c) => c.findingId === findingId);
  },

  fetchCommentsForFeature: async (featureId) => {
    const fetched = await commentsApi.list(undefined, undefined, undefined, featureId);
    set((state) => {
      const existingIds = new Set(state.comments.map((c) => c.id));
      const newComments = (fetched as Comment[]).filter((c) => !existingIds.has(c.id));
      return { comments: [...state.comments, ...newComments] };
    });
  },

  getCommentsForFeature: (featureId) => {
    return get().comments.filter((c) => c.featureId === featureId);
  },
}));
