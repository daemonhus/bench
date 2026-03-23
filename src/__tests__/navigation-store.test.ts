import { describe, it, expect, beforeEach } from 'vitest';
import { useNavigationStore } from '../stores/navigation-store';

// Helper: reset store state between tests
function resetStore() {
  useNavigationStore.setState({
    history: [],
    currentIndex: -1,
  });
}

describe('navigation-store', () => {
  beforeEach(() => {
    resetStore();
  });

  describe('pushFile', () => {
    it('adds a file to empty history', () => {
      const { pushFile } = useNavigationStore.getState();
      pushFile('src/main.ts');

      const state = useNavigationStore.getState();
      expect(state.history).toHaveLength(1);
      expect(state.history[0].filePath).toBe('src/main.ts');
      expect(state.currentIndex).toBe(0);
    });

    it('appends files sequentially', () => {
      const { pushFile } = useNavigationStore.getState();
      pushFile('a.ts');
      pushFile('b.ts');
      pushFile('c.ts');

      const state = useNavigationStore.getState();
      expect(state.history).toHaveLength(3);
      expect(state.history.map((h) => h.filePath)).toEqual(['a.ts', 'b.ts', 'c.ts']);
      expect(state.currentIndex).toBe(2);
    });

    it('skips duplicate consecutive entries', () => {
      const { pushFile } = useNavigationStore.getState();
      pushFile('a.ts');
      pushFile('a.ts');
      pushFile('a.ts');

      const state = useNavigationStore.getState();
      expect(state.history).toHaveLength(1);
      expect(state.currentIndex).toBe(0);
    });

    it('allows re-visiting a file after visiting others', () => {
      const { pushFile } = useNavigationStore.getState();
      pushFile('a.ts');
      pushFile('b.ts');
      pushFile('a.ts');

      const state = useNavigationStore.getState();
      expect(state.history).toHaveLength(3);
      expect(state.history.map((h) => h.filePath)).toEqual(['a.ts', 'b.ts', 'a.ts']);
    });

    it('truncates forward history when navigating to new file after going back', () => {
      const store = useNavigationStore.getState();
      store.pushFile('a.ts');
      store.pushFile('b.ts');
      store.pushFile('c.ts');

      // Go back twice (index 2 -> 1 -> 0)
      useNavigationStore.getState().goBack();
      useNavigationStore.getState().goBack();
      expect(useNavigationStore.getState().currentIndex).toBe(0);

      // Navigate to new file — should truncate b.ts and c.ts
      useNavigationStore.getState().pushFile('d.ts');

      const state = useNavigationStore.getState();
      expect(state.history.map((h) => h.filePath)).toEqual(['a.ts', 'd.ts']);
      expect(state.currentIndex).toBe(1);
    });
  });

  describe('goBack', () => {
    it('returns null when history is empty', () => {
      const result = useNavigationStore.getState().goBack();
      expect(result).toBeNull();
    });

    it('returns null when at the first entry', () => {
      useNavigationStore.getState().pushFile('a.ts');
      const result = useNavigationStore.getState().goBack();
      expect(result).toBeNull();
      expect(useNavigationStore.getState().currentIndex).toBe(0);
    });

    it('returns previous file path', () => {
      const store = useNavigationStore.getState();
      store.pushFile('a.ts');
      store.pushFile('b.ts');
      store.pushFile('c.ts');

      const result = useNavigationStore.getState().goBack();
      expect(result).toBe('b.ts');
      expect(useNavigationStore.getState().currentIndex).toBe(1);
    });

    it('can go back multiple times', () => {
      const store = useNavigationStore.getState();
      store.pushFile('a.ts');
      store.pushFile('b.ts');
      store.pushFile('c.ts');

      useNavigationStore.getState().goBack();
      const result = useNavigationStore.getState().goBack();
      expect(result).toBe('a.ts');
      expect(useNavigationStore.getState().currentIndex).toBe(0);
    });
  });

  describe('goForward', () => {
    it('returns null when history is empty', () => {
      const result = useNavigationStore.getState().goForward();
      expect(result).toBeNull();
    });

    it('returns null when at the last entry', () => {
      useNavigationStore.getState().pushFile('a.ts');
      const result = useNavigationStore.getState().goForward();
      expect(result).toBeNull();
    });

    it('returns next file path after going back', () => {
      const store = useNavigationStore.getState();
      store.pushFile('a.ts');
      store.pushFile('b.ts');
      store.pushFile('c.ts');

      useNavigationStore.getState().goBack(); // at b.ts
      const result = useNavigationStore.getState().goForward();
      expect(result).toBe('c.ts');
      expect(useNavigationStore.getState().currentIndex).toBe(2);
    });

    it('works for back-forward-back-forward sequences', () => {
      const store = useNavigationStore.getState();
      store.pushFile('a.ts');
      store.pushFile('b.ts');

      useNavigationStore.getState().goBack();
      expect(useNavigationStore.getState().currentIndex).toBe(0);

      useNavigationStore.getState().goForward();
      expect(useNavigationStore.getState().currentIndex).toBe(1);

      useNavigationStore.getState().goBack();
      expect(useNavigationStore.getState().currentIndex).toBe(0);

      const result = useNavigationStore.getState().goForward();
      expect(result).toBe('b.ts');
    });
  });

  describe('clear', () => {
    it('resets history and index', () => {
      const store = useNavigationStore.getState();
      store.pushFile('a.ts');
      store.pushFile('b.ts');
      store.pushFile('c.ts');

      useNavigationStore.getState().clear();

      const state = useNavigationStore.getState();
      expect(state.history).toHaveLength(0);
      expect(state.currentIndex).toBe(-1);
    });

    it('goBack returns null after clear', () => {
      useNavigationStore.getState().pushFile('a.ts');
      useNavigationStore.getState().clear();
      expect(useNavigationStore.getState().goBack()).toBeNull();
    });

    it('goForward returns null after clear', () => {
      useNavigationStore.getState().pushFile('a.ts');
      useNavigationStore.getState().clear();
      expect(useNavigationStore.getState().goForward()).toBeNull();
    });
  });
});
