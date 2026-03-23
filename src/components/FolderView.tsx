import React, { useMemo } from 'react';
import type { FileEntry } from '../core/types';

interface FolderViewProps {
  files: FileEntry[];
  dirPath: string; // e.g. "src/core" or "" for root
  onSelectFile: (path: string) => void;
  onNavigateDir: (dir: string) => void;
}

interface DirEntry {
  name: string;
  fullPath: string;
  isDir: boolean;
  childCount?: number;
}

export const FolderView: React.FC<FolderViewProps> = ({
  files,
  dirPath,
  onSelectFile,
  onNavigateDir,
}) => {
  const entries = useMemo<DirEntry[]>(() => {
    const prefix = dirPath ? dirPath + '/' : '';
    const seen = new Set<string>();
    const result: DirEntry[] = [];

    for (const f of files) {
      if (!f.path.startsWith(prefix)) continue;
      const rest = f.path.slice(prefix.length);
      const slashIdx = rest.indexOf('/');

      if (slashIdx === -1) {
        // Direct file child
        result.push({ name: rest, fullPath: f.path, isDir: false });
      } else {
        // Directory child
        const dirName = rest.slice(0, slashIdx);
        const dirFullPath = prefix + dirName;
        if (!seen.has(dirFullPath)) {
          seen.add(dirFullPath);
          // Count children in this directory
          const childPrefix = dirFullPath + '/';
          const count = files.filter((c) => c.path.startsWith(childPrefix)).length;
          result.push({ name: dirName, fullPath: dirFullPath, isDir: true, childCount: count });
        }
      }
    }

    // Sort: dirs first, then alpha
    result.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    return result;
  }, [files, dirPath]);

  const parentDir = dirPath.includes('/')
    ? dirPath.slice(0, dirPath.lastIndexOf('/'))
    : '';

  return (
    <div className="folder-view">
      <div className="folder-header">
        {dirPath || '.'}/
      </div>
      {dirPath && (
        <div
          className="folder-entry folder-entry-dir"
          onClick={() => onNavigateDir(parentDir)}
        >
          <span className="folder-icon">../</span>
        </div>
      )}
      {entries.map((entry) => (
        <div
          key={entry.fullPath}
          className={`folder-entry ${entry.isDir ? 'folder-entry-dir' : 'folder-entry-file'}`}
          onClick={() => entry.isDir ? onNavigateDir(entry.fullPath) : onSelectFile(entry.fullPath)}
        >
          {entry.isDir ? (
            <>
              <span className="folder-icon">{entry.name}/</span>
              <span className="folder-count">{entry.childCount}</span>
            </>
          ) : (
            <span className="folder-name">{entry.name}</span>
          )}
        </div>
      ))}
      {entries.length === 0 && (
        <div className="folder-empty">Empty directory</div>
      )}
    </div>
  );
};
