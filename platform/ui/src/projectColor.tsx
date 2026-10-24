import { useEffect, useSyncExternalStore } from 'react';
import type { CSSProperties } from 'react';
import { listProjects } from './api';

// A project's colour, the same wherever the project shows: a flow's steps, its map, the flows
// list. Colours are a dozen hues spread round the wheel. Taking the projects in the order they
// were created, each gets the hue its slug hashes to, or the next one no project has yet: the
// first twelve projects never share a colour, and a new project never changes another's.

const HUES = [214, 262, 330, 24, 150, 190, 0, 238, 84, 44, 290, 172];

function hashIndex(slug: string): number {
  let h = 2166136261;
  for (let i = 0; i < slug.length; i++) h = Math.imul(h ^ slug.charCodeAt(i), 16777619);
  return (h >>> 0) % HUES.length;
}

/** Each project's hue: in creation order, its own hue or the next least used. */
export function assignHues(projects: { slug: string; createdAt?: string }[]): Map<string, number> {
  const ordered = [...projects].sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? '') || a.slug.localeCompare(b.slug));
  const uses = HUES.map(() => 0);
  const out = new Map<string, number>();
  for (const { slug } of ordered) {
    const fewest = Math.min(...uses);
    let i = hashIndex(slug);
    while (uses[i] > fewest) i = (i + 1) % HUES.length;
    uses[i]++;
    out.set(slug, HUES[i]);
  }
  return out;
}

// The assignment for this session's projects: loaded once, and again when a project turns up
// that it doesn't know (created since), at most every ten seconds.
let hues = new Map<string, number>();
let loadedAt = 0;
let loading = false;
const listeners = new Set<() => void>();

function load() {
  if (loading || Date.now() - loadedAt < 10_000) return;
  loading = true;
  listProjects()
    .then((projects) => { hues = assignHues(projects); listeners.forEach((l) => l()); })
    .catch(() => { /* hashed hues meanwhile */ })
    .finally(() => { loading = false; loadedAt = Date.now(); });
}

const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

/** The project's hue: its assigned one, or its own hashed hue until the projects load. */
export function useProjectHue(slug: string): number {
  return useProjectHues([slug])(slug);
}

/** Hues for several projects at once (a map's nodes): a lookup by slug. */
export function useProjectHues(slugs: string[]): (slug: string) => number {
  const assigned = useSyncExternalStore(subscribe, () => hues);
  const unknown = slugs.some((s) => !assigned.has(s));
  useEffect(() => { if (unknown) load(); }, [unknown]);
  return (slug) => assigned.get(slug) ?? HUES[hashIndex(slug)];
}

/** For SVG, which can't read the stylesheet: the colour of a project's name and swatch. */
export function projectInk(hue: number, theme: 'light' | 'dark'): string {
  return theme === 'light' ? `hsl(${hue} 65% 38%)` : `hsl(${hue} 75% 70%)`;
}

/** The hue as a CSS variable, for the .project-badge and .ft-project-avatar rules. */
const hueStyle = (hue: number) => ({ '--project-hue': hue }) as CSSProperties;

/** The project a step belongs to, in its colour. With `href` and `onOpen` it is a link: a plain
 *  click calls onOpen, a modified one (new tab, …) follows the href. */
export function ProjectBadge({ slug, name, small, href, onOpen, title }: {
  slug: string; name?: string; small?: boolean; href?: string; onOpen?: () => void; title?: string;
}) {
  const hue = useProjectHue(slug);
  const props = {
    className: `project-badge${small ? ' project-badge--small' : ''}${href ? ' project-badge--link' : ''}`,
    style: hueStyle(hue),
    'data-hue': hue,
    title: title ?? `Project ${name || slug}`,
  };
  if (!href) return <span {...props}>{name || slug}</span>;
  return (
    <a
      {...props}
      href={href}
      onClick={(e) => {
        e.stopPropagation();
        if (!onOpen || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        onOpen();
      }}
    >{name || slug}</a>
  );
}

/** A project's initials on its colour, for compact lists. */
export function ProjectAvatar({ slug, name }: { slug: string; name: string }) {
  const hue = useProjectHue(slug);
  return (
    <span className="ft-project-avatar" style={hueStyle(hue)} data-hue={hue} title={name}>
      {name.slice(0, 2).toUpperCase()}
    </span>
  );
}
