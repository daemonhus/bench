import { create } from 'zustand';
import type { CommitInfo, FileEntry, BranchInfo, ReviewBranch } from '../core/types';
import { gitApi, reviewBranchApi, getApiBase, addressBranch } from '../core/api';
import { detectLanguage, ensureLanguageRegistered } from '../core/language-map';

interface RepoState {
  repoName: string | null;
  remoteUrl: string | null;
  commits: CommitInfo[];
  branches: BranchInfo[];
  currentCommit: string | null;
  files: FileEntry[];
  selectedFilePath: string | null;
  fileContent: string | null;
  fileLanguage: string | null;
  isLoading: boolean;
  error: string | null;
  /** The branch the project is looked at on (see ReviewBranch). */
  reviewBranch: ReviewBranch | null;
  /** Bumped when the review branch becomes another one: the workbench remounts to load on it. */
  branchEpoch: number;

  loadCommits: () => Promise<void>;
  refreshGitData: () => Promise<void>;
  /** Make `name` the project's review branch ('' for the default), for everyone. */
  setReviewBranch: (name: string) => Promise<void>;
  /** Stop following the address's ?branch= and go back to the project's branch. */
  followProjectBranch: () => Promise<void>;
  selectCommit: (hash: string) => Promise<void>;
  selectFile: (path: string) => Promise<void>;
}

// Which project the review branch was loaded for: a branch change counts only within one.
let reviewBranchBase = '';

/** Drop ?branch= from the address, keeping the rest (the route after #). */
function dropAddressBranch() {
  const url = new URL(window.location.href);
  if (!url.searchParams.has('branch')) return;
  url.searchParams.delete('branch');
  window.history.replaceState(window.history.state, '', url);
}

function applyReviewBranch(b: ReviewBranch) {
  const { reviewBranch: prev, branchEpoch } = useRepoStore.getState();
  const sameProject = reviewBranchBase === getApiBase();
  reviewBranchBase = getApiBase();
  useRepoStore.setState({
    reviewBranch: b,
    branchEpoch: branchEpoch + (prev && sameProject && prev.name !== b.name ? 1 : 0),
  });
}

export const useRepoStore = create<RepoState>((set, get) => ({
  repoName: null,
  remoteUrl: null,
  commits: [],
  branches: [],
  currentCommit: null,
  files: [],
  selectedFilePath: null,
  fileContent: null,
  fileLanguage: null,
  isLoading: false,
  error: null,
  reviewBranch: null,
  branchEpoch: 0,

  loadCommits: async () => {
    set({ isLoading: true, error: null });
    try {
      const [commits, info, branches, reviewBranch] = await Promise.all([
        gitApi.listCommits(50),
        gitApi.getInfo().catch(() => ({ name: '', defaultBranch: '', remoteUrl: '' })),
        gitApi.listBranches().catch(() => [] as BranchInfo[]),
        reviewBranchApi.get().catch(() => null),
      ]);
      set({ commits, branches, repoName: info.name || null, remoteUrl: info.remoteUrl || null });
      if (reviewBranch) applyReviewBranch(reviewBranch);
      if (commits.length > 0) {
        await get().selectCommit(commits[0].hash);
      }
    } catch (err) {
      set({ error: String(err), isLoading: false });
    }
  },

  refreshGitData: async () => {
    try {
      const [commits, branches, reviewBranch] = await Promise.all([
        gitApi.listCommits(50),
        gitApi.listBranches().catch(() => [] as BranchInfo[]),
        reviewBranchApi.get().catch(() => null),
      ]);
      set({ commits, branches });
      if (reviewBranch) applyReviewBranch(reviewBranch);
    } catch {
      // Silent - polling failure shouldn't show errors
    }
  },

  setReviewBranch: async (name) => {
    dropAddressBranch();
    applyReviewBranch(await reviewBranchApi.set(name));
  },

  followProjectBranch: async () => {
    if (!addressBranch()) return;
    dropAddressBranch();
    applyReviewBranch(await reviewBranchApi.get());
  },

  // While an open file reloads (another commit, or the same file again) it stays on screen:
  // "Loading..." would unmount the code view, and the focus in it, for the moment the fetch takes.
  selectCommit: async (hash) => {
    set({ currentCommit: hash, isLoading: get().fileContent === null, error: null });
    try {
      const files = (await gitApi.listFiles(hash)) ?? [];
      const prevFile = get().selectedFilePath;
      const fileStillExists = prevFile && files.some((f) => f.path === prevFile);
      set({
        files,
        isLoading: false,
        selectedFilePath: fileStillExists ? prevFile : null,
        fileContent: fileStillExists ? get().fileContent : null,
        fileLanguage: fileStillExists ? get().fileLanguage : null,
      });
      if (fileStillExists && prevFile) {
        await get().selectFile(prevFile);
      }
    } catch (err) {
      set({ error: String(err), isLoading: false });
    }
  },

  selectFile: async (path) => {
    const { currentCommit } = get();
    if (!currentCommit) return;

    const reload = path === get().selectedFilePath && get().fileContent !== null;
    set({ selectedFilePath: path, isLoading: !reload, error: null });
    try {
      const lang = detectLanguage(path);
      if (lang) await ensureLanguageRegistered(lang);

      const { content } = await gitApi.getFileContent(currentCommit, path);
      set({ fileContent: content, fileLanguage: lang, isLoading: false });
    } catch (err) {
      set({ error: String(err), isLoading: false });
    }
  },
}));
