package server

import (
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
)

// ── flow folders ─────────────────────────────────────────────────────────────
//
// Folders nest (parent_id) and hold flows (flows.folder_id). A flow is in at most
// one folder; NULL means the top level. Sibling folder names are unique
// (case-insensitive) so a path like "auth/login" resolves to exactly one folder.
// Deleting a folder deletes its whole subtree, flows included.

type FlowFolder struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	ParentID    string `json:"parentId,omitempty"`
	FlowCount   int    `json:"flowCount"`
	FolderCount int    `json:"folderCount"`
	CreatedAt   string `json:"createdAt"`
	UpdatedAt   string `json:"updatedAt"`
}

func migrateFlowFolders(conn *sql.DB) error {
	if _, err := conn.Exec(`CREATE TABLE IF NOT EXISTS flow_folders (
		id         TEXT PRIMARY KEY,
		name       TEXT NOT NULL,
		parent_id  TEXT REFERENCES flow_folders(id) ON DELETE CASCADE,
		created_at TEXT NOT NULL DEFAULT (datetime('now')),
		updated_at TEXT NOT NULL DEFAULT (datetime('now'))
	)`); err != nil {
		return err
	}
	if _, err := conn.Exec(`CREATE INDEX IF NOT EXISTS flow_folders_parent_idx ON flow_folders(parent_id)`); err != nil {
		return err
	}
	if _, err := conn.Exec(`SELECT folder_id FROM flows LIMIT 0`); err != nil {
		if _, err2 := conn.Exec(`ALTER TABLE flows ADD COLUMN folder_id TEXT REFERENCES flow_folders(id) ON DELETE CASCADE`); err2 != nil {
			return err2
		}
	}
	_, err := conn.Exec(`CREATE INDEX IF NOT EXISTS flows_folder_idx ON flows(folder_id)`)
	return err
}

func (p *Platform) registerFolderRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/flow-folders", p.listFlowFolders)
	mux.HandleFunc("POST /api/flow-folders", p.createFlowFolder)
	mux.HandleFunc("PATCH /api/flow-folders/{id}", p.updateFlowFolder)
	mux.HandleFunc("DELETE /api/flow-folders/{id}", p.deleteFlowFolder)
	mux.HandleFunc("POST /api/flows/move", p.moveFlowItems)
}

var errFolderNotFound = errors.New("folder not found")

// folderExists reports whether id names a folder; "" (the top level) always exists.
func (p *Platform) folderExists(id string) (bool, error) {
	if id == "" {
		return true, nil
	}
	var one int
	err := p.db.QueryRow(`SELECT 1 FROM flow_folders WHERE id = ?`, id).Scan(&one)
	if err == sql.ErrNoRows {
		return false, nil
	}
	return err == nil, err
}

// folderSubtree returns id and every folder beneath it.
func (p *Platform) folderSubtree(id string) ([]string, error) {
	rows, err := p.db.Query(`WITH RECURSIVE sub(id) AS (
		SELECT id FROM flow_folders WHERE id = ?
		UNION ALL
		SELECT f.id FROM flow_folders f JOIN sub ON f.parent_id = sub.id
	) SELECT id FROM sub`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var s string
		if err := rows.Scan(&s); err != nil {
			return nil, err
		}
		ids = append(ids, s)
	}
	return ids, rows.Err()
}

// siblingNameTaken reports whether parentID already holds a folder called name (ignoring self).
func (p *Platform) siblingNameTaken(parentID, name, self string) (bool, error) {
	var n int
	err := p.db.QueryRow(`SELECT COUNT(*) FROM flow_folders
		WHERE COALESCE(parent_id,'') = ? AND lower(name) = lower(?) AND id != ?`, parentID, name, self).Scan(&n)
	return n > 0, err
}

func (p *Platform) loadFolder(id string) (*FlowFolder, error) {
	var f FlowFolder
	err := p.db.QueryRow(`SELECT f.id, f.name, COALESCE(f.parent_id,''), f.created_at, f.updated_at,
			(SELECT COUNT(*) FROM flows WHERE folder_id = f.id),
			(SELECT COUNT(*) FROM flow_folders c WHERE c.parent_id = f.id)
		FROM flow_folders f WHERE f.id = ?`, id).
		Scan(&f.ID, &f.Name, &f.ParentID, &f.CreatedAt, &f.UpdatedAt, &f.FlowCount, &f.FolderCount)
	if err == sql.ErrNoRows {
		return nil, errFolderNotFound
	}
	return &f, err
}

func (p *Platform) listFlowFolders(w http.ResponseWriter, r *http.Request) {
	rows, err := p.db.Query(`SELECT f.id, f.name, COALESCE(f.parent_id,''), f.created_at, f.updated_at,
			(SELECT COUNT(*) FROM flows WHERE folder_id = f.id),
			(SELECT COUNT(*) FROM flow_folders c WHERE c.parent_id = f.id)
		FROM flow_folders f ORDER BY lower(f.name)`)
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	defer rows.Close()
	out := []FlowFolder{}
	for rows.Next() {
		var f FlowFolder
		if err := rows.Scan(&f.ID, &f.Name, &f.ParentID, &f.CreatedAt, &f.UpdatedAt, &f.FlowCount, &f.FolderCount); err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		out = append(out, f)
	}
	writeJSON(w, out)
}

func (p *Platform) createFlowFolder(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name     string `json:"name"`
		ParentID string `json:"parentId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid JSON", 400)
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" || strings.Contains(req.Name, "/") {
		http.Error(w, "name is required and cannot contain '/'", 400)
		return
	}
	if ok, err := p.folderExists(req.ParentID); err != nil || !ok {
		http.Error(w, "parent folder not found", 400)
		return
	}
	if taken, err := p.siblingNameTaken(req.ParentID, req.Name, ""); err != nil || taken {
		http.Error(w, "a folder with that name already exists here", 409)
		return
	}
	id := randomID()
	if _, err := p.db.Exec(`INSERT INTO flow_folders (id, name, parent_id) VALUES (?, ?, NULLIF(?, ''))`, id, req.Name, req.ParentID); err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	f, err := p.loadFolder(id)
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	w.WriteHeader(201)
	writeJSON(w, f)
}

func (p *Platform) updateFlowFolder(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var req struct {
		Name     *string `json:"name"`
		ParentID *string `json:"parentId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid JSON", 400)
		return
	}
	cur, err := p.loadFolder(id)
	if err == errFolderNotFound {
		http.Error(w, "not found", 404)
		return
	} else if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	name, parent := cur.Name, cur.ParentID
	if req.Name != nil {
		name = strings.TrimSpace(*req.Name)
		if name == "" || strings.Contains(name, "/") {
			http.Error(w, "name is required and cannot contain '/'", 400)
			return
		}
	}
	if req.ParentID != nil {
		parent = *req.ParentID
		if status, msg := p.checkFolderTarget([]string{id}, parent); status != 0 {
			http.Error(w, msg, status)
			return
		}
	}
	if taken, err := p.siblingNameTaken(parent, name, id); err != nil || taken {
		http.Error(w, "a folder with that name already exists here", 409)
		return
	}
	if _, err := p.db.Exec(`UPDATE flow_folders SET name=?, parent_id=NULLIF(?, ''), updated_at=datetime('now') WHERE id=?`, name, parent, id); err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	f, _ := p.loadFolder(id)
	writeJSON(w, f)
}

// checkFolderTarget validates moving the given folders under target: the target must
// exist and must not be one of them or inside one of them. Returns 0 when allowed.
func (p *Platform) checkFolderTarget(folderIDs []string, target string) (int, string) {
	if ok, err := p.folderExists(target); err != nil {
		return 500, err.Error()
	} else if !ok {
		return 400, "target folder not found"
	}
	for _, fid := range folderIDs {
		sub, err := p.folderSubtree(fid)
		if err != nil {
			return 500, err.Error()
		}
		if len(sub) == 0 {
			return 404, "folder not found: " + fid
		}
		for _, s := range sub {
			if s == target {
				return 400, "cannot move a folder into itself or one of its subfolders"
			}
		}
	}
	return 0, ""
}

// deleteFlowFolder deletes a folder, its subfolders and every flow inside them.
// Without ?confirm=true it only reports what would be deleted.
func (p *Platform) deleteFlowFolder(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	sub, err := p.folderSubtree(id)
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	if len(sub) == 0 {
		http.Error(w, "not found", 404)
		return
	}
	placeholders := strings.TrimSuffix(strings.Repeat("?,", len(sub)), ",")
	args := make([]any, len(sub))
	for i, s := range sub {
		args[i] = s
	}
	var flowCount int
	if err := p.db.QueryRow(`SELECT COUNT(*) FROM flows WHERE folder_id IN (`+placeholders+`)`, args...).Scan(&flowCount); err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	result := map[string]any{"folders": len(sub), "flows": flowCount}
	if r.URL.Query().Get("confirm") != "true" {
		result["confirmRequired"] = true
		writeJSON(w, result)
		return
	}
	tx, err := p.db.Begin()
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	defer tx.Rollback()
	// Explicit rather than relying on the column's ON DELETE CASCADE: databases that gained
	// folder_id through ALTER TABLE get the same behaviour.
	if _, err := tx.Exec(`DELETE FROM flows WHERE folder_id IN (`+placeholders+`)`, args...); err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	if _, err := tx.Exec(`DELETE FROM flow_folders WHERE id IN (`+placeholders+`)`, args...); err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	if err := tx.Commit(); err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	result["deleted"] = true
	writeJSON(w, result)
}

// moveFlowItems moves flows and folders into a folder ("" = the top level) in one call.
func (p *Platform) moveFlowItems(w http.ResponseWriter, r *http.Request) {
	var req struct {
		FlowIDs        []string `json:"flowIds"`
		FolderIDs      []string `json:"folderIds"`
		TargetFolderID string   `json:"targetFolderId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid JSON", 400)
		return
	}
	if len(req.FlowIDs) == 0 && len(req.FolderIDs) == 0 {
		http.Error(w, "nothing to move: pass flowIds and/or folderIds", 400)
		return
	}
	if status, msg := p.checkFolderTarget(req.FolderIDs, req.TargetFolderID); status != 0 {
		http.Error(w, msg, status)
		return
	}
	for _, fid := range req.FolderIDs {
		cur, err := p.loadFolder(fid)
		if err != nil {
			http.Error(w, "folder not found: "+fid, 404)
			return
		}
		if taken, _ := p.siblingNameTaken(req.TargetFolderID, cur.Name, fid); taken {
			http.Error(w, "a folder named \""+cur.Name+"\" already exists there", 409)
			return
		}
	}
	tx, err := p.db.Begin()
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	defer tx.Rollback()
	for _, id := range req.FlowIDs {
		res, err := tx.Exec(`UPDATE flows SET folder_id=NULLIF(?, '') WHERE id=?`, req.TargetFolderID, id)
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		if n, _ := res.RowsAffected(); n == 0 {
			http.Error(w, "flow not found: "+id, 404)
			return
		}
	}
	for _, id := range req.FolderIDs {
		if _, err := tx.Exec(`UPDATE flow_folders SET parent_id=NULLIF(?, ''), updated_at=datetime('now') WHERE id=?`, req.TargetFolderID, id); err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
	}
	if err := tx.Commit(); err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	writeJSON(w, map[string]any{"moved": len(req.FlowIDs) + len(req.FolderIDs), "targetFolderId": req.TargetFolderID})
}
