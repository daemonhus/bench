import React, { useState } from 'react';
import { blameAge, commitSubject, type BlameCell } from '../core/blame';

/** The label on the first line of a blame run: who changed it and how long ago. It links to
 *  that commit's change to the file; the tooltip adds the hash, date and subject. */
export const BlameLabel: React.FC<{ cell: BlameCell; path: string }> = ({ cell, path }) => {
  const [subject, setSubject] = useState<string | null>(null);
  const loadSubject = () => {
    if (subject === null) commitSubject(cell.commit).then(setSubject);
  };
  const when = cell.date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  const tooltip = [cell.commit, subject, `${cell.author}, ${when}`].filter(Boolean).join(' · ');
  return (
    <a
      className="blame-label"
      href={`#/diff/${cell.commit}^/${cell.commit}/${path}`}
      tabIndex={-1}
      data-tooltip={tooltip}
      aria-label={`Last changed by ${cell.author}, ${when}, in ${cell.commit}`}
      onMouseEnter={loadSubject}
    >
      <span className="blame-author">{cell.author}</span>
      <span className="blame-age">{blameAge(cell.date)}</span>
    </a>
  );
};

/** The blame column's cell beside one line; a hairline above each run after the first. */
export const BlameCellView: React.FC<{ cell: BlameCell | null; line: number; path: string }> = React.memo(({ cell, line, path }) => (
  <div className={`blame-cell ${cell?.start && line > 1 ? 'blame-cell-start' : ''}`}>
    {cell?.start && <BlameLabel cell={cell} path={path} />}
  </div>
));

BlameCellView.displayName = 'BlameCellView';
