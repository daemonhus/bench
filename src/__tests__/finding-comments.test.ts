import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useAnnotationStore } from '../stores/annotation-store';
import type { Finding, Comment } from '../core/types';

// Mock the API modules — all calls resolve successfully so optimistic updates stick
vi.mock('../core/api', () => ({
  findingsApi: {
    create: vi.fn().mockResolvedValue({}),
    update: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue([]),
  },
  commentsApi: {
    create: vi.fn().mockResolvedValue({}),
    update: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue([]),
  },
}));

function resetStore() {
  useAnnotationStore.setState({
    findings: [],
    comments: [],
    hasReconciliationData: false,
  });
}

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: 'f1',
    anchor: { fileId: 'src/a.go', commitId: 'aaa', lineRange: { start: 10, end: 15 } },
    severity: 'high',
    title: 'SQL injection',
    description: 'User input concatenated',
    cwe: 'CWE-89',
    cve: '',
    vector: '',
    score: 7.5,
    status: 'open',
    source: 'manual',
    createdAt: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeComment(overrides: Partial<Comment> = {}): Comment {
  return {
    id: 'c1',
    anchor: { fileId: 'src/a.go', commitId: 'aaa', lineRange: { start: 10, end: 15 } },
    author: 'alice',
    text: 'This looks dangerous',
    timestamp: '2024-01-02T00:00:00Z',
    threadId: 't1',
    ...overrides,
  };
}

describe('finding-comments integration', () => {
  beforeEach(() => {
    resetStore();
    vi.clearAllMocks();
  });

  describe('loading findings and comments', () => {
    it('loadFindings populates the store', () => {
      const f = makeFinding();
      useAnnotationStore.getState().loadFindings([f]);

      expect(useAnnotationStore.getState().findings).toHaveLength(1);
      expect(useAnnotationStore.getState().findings[0].id).toBe('f1');
    });

    it('loadComments populates the store', () => {
      const c = makeComment();
      useAnnotationStore.getState().loadComments([c]);

      expect(useAnnotationStore.getState().comments).toHaveLength(1);
      expect(useAnnotationStore.getState().comments[0].id).toBe('c1');
    });
  });

  describe('finding-linked comments', () => {
    it('getCommentsForFinding returns only linked comments', () => {
      const f = makeFinding();
      const linked1 = makeComment({ id: 'c1', findingId: 'f1', text: 'linked 1' });
      const linked2 = makeComment({ id: 'c2', findingId: 'f1', text: 'linked 2' });
      const standalone = makeComment({ id: 'c3', text: 'standalone' });

      useAnnotationStore.getState().loadFindings([f]);
      useAnnotationStore.getState().loadComments([linked1, linked2, standalone]);

      const result = useAnnotationStore.getState().getCommentsForFinding('f1');
      expect(result).toHaveLength(2);
      expect(result.map((c) => c.id).sort()).toEqual(['c1', 'c2']);
    });

    it('getCommentsForFinding returns empty for finding with no comments', () => {
      const f = makeFinding();
      const standalone = makeComment({ id: 'c1', text: 'standalone' });

      useAnnotationStore.getState().loadFindings([f]);
      useAnnotationStore.getState().loadComments([standalone]);

      expect(useAnnotationStore.getState().getCommentsForFinding('f1')).toHaveLength(0);
    });
  });

  describe('deleting a finding', () => {
    it('removes finding from store', () => {
      const f = makeFinding();
      useAnnotationStore.getState().loadFindings([f]);

      expect(useAnnotationStore.getState().findings).toHaveLength(1);

      useAnnotationStore.getState().deleteFinding('f1');

      expect(useAnnotationStore.getState().findings).toHaveLength(0);
    });

    it('nullifies findingId on linked comments', () => {
      const f = makeFinding();
      const linked = makeComment({ id: 'c1', findingId: 'f1', text: 'linked' });
      const standalone = makeComment({ id: 'c2', text: 'standalone' });

      useAnnotationStore.getState().loadFindings([f]);
      useAnnotationStore.getState().loadComments([linked, standalone]);

      useAnnotationStore.getState().deleteFinding('f1');

      const comments = useAnnotationStore.getState().comments;
      expect(comments).toHaveLength(2); // comments survive

      const formerlyLinked = comments.find((c) => c.id === 'c1')!;
      expect(formerlyLinked.findingId).toBeUndefined(); // link removed
      expect(formerlyLinked.text).toBe('linked'); // text preserved

      const standaloneAfter = comments.find((c) => c.id === 'c2')!;
      expect(standaloneAfter.findingId).toBeUndefined(); // was never linked
    });

    it('linked comments no longer appear in getCommentsForFinding', () => {
      const f = makeFinding();
      const linked = makeComment({ id: 'c1', findingId: 'f1' });

      useAnnotationStore.getState().loadFindings([f]);
      useAnnotationStore.getState().loadComments([linked]);

      expect(useAnnotationStore.getState().getCommentsForFinding('f1')).toHaveLength(1);

      useAnnotationStore.getState().deleteFinding('f1');

      expect(useAnnotationStore.getState().getCommentsForFinding('f1')).toHaveLength(0);
    });

    it('deleted finding disappears from filtered lists (simulates overview panel)', () => {
      const open1 = makeFinding({ id: 'f1', status: 'open' });
      const open2 = makeFinding({ id: 'f2', status: 'open', title: 'XSS' });
      const closed = makeFinding({ id: 'f3', status: 'closed', title: 'Resolved' });

      useAnnotationStore.getState().loadFindings([open1, open2, closed]);

      // Simulate the overview panel derivation
      const openBefore = useAnnotationStore.getState().findings
        .filter((f) => f.status === 'draft' || f.status === 'open' || f.status === 'in-progress');
      expect(openBefore).toHaveLength(2);

      // Delete one open finding
      useAnnotationStore.getState().deleteFinding('f1');

      const openAfter = useAnnotationStore.getState().findings
        .filter((f) => f.status === 'draft' || f.status === 'open' || f.status === 'in-progress');
      expect(openAfter).toHaveLength(1);
      expect(openAfter[0].id).toBe('f2');

      // Closed findings unaffected
      const closedAfter = useAnnotationStore.getState().findings
        .filter((f) => f.status === 'closed');
      expect(closedAfter).toHaveLength(1);
    });
  });

  describe('deleting a comment', () => {
    it('removes comment from store', () => {
      const c = makeComment();
      useAnnotationStore.getState().loadComments([c]);

      useAnnotationStore.getState().deleteComment('c1');

      expect(useAnnotationStore.getState().comments).toHaveLength(0);
    });

    it('does not affect other comments', () => {
      const c1 = makeComment({ id: 'c1', text: 'first' });
      const c2 = makeComment({ id: 'c2', text: 'second' });
      useAnnotationStore.getState().loadComments([c1, c2]);

      useAnnotationStore.getState().deleteComment('c1');

      const remaining = useAnnotationStore.getState().comments;
      expect(remaining).toHaveLength(1);
      expect(remaining[0].id).toBe('c2');
    });
  });

  describe('adding a comment to a finding', () => {
    it('addComment with findingId appears in getCommentsForFinding', () => {
      const f = makeFinding();
      useAnnotationStore.getState().loadFindings([f]);

      useAnnotationStore.getState().addComment(makeComment({
        id: 'c1',
        findingId: 'f1',
        text: 'discussion',
      }));

      const linked = useAnnotationStore.getState().getCommentsForFinding('f1');
      expect(linked).toHaveLength(1);
      expect(linked[0].text).toBe('discussion');
    });
  });

  describe('full lifecycle: create finding → add comments → delete finding', () => {
    it('finding and comments created, then finding deleted, comments survive unlinked', () => {
      // 1. Load a finding
      const f = makeFinding({ id: 'f1' });
      useAnnotationStore.getState().loadFindings([f]);

      // 2. Add linked comments
      useAnnotationStore.getState().addComment(makeComment({
        id: 'c1', findingId: 'f1', text: 'first note',
      }));
      useAnnotationStore.getState().addComment(makeComment({
        id: 'c2', findingId: 'f1', text: 'second note',
      }));

      // 3. Add a standalone comment
      useAnnotationStore.getState().addComment(makeComment({
        id: 'c3', text: 'unrelated',
      }));

      // Verify state before deletion
      expect(useAnnotationStore.getState().findings).toHaveLength(1);
      expect(useAnnotationStore.getState().comments).toHaveLength(3);
      expect(useAnnotationStore.getState().getCommentsForFinding('f1')).toHaveLength(2);

      // 4. Delete the finding
      useAnnotationStore.getState().deleteFinding('f1');

      // 5. Finding is gone
      expect(useAnnotationStore.getState().findings).toHaveLength(0);

      // 6. All 3 comments survive
      expect(useAnnotationStore.getState().comments).toHaveLength(3);

      // 7. Previously linked comments have findingId nullified
      const c1 = useAnnotationStore.getState().comments.find((c) => c.id === 'c1')!;
      expect(c1.findingId).toBeUndefined();
      expect(c1.text).toBe('first note');

      const c2 = useAnnotationStore.getState().comments.find((c) => c.id === 'c2')!;
      expect(c2.findingId).toBeUndefined();

      // 8. No comments linked to the deleted finding
      expect(useAnnotationStore.getState().getCommentsForFinding('f1')).toHaveLength(0);

      // 9. Simulate overview panel — finding no longer in open list
      const openFindings = useAnnotationStore.getState().findings
        .filter((f) => f.status === 'open');
      expect(openFindings).toHaveLength(0);
    });
  });

  describe('API rollback on failure', () => {
    it('finding reappears if API delete fails', async () => {
      const { findingsApi } = await import('../core/api');
      (findingsApi.delete as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('network error'));

      const f = makeFinding();
      useAnnotationStore.getState().loadFindings([f]);

      useAnnotationStore.getState().deleteFinding('f1');

      // Optimistic: finding gone immediately
      expect(useAnnotationStore.getState().findings).toHaveLength(0);

      // Wait for the catch to fire
      await vi.waitFor(() => {
        expect(useAnnotationStore.getState().findings).toHaveLength(1);
      });

      // Finding is back after rollback
      expect(useAnnotationStore.getState().findings[0].id).toBe('f1');
    });

    it('comments are restored if API delete of finding fails', async () => {
      const { findingsApi } = await import('../core/api');
      (findingsApi.delete as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('network error'));

      const f = makeFinding();
      const linked = makeComment({ id: 'c1', findingId: 'f1' });
      useAnnotationStore.getState().loadFindings([f]);
      useAnnotationStore.getState().loadComments([linked]);

      useAnnotationStore.getState().deleteFinding('f1');

      // Optimistic: findingId nullified
      expect(useAnnotationStore.getState().comments[0].findingId).toBeUndefined();

      // Wait for rollback
      await vi.waitFor(() => {
        expect(useAnnotationStore.getState().comments[0].findingId).toBe('f1');
      });
    });
  });
});
