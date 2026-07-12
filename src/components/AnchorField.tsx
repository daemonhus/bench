import React, { useEffect, useState, useRef } from 'react';
import { gitApi } from '../core/api';
import { useRepoStore } from '../stores/repo-store';

interface AnchorFieldProps {
  fileId: string;
  lineStart: string; // string so an empty input round-trips cleanly
  lineEnd: string;
  onFileIdChange: (v: string) => void;
  onLineStartChange: (v: string) => void;
  onLineEndChange: (v: string) => void;
  /** Commit to resolve files and previews against. Defaults to current repo commit. */
  commit?: string;
  /** Suppress the preview block (compact callers). */
  hidePreview?: boolean;
}

// Module-scoped cache: file lists by commit. The file tree at a commit is
// stable, so one fetch per session per commit is plenty.
const fileListCache = new Map<string, string[]>();

async function loadFileList(commit: string): Promise<string[]> {
  const cached = fileListCache.get(commit);
  if (cached) return cached;
  try {
    const entries = await gitApi.listFiles(commit);
    const paths = entries.filter((e) => e.type === 'blob').map((e) => e.path);
    fileListCache.set(commit, paths);
    return paths;
  } catch {
    return [];
  }
}

export const AnchorField: React.FC<AnchorFieldProps> = ({
  fileId,
  lineStart,
  lineEnd,
  onFileIdChange,
  onLineStartChange,
  onLineEndChange,
  commit,
  hidePreview,
}) => {
  const repoCommit = useRepoStore((s) => s.currentCommit);
  const resolvedCommit = commit || repoCommit || 'HEAD';
  const datalistId = useRef(`anchor-files-${Math.random().toString(36).slice(2, 9)}`);
  const [files, setFiles] = useState<string[]>(() => fileListCache.get(resolvedCommit) ?? []);
  const [preview, setPreview] = useState<string[] | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const previewSeq = useRef(0);

  useEffect(() => {
    let cancelled = false;
    loadFileList(resolvedCommit).then((paths) => { if (!cancelled) setFiles(paths); });
    return () => { cancelled = true; };
  }, [resolvedCommit]);

  // Fetch a small preview slice when a valid file + line range is set.
  useEffect(() => {
    if (hidePreview) return;
    const start = parseInt(lineStart, 10);
    const end = parseInt(lineEnd, 10) || start;
    const trimmed = fileId.trim();
    if (!trimmed || !start || start <= 0 || end < start) {
      setPreview(null);
      setPreviewError(null);
      return;
    }
    if (!files.includes(trimmed)) {
      setPreview(null);
      setPreviewError(null);
      return;
    }
    const seq = ++previewSeq.current;
    let cancelled = false;
    gitApi.getFileContent(resolvedCommit, trimmed)
      .then(({ content }) => {
        if (cancelled || seq !== previewSeq.current) return;
        const lines = content.split('\n');
        const slice = lines.slice(Math.max(0, start - 1), Math.min(lines.length, end));
        setPreview(slice);
        setPreviewError(null);
      })
      .catch((err) => {
        if (cancelled || seq !== previewSeq.current) return;
        setPreview(null);
        setPreviewError(String(err?.message ?? err));
      });
    return () => { cancelled = true; };
  }, [fileId, lineStart, lineEnd, files, resolvedCommit, hidePreview]);

  const startNum = parseInt(lineStart, 10) || 0;
  const endNum = parseInt(lineEnd, 10) || 0;
  // Both fields filled but end is before start. Don't flag a partially-typed
  // range (only one field populated) - that's a transient state, not an error.
  const rangeInvalid = startNum > 0 && endNum > 0 && endNum < startNum;

  return (
    <div className="anchor-field">
      <div className="anchor-field-row">
        <input
          type="text"
          className="anchor-field-file"
          list={datalistId.current}
          placeholder="path/to/file"
          value={fileId}
          onChange={(e) => onFileIdChange(e.target.value)}
        />
        <datalist id={datalistId.current}>
          {files.slice(0, 500).map((p) => (
            <option key={p} value={p} />
          ))}
        </datalist>
        <div className="anchor-field-lines">
          <input
            type="number"
            className={`anchor-field-line${rangeInvalid ? ' anchor-field-line-invalid' : ''}`}
            placeholder="start"
            min={1}
            value={lineStart}
            onChange={(e) => onLineStartChange(e.target.value)}
            aria-invalid={rangeInvalid || undefined}
          />
          <span className="anchor-field-line-sep">–</span>
          <input
            type="number"
            className={`anchor-field-line${rangeInvalid ? ' anchor-field-line-invalid' : ''}`}
            placeholder="end"
            min={1}
            value={lineEnd}
            onChange={(e) => onLineEndChange(e.target.value)}
            aria-invalid={rangeInvalid || undefined}
          />
        </div>
      </div>
      {!hidePreview && preview && preview.length > 0 && (
        <pre className="anchor-field-preview">
          {preview.map((line, i) => (
            <div key={i} className="anchor-field-preview-line">
              <span className="anchor-field-preview-num">{startNum + i}</span>
              <span className="anchor-field-preview-text">{line || ' '}</span>
            </div>
          ))}
        </pre>
      )}
      {rangeInvalid && (
        <div className="anchor-field-preview-error">End line must be ≥ start line.</div>
      )}
      {!hidePreview && previewError && (
        <div className="anchor-field-preview-error">Could not load preview: {previewError}</div>
      )}
    </div>
  );
};
