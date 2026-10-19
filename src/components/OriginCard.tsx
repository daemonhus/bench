import { useState } from 'react';
import { EditableText } from './EditableText';
import type { Origin, OriginSuggestion } from '../core/types';

/** Origin, on the finding and feature pages: an explanation plus where, when and by whom. */
export function OriginCard({ origin, onChange, suggest }: {
  origin: Origin;
  onChange: (o: Partial<Origin>) => void;
  /** Blame-derived suggestion for the anchored lines; fills only the empty fields. */
  suggest?: () => Promise<OriginSuggestion>;
}) {
  const [suggesting, setSuggesting] = useState(false);
  const [noSuggestion, setNoSuggestion] = useState(false);
  const runSuggest = async () => {
    if (!suggest) return;
    setSuggesting(true);
    setNoSuggestion(false);
    try {
      const s = await suggest();
      const fill: Partial<Origin> = {};
      if (!origin.introducedCommit && s.introducedCommit) fill.introducedCommit = s.introducedCommit;
      if (!origin.introducedDate && s.introducedDate) fill.introducedDate = s.introducedDate;
      if (!origin.actor && s.actor) fill.actor = s.actor;
      if (!origin.branch && s.branch) fill.branch = s.branch;
      // The merge subject usually says more than the commit: something concrete to refine.
      if (!origin.explanation && s.mergeSubject) fill.explanation = s.mergeSubject;
      if (Object.keys(fill).length) onChange(fill); else setNoSuggestion(true);
    } catch {
      setNoSuggestion(true); // no blame data (orphaned anchor, deleted file)
    } finally {
      setSuggesting(false);
    }
  };
  return (
    <div className="fd-card">
      <h2 className="fd-card-title">
        Origin
        {suggest && (
          <button type="button" className="fd-card-action" onClick={runSuggest} disabled={suggesting}>
            {suggesting ? 'Looking…' : noSuggestion ? 'Nothing to suggest' : 'Suggest from git'}
          </button>
        )}
      </h2>
      <div className="fd-description fd-origin-text">
        <EditableText value={origin.explanation ?? ''} placeholder="Add an explanation…" label="Origin explanation" multiline
          onChange={(explanation) => onChange({ explanation })} />
      </div>
      <div className="fd-provenance">
        <div className="fd-prov-row">
          <span className="fd-prov-label">Introduced in</span>
          <span className="fd-prov-val fd-mono"><EditableText className="editable-inline" value={origin.introducedCommit ?? ''} placeholder="—" label="Introduced in commit" plain
            onChange={(introducedCommit) => onChange({ introducedCommit: introducedCommit.trim() })} /></span>
        </div>
        <div className="fd-prov-row">
          <span className="fd-prov-label">On</span>
          <span className="fd-prov-val"><EditableText className="editable-inline" value={origin.introducedDate ?? ''} placeholder="—" label="Introduced on" plain
            onChange={(introducedDate) => onChange({ introducedDate: introducedDate.trim() })} /></span>
        </div>
        <div className="fd-prov-row">
          <span className="fd-prov-label">Branch</span>
          <span className="fd-prov-val fd-mono"><EditableText className="editable-inline" value={origin.branch ?? ''} placeholder="—" label="Introduced on branch" plain
            onChange={(branch) => onChange({ branch: branch.trim() })} /></span>
        </div>
        <div className="fd-prov-row">
          <span className="fd-prov-label">By</span>
          <span className="fd-prov-val"><EditableText className="editable-inline" value={origin.actor ?? ''} placeholder="—" label="Introduced by" plain
            onChange={(actor) => onChange({ actor: actor.trim() })} /></span>
        </div>
      </div>
    </div>
  );
}
