import React, { useMemo, useState, useEffect, useCallback, useRef } from 'react';
import type { FileEntry, Severity } from '../core/types';

interface TreeNode {
  name: string;
  fullPath: string;
  isDirectory: boolean;
  children: TreeNode[];
}

export interface SeverityIndicator {
  severity: Severity;
  isOpen: boolean;
}

interface FileTreeProps {
  files: FileEntry[];
  selectedFile: string | null;
  onSelectFile: (path: string) => void;
  severityMap?: Map<string, SeverityIndicator>;
}

const SEV_ORDER: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };

function isBetter(a: SeverityIndicator, b: SeverityIndicator | null): boolean {
  if (!b) return true;
  if (SEV_ORDER[a.severity] < SEV_ORDER[b.severity]) return true;
  if (SEV_ORDER[a.severity] === SEV_ORDER[b.severity] && a.isOpen && !b.isOpen) return true;
  return false;
}

function buildTree(files: FileEntry[]): TreeNode[] {
  const root: TreeNode[] = [];

  for (const file of files) {
    const parts = file.path.split('/');
    let current = root;

    for (let i = 0; i < parts.length; i++) {
      const name = parts[i];
      const fullPath = parts.slice(0, i + 1).join('/');
      const isDir = i < parts.length - 1;

      let node = current.find((n) => n.name === name && n.isDirectory === isDir);
      if (!node) {
        node = { name, fullPath, isDirectory: isDir, children: [] };
        current.push(node);
      }
      current = node.children;
    }
  }

  // Sort: directories first, then alphabetically
  function sortNodes(nodes: TreeNode[]): TreeNode[] {
    nodes.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const node of nodes) {
      if (node.children.length > 0) sortNodes(node.children);
    }
    return nodes;
  }

  return sortNodes(root);
}

function getParentPaths(path: string): string[] {
  const parts = path.split('/');
  const paths: string[] = [];
  for (let i = 1; i < parts.length; i++) {
    paths.push(parts.slice(0, i).join('/'));
  }
  return paths;
}

/** Flatten the visible tree (respecting expanded state) into a list of paths */
function flattenVisible(nodes: TreeNode[], expanded: Set<string>): TreeNode[] {
  const result: TreeNode[] = [];
  for (const node of nodes) {
    result.push(node);
    if (node.isDirectory && expanded.has(node.fullPath)) {
      result.push(...flattenVisible(node.children, expanded));
    }
  }
  return result;
}

/** Pre-compute folder-level severity indicators from a file-level map */
function buildFolderSeverityMap(
  fileMap: Map<string, SeverityIndicator>,
): Map<string, SeverityIndicator> {
  const folderMap = new Map<string, SeverityIndicator>();
  for (const [filePath, info] of fileMap) {
    // Walk up all parent directories
    const parts = filePath.split('/');
    for (let i = 1; i < parts.length; i++) {
      const dirPath = parts.slice(0, i).join('/');
      const existing = folderMap.get(dirPath) ?? null;
      if (isBetter(info, existing)) {
        folderMap.set(dirPath, info);
      }
    }
  }
  return folderMap;
}

const SeverityDot: React.FC<{ indicator: SeverityIndicator }> = ({ indicator }) => (
  <span
    className={`tree-severity-dot tree-severity-${indicator.severity}${indicator.isOpen ? '' : ' tree-severity-outline'}`}
    title={`${indicator.severity}${indicator.isOpen ? '' : ' (closed)'}`}
  />
);

const TreeNodeRow: React.FC<{
  node: TreeNode;
  depth: number;
  expanded: Set<string>;
  selectedFile: string | null;
  focusedPath: string | null;
  severityMap?: Map<string, SeverityIndicator>;
  folderSeverityMap?: Map<string, SeverityIndicator>;
  onToggle: (path: string) => void;
  onSelectFile: (path: string) => void;
}> = ({ node, depth, expanded, selectedFile, focusedPath, severityMap, folderSeverityMap, onToggle, onSelectFile }) => {
  const isExpanded = expanded.has(node.fullPath);
  const isSelected = node.fullPath === selectedFile;
  const isFocused = node.fullPath === focusedPath;

  const indicator = node.isDirectory
    ? folderSeverityMap?.get(node.fullPath) ?? null
    : severityMap?.get(node.fullPath) ?? null;

  if (node.isDirectory) {
    return (
      <>
        <div
          className={`tree-node tree-dir ${isFocused ? 'tree-focused' : ''}`}
          style={{ paddingLeft: depth * 16 + 8 }}
          onClick={() => onToggle(node.fullPath)}
          data-tree-path={node.fullPath}
        >
          <span className="tree-arrow">{isExpanded ? '\u25BE' : '\u25B8'}</span>
          <span className="tree-name">{node.name}</span>
          {indicator && <SeverityDot indicator={indicator} />}
        </div>
        {isExpanded &&
          node.children.map((child) => (
            <TreeNodeRow
              key={child.fullPath}
              node={child}
              depth={depth + 1}
              expanded={expanded}
              selectedFile={selectedFile}
              focusedPath={focusedPath}
              severityMap={severityMap}
              folderSeverityMap={folderSeverityMap}
              onToggle={onToggle}
              onSelectFile={onSelectFile}
            />
          ))}
      </>
    );
  }

  return (
    <div
      className={`tree-node tree-file ${isSelected ? 'tree-selected' : ''} ${isFocused ? 'tree-focused' : ''}`}
      style={{ paddingLeft: depth * 16 + 8 }}
      onClick={() => onSelectFile(node.fullPath)}
      data-tree-path={node.fullPath}
    >
      <span className="tree-name">{node.name}</span>
      {indicator && <SeverityDot indicator={indicator} />}
    </div>
  );
};

export const FileTree: React.FC<FileTreeProps> = ({ files, selectedFile, onSelectFile, severityMap }) => {
  const tree = useMemo(() => buildTree(files), [files]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [focusedPath, setFocusedPath] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Pre-compute folder severity from file severity map
  const folderSeverityMap = useMemo(
    () => severityMap ? buildFolderSeverityMap(severityMap) : undefined,
    [severityMap],
  );

  // Auto-expand path to selected file
  useEffect(() => {
    if (!selectedFile) return;
    const parents = getParentPaths(selectedFile);
    setExpanded((prev) => {
      const next = new Set(prev);
      let changed = false;
      for (const p of parents) {
        if (!next.has(p)) {
          next.add(p);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [selectedFile]);

  const handleToggle = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  // Flatten visible nodes for keyboard navigation
  const visibleNodes = useMemo(() => flattenVisible(tree, expanded), [tree, expanded]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (visibleNodes.length === 0) return;

      const currentIndex = focusedPath
        ? visibleNodes.findIndex((n) => n.fullPath === focusedPath)
        : -1;

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        const next = Math.min(currentIndex + 1, visibleNodes.length - 1);
        setFocusedPath(visibleNodes[next].fullPath);
        // Scroll into view
        const el = containerRef.current?.querySelector(`[data-tree-path="${CSS.escape(visibleNodes[next].fullPath)}"]`);
        el?.scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        const prev = Math.max(currentIndex - 1, 0);
        setFocusedPath(visibleNodes[prev].fullPath);
        const el = containerRef.current?.querySelector(`[data-tree-path="${CSS.escape(visibleNodes[prev].fullPath)}"]`);
        el?.scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (currentIndex < 0) return;
        const node = visibleNodes[currentIndex];
        if (node.isDirectory) {
          handleToggle(node.fullPath);
        } else {
          onSelectFile(node.fullPath);
        }
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        if (currentIndex < 0) return;
        const node = visibleNodes[currentIndex];
        if (node.isDirectory && !expanded.has(node.fullPath)) {
          handleToggle(node.fullPath);
        }
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        if (currentIndex < 0) return;
        const node = visibleNodes[currentIndex];
        if (node.isDirectory && expanded.has(node.fullPath)) {
          handleToggle(node.fullPath);
        }
      }
    },
    [visibleNodes, focusedPath, expanded, handleToggle, onSelectFile],
  );

  return (
    <div
      className="file-tree"
      ref={containerRef}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      onFocus={() => {
        if (!focusedPath && visibleNodes.length > 0) {
          setFocusedPath(visibleNodes[0].fullPath);
        }
      }}
    >
      {tree.map((node) => (
        <TreeNodeRow
          key={node.fullPath}
          node={node}
          depth={0}
          expanded={expanded}
          selectedFile={selectedFile}
          focusedPath={focusedPath}
          severityMap={severityMap}
          folderSeverityMap={folderSeverityMap}
          onToggle={handleToggle}
          onSelectFile={onSelectFile}
        />
      ))}
    </div>
  );
};
