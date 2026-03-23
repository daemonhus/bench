import { create } from 'zustand';
import type { CommitInfo, FileEntry, BranchInfo } from '../core/types';
import { gitApi } from '../core/api';
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

  loadCommits: () => Promise<void>;
  refreshGitData: () => Promise<void>;
  selectCommit: (hash: string) => Promise<void>;
  selectFile: (path: string) => Promise<void>;
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

  loadCommits: async () => {
    set({ isLoading: true, error: null });
    try {
      const [commits, info, branches] = await Promise.all([
        gitApi.listCommits(50),
        gitApi.getInfo().catch(() => ({ name: '', defaultBranch: '', remoteUrl: '' })),
        gitApi.listBranches().catch(() => [] as BranchInfo[]),
      ]);
      set({ commits, branches, repoName: info.name || null, remoteUrl: info.remoteUrl || null });
      if (commits.length > 0) {
        await get().selectCommit(commits[0].hash);
      }
    } catch (err) {
      set({ error: String(err), isLoading: false });
    }
  },

  refreshGitData: async () => {
    try {
      const [commits, branches] = await Promise.all([
        gitApi.listCommits(50),
        gitApi.listBranches().catch(() => [] as BranchInfo[]),
      ]);
      set({ commits, branches });
    } catch {
      // Silent — polling failure shouldn't show errors
    }
  },

  selectCommit: async (hash) => {
    set({ currentCommit: hash, isLoading: true, error: null });
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

    set({ selectedFilePath: path, isLoading: true, error: null });
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
