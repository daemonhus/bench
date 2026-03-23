import { create } from 'zustand';

interface NavigationEntry {
  filePath: string;
}

interface NavigationState {
  history: NavigationEntry[];
  currentIndex: number;
  pushFile: (path: string) => void;
  goBack: () => string | null;
  goForward: () => string | null;
  clear: () => void;
}

export const useNavigationStore = create<NavigationState>((set, get) => ({
  history: [],
  currentIndex: -1,

  pushFile: (path) => {
    const { history, currentIndex } = get();
    // Skip if same as current entry
    if (currentIndex >= 0 && history[currentIndex].filePath === path) return;
    // Truncate forward history, then push
    const truncated = history.slice(0, currentIndex + 1);
    truncated.push({ filePath: path });
    set({ history: truncated, currentIndex: truncated.length - 1 });
  },

  goBack: () => {
    const { history, currentIndex } = get();
    if (currentIndex <= 0) return null;
    const newIndex = currentIndex - 1;
    set({ currentIndex: newIndex });
    return history[newIndex].filePath;
  },

  goForward: () => {
    const { history, currentIndex } = get();
    if (currentIndex >= history.length - 1) return null;
    const newIndex = currentIndex + 1;
    set({ currentIndex: newIndex });
    return history[newIndex].filePath;
  },

  clear: () => set({ history: [], currentIndex: -1 }),
}));
