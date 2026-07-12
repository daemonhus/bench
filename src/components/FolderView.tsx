import React, { useEffect, useMemo } from 'react';
import type { FileEntry } from '../core/types';
import { useNavList } from '../core/use-nav-list';

interface FolderViewProps {
  files: FileEntry[];
  dirPath: string; // e.g. "src/core" or "" for root
  onSelectFile: (path: string) => void;
  onNavigateDir: (dir: string) => void;
}

interface DirEntry {
  id: string;
  name: string;
  fullPath: string;
  isDir: boolean;
  isParent?: boolean;
  childCount?: number;
}

export const FolderView: React.FC<FolderViewProps> = ({
  files,
  dirPath,
  onSelectFile,
  onNavigateDir,
}) => {
  const parentDir = dirPath.includes('/')
    ? dirPath.slice(0, dirPath.lastIndexOf('/'))
    : '';

  const entries = useMemo<DirEntry[]>(() => {
    const prefix = dirPath ? dirPath + '/' : '';
    const seen = new Set<string>();
    const result: DirEntry[] = [];

    for (const f of files) {
      if (!f.path.startsWith(prefix)) continue;
      const rest = f.path.slice(prefix.length);
      const slashIdx = rest.indexOf('/');

      if (slashIdx === -1) {
        result.push({ id: f.path, name: rest, fullPath: f.path, isDir: false });
      } else {
        const dirName = rest.slice(0, slashIdx);
        const dirFullPath = prefix + dirName;
        if (!seen.has(dirFullPath)) {
          seen.add(dirFullPath);
          const childPrefix = dirFullPath + '/';
          const count = files.filter((c) => c.path.startsWith(childPrefix)).length;
          result.push({ id: dirFullPath, name: dirName, fullPath: dirFullPath, isDir: true, childCount: count });
        }
      }
    }

    result.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    if (dirPath) {
      result.unshift({ id: '__parent__', name: '..', fullPath: parentDir, isDir: true, isParent: true });
    }

    return result;
  }, [files, dirPath, parentDir]);

  const activate = (entry: DirEntry) => {
    if (entry.isDir) onNavigateDir(entry.fullPath);
    else onSelectFile(entry.fullPath);
  };

  const { focusedId, containerRef, handleKeyDown, handleFocus, handleBlur } = useNavList<DirEntry>({
    items: entries,
    getId: (e) => e.id,
    onActivate: activate,
  });

  // Auto-focus the container when entering this view (or when dirPath changes)
  // so arrow keys work immediately without a click.
  useEffect(() => {
    containerRef.current?.focus({ preventScroll: true });
  }, [dirPath, containerRef]);

  return (
    <div
      className="folder-view"
      ref={containerRef}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      onFocus={handleFocus}
      onBlur={handleBlur}
      data-nav-area="folder-view"
    >
      <div className="folder-header">
        {dirPath || '.'}/
      </div>
      {entries.map((entry) => (
        <div
          key={entry.id}
          data-nav-id={entry.id}
          data-nav-focused={focusedId === entry.id ? 'true' : undefined}
          className={`folder-entry ${entry.isDir ? 'folder-entry-dir' : 'folder-entry-file'}`}
          onClick={() => activate(entry)}
        >
          {entry.isDir ? (
            <>
              <span className="folder-icon">{entry.isParent ? '../' : `${entry.name}/`}</span>
              {!entry.isParent && <span className="folder-count">{entry.childCount}</span>}
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
