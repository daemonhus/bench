import { useEffect, useRef, useState } from 'react';
import { KIND_COLORS } from '@bench/components/FeatureCard';
import { METHOD_COLORS } from '@bench/core/status-options';
import type { Comment } from '@bench/core/types';
import type { Project } from './api';
import type { Hit, Kind } from './searchModel';

// Pieces shared by the home page's search dropdown and the search page.

/** The title with the matched text marked, when the query appears in it as typed. */
export function Highlight({ text, q }: { text: string; q: string }) {
  const at = text.toLowerCase().indexOf(q.trim().toLowerCase());
  if (!q.trim() || at < 0) return <>{text}</>;
  const end = at + q.trim().length;
  return <>{text.slice(0, at)}<mark className="home-search-mark">{text.slice(at, end)}</mark>{text.slice(end)}</>;
}

export function KindIcon({ kind }: { kind: Kind }) {
  const common = { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };
  if (kind === 'project') return <svg {...common}><path d="M2 4.5h4l1.5 1.5H14v6.5H2z" /></svg>;
  if (kind === 'finding') return <svg {...common}><path d="M8 1.75 13.5 4v4c0 3.1-2.3 5.4-5.5 6.25C4.8 13.4 2.5 11.1 2.5 8V4z" /><path d="M8 5.5v3" /><path d="M8 10.75v.01" /></svg>;
  if (kind === 'feature') return <svg {...common}><circle cx="4" cy="8" r="2" /><circle cx="12" cy="4" r="2" /><circle cx="12" cy="12" r="2" /><path d="M5.8 7.1 10.2 4.9M5.8 8.9l4.4 2.2" /></svg>;
  return <svg {...common}><path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" /></svg>;
}

/** A hit's icon, marked title and muted second line (the dropdown's row). */
export function HitBody({ h, q }: { h: Hit; q: string }) {
  return (
    <>
      <span className="home-search-icon"><KindIcon kind={h.kind} /></span>
      <span className="home-search-text">
        <span className="home-search-title">
          {h.severity && <span className="home-dot" style={{ background: `var(--severity-${h.severity})` }} aria-hidden="true" />}
          {h.method
            ? <span className="feature-method-badge" style={{ background: METHOD_COLORS[h.method] }}>{h.method}</span>
            : h.featureKind && <span className="home-dot" style={{ background: KIND_COLORS[h.featureKind as keyof typeof KIND_COLORS] }} aria-hidden="true" />}
          <span className="home-search-label"><Highlight text={h.title} q={q} /></span>
        </span>
        <span className="home-search-sub">{h.sub}</span>
      </span>
    </>
  );
}

let lastComments: { slugs: string; comments: Record<string, Comment[]> } | null = null;

/** Every project's comments (resolved too), fetched the first time `enabled` is true; null
 *  until they arrive. Pages don't otherwise load comments, so searching does it on demand. */
export function useSearchComments(projects: Project[], enabled: boolean): Record<string, Comment[]> | null {
  const slugs = projects.map((p) => p.slug).join(',');
  // The last set fetched shows at once (the dropdown hands over to the search page) while a
  // fresh one loads.
  const [comments, setComments] = useState<Record<string, Comment[]> | null>(lastComments?.slugs === slugs ? lastComments.comments : null);
  const fetchedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!enabled || !slugs || fetchedFor.current === slugs) return;
    fetchedFor.current = slugs;
    let live = true, done = false;
    Promise.all(slugs.split(',').map(async (slug): Promise<[string, Comment[]]> => {
      try {
        const res = await fetch(`/api/projects/${slug}/comments?include_resolved=true`);
        return [slug, res.ok ? await res.json() : []];
      } catch { return [slug, []]; }
    })).then((entries) => {
      done = true;
      const next = Object.fromEntries(entries);
      lastComments = { slugs, comments: next };
      if (live) setComments(next);
    });
    // Abandoned before it finished (unmounted, or the project list changed): fetch again next time.
    return () => { live = false; if (!done) fetchedFor.current = null; };
  }, [enabled, slugs]);
  return comments;
}
