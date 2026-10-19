import type { Anchor } from '../core/types';
import { EditableText } from './EditableText';

// The hero footer's location on the finding and feature pages: file and line range, each editable
// in place (to correct where the annotation points), with a link to open it in Browse. When the
// reconciler has tracked it elsewhere at HEAD, that position is shown alongside.

export interface LocationChange { file_id?: string; line_start?: number; line_end?: number }

export function LocationField({ anchor, effective, onChange }: {
  anchor: Anchor;
  effective?: Anchor;
  onChange: (change: LocationChange) => void;
}) {
  const start = anchor.lineRange?.start;
  const end = anchor.lineRange?.end;
  const lines = start ? (end && end !== start ? `${start}–${end}` : String(start)) : '';
  // One field for the range: "100" or "100-104" (any dash).
  const setLines = (v: string) => {
    const m = v.trim().match(/^(\d+)\s*(?:[-–—]\s*(\d+))?$/);
    if (!m) return;
    const s = Number(m[1]), e = m[2] ? Number(m[2]) : s;
    if (s > 0 && e >= s) onChange({ line_start: s, line_end: e });
  };
  const eff = effective;
  const moved = eff && (eff.fileId !== anchor.fileId || eff.lineRange?.start !== start || eff.lineRange?.end !== end);
  const open = (a: Anchor) => { window.location.hash = `#/browse/${a.fileId}`; };
  return (
    <span className="fd-anchor">
      <EditableText className="editable-inline fd-anchor-file" value={anchor.fileId} placeholder="file" label="File" plain
        onChange={(v) => { if (v.trim()) onChange({ file_id: v.trim() }); }} />
      <span className="fd-sep">:</span>
      <EditableText className="editable-inline" value={lines} placeholder="lines" label="Lines" plain onChange={setLines} />
      <button type="button" className="fd-card-action fd-anchor-open" onClick={() => open(moved && eff ? eff : anchor)}>Open in Browse</button>
      {moved && eff && (
        <span className="fd-anchor-now">
          now at {eff.fileId}{eff.lineRange ? `:${eff.lineRange.start}${eff.lineRange.end !== eff.lineRange.start ? `–${eff.lineRange.end}` : ''}` : ''}
        </span>
      )}
    </span>
  );
}
