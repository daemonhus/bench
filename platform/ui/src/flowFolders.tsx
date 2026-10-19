import { useEffect, useMemo, useRef, useState } from 'react';
import { useModalFocus } from './useModalFocus';

// ─── Flow folders: API, paths, breadcrumb, move menu, dialogs, drag and drop ───

export interface FlowFolder {
  id: string;
  name: string;
  parentId?: string;
  flowCount: number;
  folderCount: number;
  createdAt: string;
  updatedAt: string;
}

const FOLDERS = '/api/platform/flow-folders';

async function ok<T>(r: Response): Promise<T> {
  if (!r.ok) throw new Error((await r.text()).trim() || r.statusText);
  return r.json();
}
const json = (method: string, body: unknown): RequestInit => ({
  method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

export const listFolders = () => fetch(FOLDERS).then((r) => ok<FlowFolder[]>(r));
export const createFolder = (name: string, parentId?: string) =>
  fetch(FOLDERS, json('POST', { name, parentId: parentId ?? '' })).then((r) => ok<FlowFolder>(r));
export const renameFolder = (id: string, name: string) =>
  fetch(`${FOLDERS}/${id}`, json('PATCH', { name })).then((r) => ok<FlowFolder>(r));
/** Without confirm this only previews how much would be deleted. */
export const deleteFolder = (id: string, confirm: boolean) =>
  fetch(`${FOLDERS}/${id}${confirm ? '?confirm=true' : ''}`, { method: 'DELETE' })
    .then((r) => ok<{ folders: number; flows: number }>(r));
export const moveItems = (items: DragItem[], targetFolderId: string) =>
  fetch('/api/platform/flows/move', json('POST', {
    flowIds: items.filter((i) => i.kind === 'flow').map((i) => i.id),
    folderIds: items.filter((i) => i.kind === 'folder').map((i) => i.id),
    targetFolderId,
  })).then((r) => ok<unknown>(r));

// ─── Paths ───

export interface FolderIndex {
  byId: Map<string, FlowFolder>;
  childrenOf: (parentId: string) => FlowFolder[];
  /** Root-first chain of folders ending at id ([] for the top level). */
  chain: (id: string | undefined) => FlowFolder[];
  path: (id: string | undefined) => string;
  /** True when candidate is folderId or lives beneath it. */
  isWithin: (candidate: string, folderId: string) => boolean;
}

export function useFolderIndex(folders: FlowFolder[]): FolderIndex {
  return useMemo(() => {
    const byId = new Map(folders.map((f) => [f.id, f]));
    const chain = (id: string | undefined) => {
      const out: FlowFolder[] = [];
      let cur = id ? byId.get(id) : undefined;
      for (let guard = 0; cur && guard < 64; guard++) {
        out.unshift(cur);
        cur = cur.parentId ? byId.get(cur.parentId) : undefined;
      }
      return out;
    };
    return {
      byId,
      childrenOf: (parentId) => folders
        .filter((f) => (f.parentId ?? '') === parentId)
        .sort((a, b) => a.name.localeCompare(b.name)),
      chain,
      path: (id) => chain(id).map((f) => f.name).join('/'),
      isWithin: (candidate, folderId) => chain(candidate).some((f) => f.id === folderId),
    };
  }, [folders]);
}

// ─── Icons ───

export function FolderIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M1.75 4.25a1 1 0 0 1 1-1h3.4l1.5 1.5h5.6a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1H2.75a1 1 0 0 1-1-1z" />
    </svg>
  );
}

// ─── Drag and drop ───
// Mouse users drag cards onto folder cards or breadcrumb segments; everyone else uses the
// card's "Move to…" menu, which calls the same move.

export interface DragItem { kind: 'flow' | 'folder'; id: string; name: string }
const DRAG_TYPE = 'application/x-bench-flow-item';
let dragging: DragItem | null = null; // dataTransfer is unreadable during dragover

export function dragSourceProps(item: DragItem) {
  return {
    draggable: true,
    onDragStart: (e: React.DragEvent) => {
      dragging = item;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(item));
      e.dataTransfer.setData('text/plain', item.name);
      (e.currentTarget as HTMLElement).classList.add('is-dragging');
    },
    onDragEnd: (e: React.DragEvent) => {
      dragging = null;
      (e.currentTarget as HTMLElement).classList.remove('is-dragging');
    },
  };
}

/** Props for an element that accepts drops into `folderId` ('' = top level). */
export function useDropTarget(folderId: string, index: FolderIndex, onDrop: (item: DragItem, folderId: string) => void) {
  const [over, setOver] = useState(false);
  const accepts = (item: DragItem | null) =>
    !!item && !(item.kind === 'folder' && (item.id === folderId || index.isWithin(folderId, item.id)));
  return {
    isOver: over,
    props: {
      onDragOver: (e: React.DragEvent) => {
        if (!accepts(dragging)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        if (!over) setOver(true);
      },
      onDragLeave: (e: React.DragEvent) => {
        if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) setOver(false);
      },
      onDrop: (e: React.DragEvent) => {
        e.preventDefault();
        setOver(false);
        let item = dragging;
        try { item = JSON.parse(e.dataTransfer.getData(DRAG_TYPE)); } catch { /* use the cached item */ }
        dragging = null;
        if (accepts(item)) onDrop(item!, folderId);
      },
    },
  };
}

// ─── Breadcrumb: the folder path ("slug") ───
// One component for the list page (under the title) and the flow page (in the toolbar), styled
// like bench's file-path header: ancestors are accent-blue links separated by a muted "/", the
// current item is bold text. "Flows" is the root crumb, so there is no separate back button.

export function FolderPath({ folderId, index, inItem = false, searching = false, onNavigate, onDrop }: {
  folderId: string;
  index: FolderIndex;
  /** On an item's own page (a flow): the trail is just the containing folders, every one a link;
   *  the item's name is already the page title, so it is not repeated here. */
  inItem?: boolean;
  searching?: boolean;
  onNavigate: (folderId: string) => void;
  /** Makes each crumb a drop target for dragged cards (list page only). */
  onDrop?: (item: DragItem, folderId: string) => void;
}) {
  const chain = index.chain(folderId || undefined);
  const crumbs = [{ id: '', label: 'Flows' }, ...chain.map((f) => ({ id: f.id, label: f.name }))];
  // Without an item of its own, the last crumb (the open folder, or Flows at the top) is "here".
  const linkCount = inItem ? crumbs.length : crumbs.length - 1;
  return (
    <nav className="flow-path" aria-label="Folder">
      <span className="flow-path-icon"><FolderIcon size={13} /></span>
      {crumbs.map((c, i) => (
        <span key={c.id || 'root'} className="flow-path-seg">
          {i > 0 && <span className="flow-path-sep" aria-hidden="true">/</span>}
          {i < linkCount
            ? <CrumbLink id={c.id} label={c.label} index={index} onNavigate={onNavigate} onDrop={onDrop} />
            : <span className="flow-path-current" aria-current="location">{c.label}</span>}
        </span>
      ))}
      {searching && <span className="flow-path-note">Searching all folders</span>}
    </nav>
  );
}

function CrumbLink({ id, label, index, onNavigate, onDrop }: {
  id: string; label: string; index: FolderIndex;
  onNavigate: (id: string) => void; onDrop?: (item: DragItem, folderId: string) => void;
}) {
  const drop = useDropTarget(id, index, onDrop ?? (() => {}));
  return (
    <button
      type="button"
      className={`flow-path-link${drop.isOver ? ' is-drop-target' : ''}`}
      onClick={() => onNavigate(id)}
      {...(onDrop ? drop.props : {})}
    >{label}</button>
  );
}

// ─── Card menu: Move to… / Rename / Delete ───

export function ItemMenu({ item, index, currentFolderId, onMove, onRename, onDelete }: {
  item: DragItem;
  index: FolderIndex;
  currentFolderId: string;
  onMove: (item: DragItem, folderId: string) => void;
  onRename?: () => void;
  onDelete?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [moving, setMoving] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (refocus: boolean) => {
      setOpen(false); setMoving(false);
      if (refocus) triggerRef.current?.focus({ preventScroll: true });
    };
    const onMouse = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) close(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); close(true); } };
    document.addEventListener('mousedown', onMouse);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onMouse); document.removeEventListener('keydown', onKey); };
  }, [open]);

  // Focus the first entry whenever the menu (or its folder list) opens.
  useEffect(() => {
    if (open) ref.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [open, moving]);

  // Destinations: the top level plus every folder, minus where it already is and (for a
  // folder) itself and its descendants.
  const destinations = [{ id: '', label: 'All flows (top level)' }, ...[...index.byId.values()]
    .map((f) => ({ id: f.id, label: index.path(f.id) }))
    .sort((a, b) => a.label.localeCompare(b.label))]
    .filter((d) => d.id !== currentFolderId)
    .filter((d) => item.kind !== 'folder' || !(d.id && index.isWithin(d.id, item.id)));

  const onMenuKey = (e: React.KeyboardEvent) => {
    const items = [...(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length]?.focus(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus(); }
  };

  const run = (fn?: () => void) => { setOpen(false); setMoving(false); fn?.(); };

  return (
    <div className="flow-card-menu-wrap" ref={ref} onClick={(e) => e.stopPropagation()}>
      <button
        ref={triggerRef}
        type="button"
        className="flow-card-menu-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Actions for ${item.name}`}
        title="Move, rename or delete"
        onClick={() => setOpen((v) => !v)}
      >⋯</button>
      {open && (
        <div className="flow-card-menu" role="menu" aria-label={moving ? `Move ${item.name} to` : `Actions for ${item.name}`} onKeyDown={onMenuKey}>
          {!moving ? (
            <>
              <button type="button" role="menuitem" onClick={() => setMoving(true)}>Move to…</button>
              {onRename && <button type="button" role="menuitem" onClick={() => run(onRename)}>Rename…</button>}
              {onDelete && <button type="button" role="menuitem" className="danger" onClick={() => run(onDelete)}>Delete…</button>}
            </>
          ) : destinations.length === 0 ? (
            <span className="flow-card-menu-empty">No other folders yet</span>
          ) : destinations.map((d) => (
            <button key={d.id || 'root'} type="button" role="menuitem" onClick={() => run(() => onMove(item, d.id))}>
              {d.id ? <FolderIcon size={12} /> : null}<span>{d.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Dialogs ───

function Dialog({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useModalFocus(ref);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" ref={ref} role="dialog" aria-modal="true" aria-labelledby="flow-folder-dialog-title">
        <div className="modal-header">
          <span className="modal-title" id="flow-folder-dialog-title">{title}</span>
          <button className="modal-close" aria-label="Close" onClick={onClose}>&times;</button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** Ask for a folder name (new folder or rename). */
export function FolderNameDialog({ title, initial = '', submitLabel, onSubmit, onClose }: {
  title: string; initial?: string; submitLabel: string;
  onSubmit: (name: string) => Promise<void>; onClose: () => void;
}) {
  const [name, setName] = useState(initial);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    if (trimmed.includes('/')) { setError('Folder names cannot contain “/”.'); return; }
    setBusy(true);
    try { await onSubmit(trimmed); } catch (err: any) { setError(err.message); setBusy(false); }
  };
  return (
    <Dialog title={title} onClose={onClose}>
      <form className="modal-body" onSubmit={submit}>
        <label className="modal-field">
          <span className="modal-label">Name</span>
          <input className="finding-edit-input" autoFocus value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        {error && <div className="modal-error" role="alert">{error}</div>}
        <div className="modal-actions">
          <button className="baseline-action-btn baseline-action-btn-outline" type="button" onClick={onClose}>Cancel</button>
          <button className="baseline-action-btn baseline-action-btn-primary" type="submit" disabled={busy || !name.trim()}>{submitLabel}</button>
        </div>
      </form>
    </Dialog>
  );
}

/** Deleting a folder deletes everything in it: show the counts first. */
export function DeleteFolderDialog({ folder, path, onDeleted, onClose }: {
  folder: FlowFolder; path: string; onDeleted: () => void; onClose: () => void;
}) {
  const [preview, setPreview] = useState<{ folders: number; flows: number } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { deleteFolder(folder.id, false).then(setPreview).catch((e) => setError(e.message)); }, [folder.id]);
  const confirm = async () => {
    setBusy(true);
    try { await deleteFolder(folder.id, true); onDeleted(); } catch (e: any) { setError(e.message); setBusy(false); }
  };
  const sub = preview ? preview.folders - 1 : 0;
  return (
    <Dialog title="Delete folder" onClose={onClose}>
      <div className="modal-body">
        <p className="flow-folder-delete-text">
          Delete <strong>{path}</strong>
          {preview && <>
            {sub > 0 && <>, its {sub} subfolder{sub === 1 ? '' : 's'}</>}
            {' '}and <strong>{preview.flows} flow{preview.flows === 1 ? '' : 's'}</strong> inside
          </>}
          ? This cannot be undone.
        </p>
        {error && <div className="modal-error" role="alert">{error}</div>}
        <div className="modal-actions">
          <button className="baseline-action-btn baseline-action-btn-outline" type="button" onClick={onClose} autoFocus>Keep folder</button>
          <button className="baseline-action-btn baseline-action-btn-danger" type="button" onClick={confirm} disabled={busy || !preview}>
            Delete folder and flows
          </button>
        </div>
      </div>
    </Dialog>
  );
}
