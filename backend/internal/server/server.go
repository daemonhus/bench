package server

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"

	workbench "bench"

	_ "modernc.org/sqlite"
)

type Platform struct {
	dataDir     string
	db          *sql.DB
	workbenches map[string]*workbench.Workbench
	mu          sync.RWMutex
}

type RiskData struct {
	LatestBaselineAt  string `json:"latestBaselineAt,omitempty"`
	DeltaNewFindings  int    `json:"deltaNewFindings"`
	CommitsSince      int    `json:"commitsSince"`
	FilesChangedSince int    `json:"filesChangedSince"`
}

type Project struct {
	ID        string                  `json:"id"`
	Name      string                  `json:"name"`
	Slug      string                  `json:"slug"`
	RepoPath  string                  `json:"repoPath"`
	RemoteURL string                  `json:"remoteUrl,omitempty"`
	CreatedAt string                  `json:"createdAt"`
	Stats     *workbench.ProjectStats `json:"stats,omitempty"`
	RiskData  *RiskData               `json:"riskData,omitempty"`
	// Activity on the default branch: last push (newest commit) and commits over the last year.
	Activity *workbench.BranchActivity `json:"activity,omitempty"`
}

// Run serves the multi-project workbench on addr, keeping every database under dataDir.
func Run(dataDir, addr string) error {
	if err := os.MkdirAll(dataDir, 0755); err != nil {
		return fmt.Errorf("create data dir: %w", err)
	}

	p, err := NewPlatform(dataDir)
	if err != nil {
		return fmt.Errorf("init platform: %w", err)
	}
	defer p.Close()

	mux := http.NewServeMux()
	p.registerPlatformRoutes(mux)
	mux.Handle("/api/p/", p.workbenchRouter())
	mux.Handle("/mcp", newPlatformMCP(p))
	mux.Handle("/", spaHandler())

	log.Printf("benchd listening on %s (data=%s)", addr, dataDir)
	return http.ListenAndServe(addr, workbench.WithMiddleware(mux))
}

func NewPlatform(dataDir string) (*Platform, error) {
	dbPath := filepath.Join(dataDir, "platform.db")
	conn, err := sql.Open("sqlite", dbPath+"?_pragma=journal_mode(wal)&_pragma=foreign_keys(on)")
	if err != nil {
		return nil, err
	}
	if _, err := conn.Exec(`CREATE TABLE IF NOT EXISTS projects (
		id         TEXT PRIMARY KEY,
		name       TEXT NOT NULL,
		slug       TEXT NOT NULL UNIQUE,
		repo_path  TEXT NOT NULL,
		created_at TEXT NOT NULL DEFAULT (datetime('now'))
	)`); err != nil {
		return nil, err
	}
	if _, err := conn.Exec(`CREATE TABLE IF NOT EXISTS settings (
		key   TEXT PRIMARY KEY,
		value TEXT NOT NULL
	)`); err != nil {
		return nil, err
	}
	if _, err := conn.Exec(`CREATE TABLE IF NOT EXISTS flows (
		id          TEXT PRIMARY KEY,
		name        TEXT NOT NULL,
		description TEXT NOT NULL DEFAULT '',
		status      TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','archived')),
		owner       TEXT NOT NULL DEFAULT '',
		tags        TEXT NOT NULL DEFAULT '[]',
		created_at  TEXT NOT NULL DEFAULT (datetime('now')),
		updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
	)`); err != nil {
		return nil, err
	}
	if _, err := conn.Exec(`CREATE TABLE IF NOT EXISTS flow_steps (
		id               TEXT PRIMARY KEY,
		flow_id          TEXT NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
		parent_step_id   TEXT REFERENCES flow_steps(id) ON DELETE CASCADE,
		position         INTEGER NOT NULL DEFAULT 0,
		branch_condition TEXT NOT NULL DEFAULT '',
		project_slug     TEXT NOT NULL,
		feature_id       TEXT NOT NULL,
		note             TEXT NOT NULL DEFAULT '',
		tombstoned        INTEGER NOT NULL DEFAULT 0,
		tombstoned_reason TEXT NOT NULL DEFAULT '',
		created_at        TEXT NOT NULL DEFAULT (datetime('now'))
	)`); err != nil {
		return nil, err
	}
	if _, err := conn.Exec(`CREATE INDEX IF NOT EXISTS flow_steps_flow_idx ON flow_steps(flow_id)`); err != nil {
		return nil, err
	}
	if _, err := conn.Exec(`CREATE INDEX IF NOT EXISTS flow_steps_parent_idx ON flow_steps(parent_step_id)`); err != nil {
		return nil, err
	}
	if _, err := conn.Exec(`CREATE VIRTUAL TABLE IF NOT EXISTS flows_fts USING fts5(
		flow_id UNINDEXED,
		name, description, owner, tags,
		step_text,
		tokenize = 'porter unicode61'
	)`); err != nil {
		return nil, err
	}
	if _, err := conn.Exec(`CREATE TRIGGER IF NOT EXISTS flows_fts_insert AFTER INSERT ON flows BEGIN
		INSERT INTO flows_fts(flow_id, name, description, owner, tags) VALUES (new.id, new.name, new.description, new.owner, new.tags);
	END`); err != nil {
		return nil, err
	}
	if _, err := conn.Exec(`CREATE TRIGGER IF NOT EXISTS flows_fts_update AFTER UPDATE ON flows BEGIN
		UPDATE flows_fts SET name=new.name, description=new.description, owner=new.owner, tags=new.tags WHERE flow_id=new.id;
	END`); err != nil {
		return nil, err
	}
	if _, err := conn.Exec(`CREATE TRIGGER IF NOT EXISTS flows_fts_delete AFTER DELETE ON flows BEGIN
		DELETE FROM flows_fts WHERE flow_id=old.id;
	END`); err != nil {
		return nil, err
	}
	if _, err := conn.Exec(`CREATE TRIGGER IF NOT EXISTS flows_fts_step_insert AFTER INSERT ON flow_steps BEGIN
		UPDATE flows_fts SET step_text=(SELECT group_concat(note, ' ') FROM flow_steps WHERE flow_id=new.flow_id) WHERE flow_id=new.flow_id;
	END`); err != nil {
		return nil, err
	}
	if _, err := conn.Exec(`CREATE TRIGGER IF NOT EXISTS flows_fts_step_update AFTER UPDATE ON flow_steps BEGIN
		UPDATE flows_fts SET step_text=(SELECT group_concat(note, ' ') FROM flow_steps WHERE flow_id=new.flow_id) WHERE flow_id=new.flow_id;
	END`); err != nil {
		return nil, err
	}
	if _, err := conn.Exec(`CREATE TRIGGER IF NOT EXISTS flows_fts_step_delete AFTER DELETE ON flow_steps BEGIN
		UPDATE flows_fts SET step_text=(SELECT group_concat(note, ' ') FROM flow_steps WHERE flow_id=old.flow_id) WHERE flow_id=old.flow_id;
	END`); err != nil {
		return nil, err
	}
	if _, err := conn.Exec(`CREATE TABLE IF NOT EXISTS flow_views (
		id         TEXT PRIMARY KEY,
		owner      TEXT NOT NULL DEFAULT '',
		name       TEXT NOT NULL,
		query      TEXT NOT NULL DEFAULT '',
		is_shared  INTEGER NOT NULL DEFAULT 0,
		created_at TEXT NOT NULL DEFAULT (datetime('now')),
		updated_at TEXT NOT NULL DEFAULT (datetime('now'))
	)`); err != nil {
		return nil, err
	}
	if _, err := conn.Exec(`CREATE TABLE IF NOT EXISTS flow_step_links (
		flow_id      TEXT NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
		from_step_id TEXT NOT NULL REFERENCES flow_steps(id) ON DELETE CASCADE,
		to_step_id   TEXT NOT NULL REFERENCES flow_steps(id) ON DELETE CASCADE,
		description  TEXT NOT NULL DEFAULT '',
		comment      TEXT NOT NULL DEFAULT '',
		tags         TEXT NOT NULL DEFAULT '[]',
		PRIMARY KEY (from_step_id, to_step_id)
	)`); err != nil {
		return nil, err
	}
	// Migration: tombstoned_reason column on flow_steps (added after initial release).
	if _, err := conn.Exec(`SELECT tombstoned_reason FROM flow_steps LIMIT 0`); err != nil {
		if _, err2 := conn.Exec(`ALTER TABLE flow_steps ADD COLUMN tombstoned_reason TEXT NOT NULL DEFAULT ''`); err2 != nil {
			return nil, err2
		}
	}
	// Migrations for existing databases that predate comment/tags columns.
	if _, err := conn.Exec(`SELECT comment FROM flow_step_links LIMIT 0`); err != nil {
		if _, err2 := conn.Exec(`ALTER TABLE flow_step_links ADD COLUMN comment TEXT NOT NULL DEFAULT ''`); err2 != nil {
			return nil, err2
		}
	}
	if _, err := conn.Exec(`SELECT tags FROM flow_step_links LIMIT 0`); err != nil {
		if _, err2 := conn.Exec(`ALTER TABLE flow_step_links ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'`); err2 != nil {
			return nil, err2
		}
	}
	if _, err := conn.Exec(`CREATE TABLE IF NOT EXISTS flow_baselines (
		id         TEXT PRIMARY KEY,
		flow_id    TEXT NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
		seq        INTEGER NOT NULL,
		reviewer   TEXT NOT NULL DEFAULT '',
		summary    TEXT NOT NULL DEFAULT '',
		created_at TEXT NOT NULL DEFAULT (datetime('now')),
		snapshot   TEXT NOT NULL
	)`); err != nil {
		return nil, err
	}
	if _, err := conn.Exec(`CREATE UNIQUE INDEX IF NOT EXISTS flow_baselines_seq ON flow_baselines(flow_id, seq)`); err != nil {
		return nil, err
	}
	if err := migrateFlowFolders(conn); err != nil {
		return nil, err
	}
	return &Platform{
		dataDir:     dataDir,
		db:          conn,
		workbenches: make(map[string]*workbench.Workbench),
	}, nil
}

func (p *Platform) Close() {
	p.mu.Lock()
	defer p.mu.Unlock()
	for _, wb := range p.workbenches {
		wb.Close()
	}
	p.db.Close()
}

// resolveProject looks up a project by slug, full ID, or ID prefix.
// Returns the canonical slug and repo path.
func (p *Platform) resolveProject(identifier string) (slug, repoPath string, err error) {
	// Try exact slug match first (most common).
	err = p.db.QueryRow("SELECT slug, repo_path FROM projects WHERE slug = ?", identifier).
		Scan(&slug, &repoPath)
	if err == nil {
		return slug, repoPath, nil
	}

	// Try exact ID match.
	err = p.db.QueryRow("SELECT slug, repo_path FROM projects WHERE id = ?", identifier).
		Scan(&slug, &repoPath)
	if err == nil {
		return slug, repoPath, nil
	}

	// Try ID prefix match (short UUID). Require at least 4 chars to avoid ambiguity.
	if len(identifier) >= 4 {
		rows, qErr := p.db.Query(
			"SELECT slug, repo_path FROM projects WHERE id LIKE ?",
			identifier+"%",
		)
		if qErr != nil {
			return "", "", qErr
		}
		defer rows.Close()
		var matches int
		for rows.Next() {
			matches++
			rows.Scan(&slug, &repoPath)
		}
		if matches == 1 {
			return slug, repoPath, nil
		}
		if matches > 1 {
			return "", "", fmt.Errorf("ambiguous project identifier %q: matches %d projects", identifier, matches)
		}
	}

	return "", "", fmt.Errorf("project not found: %s", identifier)
}

func (p *Platform) getWorkbench(identifier string) (*workbench.Workbench, error) {
	p.mu.RLock()
	wb, ok := p.workbenches[identifier]
	p.mu.RUnlock()
	if ok {
		return wb, nil
	}

	p.mu.Lock()
	defer p.mu.Unlock()
	// Double-check after acquiring write lock.
	if wb, ok := p.workbenches[identifier]; ok {
		return wb, nil
	}

	slug, repoPath, err := p.resolveProject(identifier)
	if err != nil {
		return nil, err
	}

	// Check again with canonical slug (identifier may have been a UUID).
	if wb, ok := p.workbenches[slug]; ok {
		return wb, nil
	}

	dbPath := filepath.Join(p.dataDir, slug+".db")
	wb, err = workbench.Open(repoPath, dbPath)
	if err != nil {
		return nil, err
	}
	p.workbenches[slug] = wb
	return wb, nil
}

func (p *Platform) listProjects(w http.ResponseWriter, r *http.Request) {
	rows, err := p.db.Query("SELECT id, name, slug, repo_path, created_at FROM projects ORDER BY created_at DESC")
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	defer rows.Close()

	var projects []Project
	for rows.Next() {
		var proj Project
		if err := rows.Scan(&proj.ID, &proj.Name, &proj.Slug, &proj.RepoPath, &proj.CreatedAt); err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		if wb, err := p.getWorkbench(proj.Slug); err == nil {
			proj.RemoteURL = wb.Repo.RemoteURL()
			if act, err := wb.Repo.BranchActivity(wb.Repo.DefaultBranch(), 12); err == nil {
				proj.Activity = &act
			}
			if stats, err := wb.Stats(); err == nil {
				proj.Stats = &stats
				// Compute risk data from latest baseline
				if baselines, err := wb.ListBaselines(1); err == nil && len(baselines) > 0 {
					latest := baselines[0]
					delta := stats.FindingsTotal - latest.FindingsTotal
					if delta < 0 {
						delta = 0
					}
					rd := &RiskData{
						LatestBaselineAt: latest.CreatedAt,
						DeltaNewFindings: delta,
					}
					if head, err := wb.Repo.Head(); err == nil {
						if commits, err := wb.Repo.RevList(latest.CommitID, head); err == nil {
							rd.CommitsSince = len(commits)
						}
						if files, err := wb.Repo.DiffFiles(latest.CommitID, head); err == nil {
							rd.FilesChangedSince = len(files)
						}
					}
					proj.RiskData = rd
				}
			}
		}
		projects = append(projects, proj)
	}
	if projects == nil {
		projects = []Project{}
	}
	writeJSON(w, projects)
}

func (p *Platform) createProject(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name     string `json:"name"`
		RepoPath string `json:"repoPath"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid JSON", 400)
		return
	}
	if req.Name == "" || req.RepoPath == "" {
		http.Error(w, "name and repoPath required", 400)
		return
	}

	// Validate repo path exists and is a git repo.
	info, err := os.Stat(filepath.Join(req.RepoPath, ".git"))
	if err != nil || !info.IsDir() {
		http.Error(w, "path is not a git repository", 400)
		return
	}

	id := randomID()
	slug := slugify(req.Name)
	if slug == "" {
		http.Error(w, "name must contain at least one letter or digit (the project slug is derived from it)", 400)
		return
	}
	if p.projectNameTaken(req.Name, "") {
		http.Error(w, "project with that name already exists", 409)
		return
	}

	_, err = p.db.Exec(
		"INSERT INTO projects (id, name, slug, repo_path) VALUES (?, ?, ?, ?)",
		id, req.Name, slug, req.RepoPath,
	)
	if err != nil {
		if strings.Contains(err.Error(), "UNIQUE") {
			http.Error(w, "project with that name already exists", 409)
			return
		}
		http.Error(w, err.Error(), 500)
		return
	}

	proj := Project{ID: id, Name: req.Name, Slug: slug, RepoPath: req.RepoPath}

	// Eagerly open the workbench and create an initial baseline at HEAD.
	wb, err := p.getWorkbench(slug)
	if err != nil {
		log.Printf("warning: could not open workbench for initial baseline: %v", err)
	} else if err := wb.CreateInitialBaseline(); err != nil {
		log.Printf("warning: could not create initial baseline: %v", err)
	}

	w.WriteHeader(201)
	writeJSON(w, proj)
}

func (p *Platform) updateProject(w http.ResponseWriter, r *http.Request) {
	slug, _, err := p.resolveProject(r.PathValue("slug"))
	if err != nil {
		http.Error(w, "not found", 404)
		return
	}

	var req struct {
		Name     *string `json:"name"`
		RepoPath *string `json:"repoPath"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid JSON", 400)
		return
	}
	if req.Name == nil && req.RepoPath == nil {
		http.Error(w, "at least one of name or repoPath must be provided", 400)
		return
	}

	var currentName, currentPath string
	err = p.db.QueryRow("SELECT name, repo_path FROM projects WHERE slug = ?", slug).
		Scan(&currentName, &currentPath)
	if err != nil {
		http.Error(w, "not found", 404)
		return
	}

	newName := currentName
	if req.Name != nil && *req.Name != "" {
		newName = *req.Name
		if p.projectNameTaken(newName, slug) {
			http.Error(w, "project with that name already exists", 409)
			return
		}
	}
	newPath := currentPath
	if req.RepoPath != nil && *req.RepoPath != "" {
		info, err := os.Stat(filepath.Join(*req.RepoPath, ".git"))
		if err != nil || !info.IsDir() {
			http.Error(w, "path is not a git repository", 400)
			return
		}
		newPath = *req.RepoPath
	}

	if _, err := p.db.Exec(
		"UPDATE projects SET name = ?, repo_path = ? WHERE slug = ?",
		newName, newPath, slug,
	); err != nil {
		http.Error(w, err.Error(), 500)
		return
	}

	// Evict cached workbench if path changed.
	if newPath != currentPath {
		p.mu.Lock()
		if wb, ok := p.workbenches[slug]; ok {
			wb.Close()
			delete(p.workbenches, slug)
		}
		p.mu.Unlock()
	}

	writeJSON(w, Project{Name: newName, Slug: slug, RepoPath: newPath})
}

// projectNameTaken reports whether a project other than exceptSlug already
// has this name (case-insensitively). Slugs are unique in the schema; names
// are checked here so two projects can't share a display name either.
func (p *Platform) projectNameTaken(name, exceptSlug string) bool {
	var n int
	_ = p.db.QueryRow("SELECT COUNT(*) FROM projects WHERE lower(name) = lower(?) AND slug != ?", name, exceptSlug).Scan(&n)
	return n > 0
}

func (p *Platform) deleteProject(w http.ResponseWriter, r *http.Request) {
	slug, _, err := p.resolveProject(r.PathValue("slug"))
	if err != nil {
		http.Error(w, "not found", 404)
		return
	}

	p.mu.Lock()
	if wb, ok := p.workbenches[slug]; ok {
		wb.Close()
		delete(p.workbenches, slug)
	}
	p.mu.Unlock()

	res, err := p.db.Exec("DELETE FROM projects WHERE slug = ?", slug)
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		http.Error(w, "not found", 404)
		return
	}
	w.WriteHeader(204)
}

type PlatformBaseline struct {
	ProjectSlug string `json:"projectSlug"`
	ProjectName string `json:"projectName"`
	workbench.Baseline
}

func (p *Platform) listAllBaselines(w http.ResponseWriter, r *http.Request) {
	rows, err := p.db.Query("SELECT name, slug FROM projects ORDER BY name")
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	defer rows.Close()

	var results []PlatformBaseline
	for rows.Next() {
		var name, slug string
		if err := rows.Scan(&name, &slug); err != nil {
			continue
		}
		wb, err := p.getWorkbench(slug)
		if err != nil {
			continue
		}
		baselines, err := wb.ListBaselines(50)
		if err != nil {
			continue
		}
		for _, b := range baselines {
			results = append(results, PlatformBaseline{
				ProjectSlug: slug,
				ProjectName: name,
				Baseline:    b,
			})
		}
	}
	if results == nil {
		results = []PlatformBaseline{}
	}
	writeJSON(w, results)
}

func (p *Platform) getSettings(w http.ResponseWriter, r *http.Request) {
	rows, err := p.db.Query("SELECT key, value FROM settings")
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	defer rows.Close()

	result := make(map[string]string)
	for rows.Next() {
		var k, v string
		if err := rows.Scan(&k, &v); err != nil {
			continue
		}
		result[k] = v
	}
	writeJSON(w, result)
}

func (p *Platform) putSettings(w http.ResponseWriter, r *http.Request) {
	var body map[string]string
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid JSON", 400)
		return
	}
	for k, v := range body {
		if _, err := p.db.Exec(
			"INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?",
			k, v, v,
		); err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
	}
	w.WriteHeader(204)
}

func (p *Platform) workbenchRouter() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Path: /api/p/{slug}/api/git/commits → extract slug, forward /api/git/commits
		rest := strings.TrimPrefix(r.URL.Path, "/api/p/")
		parts := strings.SplitN(rest, "/", 2)
		slug := parts[0]

		wb, err := p.getWorkbench(slug)
		if err != nil {
			http.Error(w, "project not found", 404)
			return
		}

		remaining := "/"
		if len(parts) > 1 {
			remaining = "/" + parts[1]
		}
		r.URL.Path = remaining
		wb.Handler().ServeHTTP(w, r)
	})
}

func spaHandler() http.Handler {
	dist, err := fs.Sub(distFS, "dist")
	if err != nil {
		log.Fatal(err)
	}
	fileServer := http.FileServer(http.FS(dist))

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := strings.TrimPrefix(r.URL.Path, "/")
		if path == "" {
			path = "index.html"
		}
		if f, err := dist.Open(path); err == nil {
			f.Close()
			fileServer.ServeHTTP(w, r)
			return
		}
		r.URL.Path = "/"
		fileServer.ServeHTTP(w, r)
	})
}

// ── flows ────────────────────────────────────────────────────────────────────

type Flow struct {
	ID          string     `json:"id"`
	Name        string     `json:"name"`
	Description string     `json:"description"`
	Status      string     `json:"status"`
	Owner       string     `json:"owner"`
	Tags        []string   `json:"tags"`
	FolderID    string     `json:"folderId,omitempty"`
	CreatedAt   string     `json:"createdAt"`
	UpdatedAt   string     `json:"updatedAt"`
	Steps       []FlowStep `json:"steps"`
	Links       []FlowLink `json:"links"`
}

// MarshalJSON always writes steps and links as arrays, so a flow with no steps
// reads as `"steps": []` rather than a missing key or null.
func (f Flow) MarshalJSON() ([]byte, error) {
	type plain Flow
	if f.Steps == nil {
		f.Steps = []FlowStep{}
	}
	if f.Links == nil {
		f.Links = []FlowLink{}
	}
	return json.Marshal(plain(f))
}

type FeatureSnapshot struct {
	Title           string          `json:"title"`
	Kind            string          `json:"kind"`
	Operation       string          `json:"operation,omitempty"`
	Protocol        string          `json:"protocol,omitempty"`
	ProjectName     string          `json:"projectName"`
	Confidence      string          `json:"confidence,omitempty"`
	EffectiveAnchor json.RawMessage `json:"effectiveAnchor,omitempty"`
}

type FlowStep struct {
	ID               string           `json:"id"`
	FlowID           string           `json:"flowId"`
	ParentStepID     string           `json:"parentStepId,omitempty"`
	Position         int              `json:"position"`
	BranchCondition  string           `json:"branchCondition"`
	ProjectSlug      string           `json:"projectSlug"`
	FeatureID        string           `json:"featureId"`
	Note             string           `json:"note"`
	Tombstoned       bool             `json:"tombstoned"`
	TombstonedReason string           `json:"tombstonedReason,omitempty"`
	CreatedAt        string           `json:"createdAt"`
	Feature          *FeatureSnapshot `json:"feature,omitempty"`
}

type FlowLink struct {
	FlowID      string   `json:"flowId"`
	FromStepID  string   `json:"fromStepId"`
	ToStepID    string   `json:"toStepId"`
	Description string   `json:"description"`
	Comment     string   `json:"comment"`
	Tags        []string `json:"tags"`
}

func scanFlow(row *sql.Row) (*Flow, error) {
	var f Flow
	var tagsJSON string
	if err := row.Scan(&f.ID, &f.Name, &f.Description, &f.Status, &f.Owner, &tagsJSON, &f.FolderID, &f.CreatedAt, &f.UpdatedAt); err != nil {
		return nil, err
	}
	if err := json.Unmarshal([]byte(tagsJSON), &f.Tags); err != nil {
		f.Tags = []string{}
	}
	return &f, nil
}

func (p *Platform) loadFlowSteps(flowID string) ([]FlowStep, error) {
	rows, err := p.db.Query(
		`SELECT id, flow_id, COALESCE(parent_step_id,''), position, branch_condition, project_slug, feature_id, note, tombstoned, COALESCE(tombstoned_reason,''), created_at
		 FROM flow_steps WHERE flow_id = ? ORDER BY position`,
		flowID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var steps []FlowStep
	for rows.Next() {
		var s FlowStep
		var tombInt int
		if err := rows.Scan(&s.ID, &s.FlowID, &s.ParentStepID, &s.Position, &s.BranchCondition, &s.ProjectSlug, &s.FeatureID, &s.Note, &tombInt, &s.TombstonedReason, &s.CreatedAt); err != nil {
			return nil, err
		}
		s.Tombstoned = tombInt != 0
		steps = append(steps, s)
	}
	if steps == nil {
		steps = []FlowStep{}
	}
	return steps, nil
}

func (p *Platform) loadFlowLinks(flowID string) ([]FlowLink, error) {
	rows, err := p.db.Query(
		`SELECT flow_id, from_step_id, to_step_id, description, comment, tags FROM flow_step_links WHERE flow_id = ?`,
		flowID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var links []FlowLink
	for rows.Next() {
		var l FlowLink
		var tagsJSON string
		if err := rows.Scan(&l.FlowID, &l.FromStepID, &l.ToStepID, &l.Description, &l.Comment, &tagsJSON); err != nil {
			return nil, err
		}
		if err := json.Unmarshal([]byte(tagsJSON), &l.Tags); err != nil {
			l.Tags = []string{}
		}
		links = append(links, l)
	}
	if links == nil {
		links = []FlowLink{}
	}
	return links, nil
}

// FlowSummary is the lightweight list-page representation of a flow (no steps/links).
type FlowSummary struct {
	ID                string                 `json:"id"`
	Name              string                 `json:"name"`
	Description       string                 `json:"description"`
	Status            string                 `json:"status"`
	Owner             string                 `json:"owner"`
	Tags              []string               `json:"tags"`
	FolderID          string                 `json:"folderId,omitempty"`
	StepCount         int                    `json:"stepCount"`
	ProjectSlugs      []string               `json:"projectSlugs"`
	CreatedAt         string                 `json:"createdAt"`
	UpdatedAt         string                 `json:"updatedAt"`
	LastBaselinedAt   string                 `json:"lastBaselinedAt,omitempty"`
	BaselineCount     int                    `json:"baselineCount"`
	OpenFindings      *FindingSeverityCounts `json:"openFindings,omitempty"`
	OpenFindingsTotal int                    `json:"openFindingsTotal,omitempty"`
	// Shape is the step tree skeleton (no feature data), enough to draw the flow's outline.
	Shape []FlowShapeNode `json:"shape"`
}

// FlowShapeNode is one step in a FlowSummary's outline.
type FlowShapeNode struct {
	ID           string `json:"id"`
	ParentStepID string `json:"parentStepId,omitempty"`
	Position     int    `json:"position"`
	ProjectSlug  string `json:"projectSlug"`
	FeatureID    string `json:"featureId"`
}

// FlowsPage is the paginated response for GET /api/platform/flows.
type FlowsPage struct {
	Items  []FlowSummary `json:"items"`
	Total  int           `json:"total"`
	Offset int           `json:"offset"`
	Limit  int           `json:"limit"`
}

// buildFlowsWhere constructs the WHERE clause and args for the flows query,
// given query params. It returns a CTE prefix (possibly empty), WHERE clause
// (without the "WHERE" keyword), and args. The useFTS flag indicates whether
// the FTS join is needed.
func buildFlowsWhere(q map[string][]string) (ctePrefix string, where string, args []any, useFTS bool) {
	var conditions []string

	// FTS search
	if ftsQ := first(q, "q"); ftsQ != "" {
		ctePrefix = `WITH fts_ids AS (SELECT flow_id FROM flows_fts WHERE flows_fts MATCH ?) `
		args = append(args, ftsQ)
		conditions = append(conditions, "f.id IN (SELECT flow_id FROM fts_ids)")
		useFTS = true
	}

	// status — comma-separated or multi-value
	if statuses := splitParam(q, "status"); len(statuses) > 0 {
		placeholders := make([]string, len(statuses))
		for i, s := range statuses {
			placeholders[i] = "?"
			args = append(args, s)
		}
		conditions = append(conditions, "f.status IN ("+strings.Join(placeholders, ",")+")")
	}

	// owner — repeatable
	if owners := q["owner"]; len(owners) > 0 {
		placeholders := make([]string, len(owners))
		for i, o := range owners {
			placeholders[i] = "?"
			args = append(args, o)
		}
		conditions = append(conditions, "f.owner IN ("+strings.Join(placeholders, ",")+")")
	}

	// tag — repeatable; flow must contain at least one matching tag
	if tags := q["tag"]; len(tags) > 0 {
		tagConds := make([]string, len(tags))
		for i, t := range tags {
			tagConds[i] = "EXISTS (SELECT 1 FROM json_each(f.tags) WHERE value = ?)"
			args = append(args, t)
		}
		conditions = append(conditions, "("+strings.Join(tagConds, " OR ")+")")
	}

	// project — repeatable; flow must have at least one step in this project
	if projects := q["project"]; len(projects) > 0 {
		projectConds := make([]string, len(projects))
		for i, proj := range projects {
			projectConds[i] = "EXISTS (SELECT 1 FROM flow_steps fs WHERE fs.flow_id=f.id AND fs.project_slug=?)"
			args = append(args, proj)
		}
		conditions = append(conditions, "("+strings.Join(projectConds, " OR ")+")")
	}

	// folder — "root" for the top level, otherwise a folder id (direct children only)
	if folder := first(q, "folder"); folder == "root" {
		conditions = append(conditions, "f.folder_id IS NULL")
	} else if folder != "" {
		conditions = append(conditions, "f.folder_id = ?")
		args = append(args, folder)
	}

	if len(conditions) == 0 {
		where = "1=1"
	} else {
		where = strings.Join(conditions, " AND ")
	}
	return ctePrefix, where, args, useFTS
}

func first(q map[string][]string, key string) string {
	if v, ok := q[key]; ok && len(v) > 0 {
		return v[0]
	}
	return ""
}

func splitParam(q map[string][]string, key string) []string {
	var out []string
	for _, v := range q[key] {
		for _, part := range strings.Split(v, ",") {
			if s := strings.TrimSpace(part); s != "" {
				out = append(out, s)
			}
		}
	}
	return out
}

func (p *Platform) listFlows(w http.ResponseWriter, r *http.Request) {
	qp := r.URL.Query()

	// Pagination
	offset := 0
	limit := 50
	if v := qp.Get("offset"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 0 {
			offset = n
		}
	}
	if v := qp.Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			if n > 200 {
				n = 200
			}
			limit = n
		}
	}

	// Sort (risk handled post-query since it requires bench calls)
	sortByRisk := qp.Get("sort") == "risk"
	sortCol := "f.updated_at"
	if !sortByRisk {
		switch qp.Get("sort") {
		case "created":
			sortCol = "f.created_at"
		case "name":
			sortCol = "f.name"
		case "stepCount":
			sortCol = "stepCount"
		}
	}
	order := "DESC"
	if strings.ToLower(qp.Get("order")) == "asc" {
		order = "ASC"
	}

	qv := map[string][]string(qp)
	ctePrefix, where, args, _ := buildFlowsWhere(qv)

	// Count query
	countSQL := ctePrefix + `SELECT COUNT(*) FROM flows f WHERE ` + where
	var total int
	if err := p.db.QueryRow(countSQL, args...).Scan(&total); err != nil {
		http.Error(w, err.Error(), 500)
		return
	}

	// Main query with stepCount, projectSlugs (first 5), and baseline metadata
	mainSQL := ctePrefix + `
		SELECT f.id, f.name, f.description, f.status, f.owner, f.tags, COALESCE(f.folder_id,''), f.created_at, f.updated_at,
		       (SELECT COUNT(*) FROM flow_steps fs WHERE fs.flow_id = f.id) AS stepCount,
		       COALESCE((SELECT group_concat(ps.project_slug, ',')
		                 FROM (SELECT DISTINCT fs2.project_slug FROM flow_steps fs2
		                       WHERE fs2.flow_id = f.id
		                       ORDER BY fs2.project_slug
		                       LIMIT 5) ps), '') AS projectSlugsRaw,
		       COALESCE((SELECT created_at FROM flow_baselines WHERE flow_id = f.id ORDER BY seq DESC LIMIT 1), '') AS lastBaselinedAt,
		       (SELECT COUNT(*) FROM flow_baselines WHERE flow_id = f.id) AS baselineCount
		FROM flows f
		WHERE ` + where + `
		ORDER BY ` + sortCol + ` ` + order + `
		LIMIT ? OFFSET ?`

	queryArgs := append(args, limit, offset)
	rows, err := p.db.Query(mainSQL, queryArgs...)
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	defer rows.Close()

	items := make([]FlowSummary, 0)
	for rows.Next() {
		var fs FlowSummary
		var tagsJSON string
		var projectSlugsRaw string
		if err := rows.Scan(&fs.ID, &fs.Name, &fs.Description, &fs.Status, &fs.Owner, &tagsJSON, &fs.FolderID,
			&fs.CreatedAt, &fs.UpdatedAt, &fs.StepCount, &projectSlugsRaw, &fs.LastBaselinedAt, &fs.BaselineCount); err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		if err := json.Unmarshal([]byte(tagsJSON), &fs.Tags); err != nil {
			fs.Tags = []string{}
		}
		if projectSlugsRaw != "" {
			fs.ProjectSlugs = strings.Split(projectSlugsRaw, ",")
		} else {
			fs.ProjectSlugs = []string{}
		}
		fs.Shape = []FlowShapeNode{}
		items = append(items, fs)
	}
	if err := p.attachFlowShapes(items); err != nil {
		http.Error(w, err.Error(), 500)
		return
	}

	// Enrich with findings counts when requested or sorting by risk.
	if sortByRisk || qp.Get("withFindings") == "true" {
		items = p.enrichFlowSummariesWithFindings(items)
		if sortByRisk {
			asc := order == "ASC"
			sort.SliceStable(items, func(i, j int) bool {
				if asc {
					return items[i].OpenFindingsTotal < items[j].OpenFindingsTotal
				}
				return items[i].OpenFindingsTotal > items[j].OpenFindingsTotal
			})
		}
	}

	writeJSON(w, FlowsPage{Items: items, Total: total, Offset: offset, Limit: limit})
}

// attachFlowShapes loads every listed flow's step skeleton in one query.
func (p *Platform) attachFlowShapes(items []FlowSummary) error {
	if len(items) == 0 {
		return nil
	}
	idx := make(map[string]int, len(items))
	args := make([]any, len(items))
	for i, it := range items {
		idx[it.ID] = i
		args[i] = it.ID
	}
	rows, err := p.db.Query(`SELECT flow_id, id, COALESCE(parent_step_id,''), position, project_slug, feature_id FROM flow_steps
		WHERE flow_id IN (`+strings.TrimSuffix(strings.Repeat("?,", len(items)), ",")+`) ORDER BY position`, args...)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var flowID string
		var n FlowShapeNode
		if err := rows.Scan(&flowID, &n.ID, &n.ParentStepID, &n.Position, &n.ProjectSlug, &n.FeatureID); err != nil {
			return err
		}
		if i, ok := idx[flowID]; ok {
			items[i].Shape = append(items[i].Shape, n)
		}
	}
	return rows.Err()
}

// FacetItem is a single facet value with its count.
type FacetItem struct {
	Value string `json:"value"`
	Count int    `json:"count"`
}

// FacetsResponse is the response for GET /api/platform/flows/facets.
type FacetsResponse struct {
	Project []FacetItem `json:"project"`
	Tag     []FacetItem `json:"tag"`
	Owner   []FacetItem `json:"owner"`
	Status  []FacetItem `json:"status"`
}

func (p *Platform) listFlowFacets(w http.ResponseWriter, r *http.Request) {
	qp := r.URL.Query()
	qv := map[string][]string(qp)

	// Helper: build WHERE excluding a specific facet key
	buildWhereExcluding := func(excludeKey string) (string, string, []any) {
		qvCopy := make(map[string][]string)
		for k, v := range qv {
			if k != excludeKey {
				qvCopy[k] = v
			}
		}
		cte, wh, args, _ := buildFlowsWhere(qvCopy)
		return cte, wh, args
	}

	resp := FacetsResponse{
		Project: []FacetItem{},
		Tag:     []FacetItem{},
		Owner:   []FacetItem{},
		Status:  []FacetItem{},
	}

	// Project facet (exclude project filter)
	{
		cte, wh, args := buildWhereExcluding("project")
		sql := cte + `SELECT fs.project_slug, COUNT(DISTINCT f.id) FROM flows f
			JOIN flow_steps fs ON fs.flow_id = f.id
			WHERE ` + wh + ` GROUP BY fs.project_slug ORDER BY COUNT(DISTINCT f.id) DESC`
		rows, err := p.db.Query(sql, args...)
		if err == nil {
			defer rows.Close()
			for rows.Next() {
				var item FacetItem
				rows.Scan(&item.Value, &item.Count)
				resp.Project = append(resp.Project, item)
			}
		}
	}

	// Tag facet (exclude tag filter)
	{
		cte, wh, args := buildWhereExcluding("tag")
		sql := cte + `SELECT jt.value, COUNT(DISTINCT f.id) FROM flows f, json_each(f.tags) jt
			WHERE ` + wh + ` GROUP BY jt.value ORDER BY COUNT(DISTINCT f.id) DESC`
		rows, err := p.db.Query(sql, args...)
		if err == nil {
			defer rows.Close()
			for rows.Next() {
				var item FacetItem
				rows.Scan(&item.Value, &item.Count)
				resp.Tag = append(resp.Tag, item)
			}
		}
	}

	// Owner facet (exclude owner filter)
	{
		cte, wh, args := buildWhereExcluding("owner")
		sql := cte + `SELECT f.owner, COUNT(*) FROM flows f WHERE ` + wh + ` AND f.owner != '' GROUP BY f.owner ORDER BY COUNT(*) DESC`
		rows, err := p.db.Query(sql, args...)
		if err == nil {
			defer rows.Close()
			for rows.Next() {
				var item FacetItem
				rows.Scan(&item.Value, &item.Count)
				resp.Owner = append(resp.Owner, item)
			}
		}
	}

	// Status facet (exclude status filter)
	{
		cte, wh, args := buildWhereExcluding("status")
		sql := cte + `SELECT f.status, COUNT(*) FROM flows f WHERE ` + wh + ` GROUP BY f.status ORDER BY COUNT(*) DESC`
		rows, err := p.db.Query(sql, args...)
		if err == nil {
			defer rows.Close()
			for rows.Next() {
				var item FacetItem
				rows.Scan(&item.Value, &item.Count)
				resp.Status = append(resp.Status, item)
			}
		}
	}

	writeJSON(w, resp)
}

// ── flow views ───────────────────────────────────────────────────────────────

type FlowView struct {
	ID        string `json:"id"`
	Owner     string `json:"owner"`
	Name      string `json:"name"`
	Query     string `json:"query"`
	IsShared  bool   `json:"isShared"`
	CreatedAt string `json:"createdAt"`
	UpdatedAt string `json:"updatedAt"`
}

func (p *Platform) listFlowViews(w http.ResponseWriter, r *http.Request) {
	rows, err := p.db.Query(`SELECT id, owner, name, query, is_shared, created_at, updated_at FROM flow_views ORDER BY updated_at DESC`)
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	defer rows.Close()
	views := make([]FlowView, 0)
	for rows.Next() {
		var v FlowView
		var isSharedInt int
		if err := rows.Scan(&v.ID, &v.Owner, &v.Name, &v.Query, &isSharedInt, &v.CreatedAt, &v.UpdatedAt); err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		v.IsShared = isSharedInt != 0
		views = append(views, v)
	}
	writeJSON(w, views)
}

func (p *Platform) createFlowView(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name     string `json:"name"`
		Query    string `json:"query"`
		Owner    string `json:"owner"`
		IsShared bool   `json:"isShared"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid JSON", 400)
		return
	}
	if req.Name == "" {
		http.Error(w, "name is required", 400)
		return
	}
	id := randomID()
	isSharedInt := 0
	if req.IsShared {
		isSharedInt = 1
	}
	if _, err := p.db.Exec(
		`INSERT INTO flow_views (id, owner, name, query, is_shared) VALUES (?, ?, ?, ?, ?)`,
		id, req.Owner, req.Name, req.Query, isSharedInt,
	); err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	v := FlowView{ID: id, Owner: req.Owner, Name: req.Name, Query: req.Query, IsShared: req.IsShared}
	_ = p.db.QueryRow(`SELECT created_at, updated_at FROM flow_views WHERE id = ?`, id).Scan(&v.CreatedAt, &v.UpdatedAt)
	w.WriteHeader(201)
	writeJSON(w, v)
}

func (p *Platform) updateFlowView(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var req struct {
		Name     *string `json:"name"`
		Query    *string `json:"query"`
		IsShared *bool   `json:"isShared"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid JSON", 400)
		return
	}

	var v FlowView
	var isSharedInt int
	err := p.db.QueryRow(`SELECT id, owner, name, query, is_shared, created_at, updated_at FROM flow_views WHERE id=?`, id).
		Scan(&v.ID, &v.Owner, &v.Name, &v.Query, &isSharedInt, &v.CreatedAt, &v.UpdatedAt)
	if err == sql.ErrNoRows {
		http.Error(w, "not found", 404)
		return
	}
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	v.IsShared = isSharedInt != 0

	if req.Name != nil {
		if strings.TrimSpace(*req.Name) == "" {
			http.Error(w, "name cannot be empty", 400)
			return
		}
		v.Name = *req.Name
	}
	if req.Query != nil {
		v.Query = *req.Query
	}
	if req.IsShared != nil {
		v.IsShared = *req.IsShared
	}
	newSharedInt := 0
	if v.IsShared {
		newSharedInt = 1
	}
	if _, err := p.db.Exec(
		`UPDATE flow_views SET name=?, query=?, is_shared=?, updated_at=datetime('now') WHERE id=?`,
		v.Name, v.Query, newSharedInt, id,
	); err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	_ = p.db.QueryRow(`SELECT updated_at FROM flow_views WHERE id = ?`, id).Scan(&v.UpdatedAt)
	writeJSON(w, v)
}

func (p *Platform) deleteFlowView(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	res, err := p.db.Exec(`DELETE FROM flow_views WHERE id=?`, id)
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		http.Error(w, "not found", 404)
		return
	}
	w.WriteHeader(204)
}

var validFlowStatuses = map[string]bool{"draft": true, "active": true, "archived": true}

func (p *Platform) createFlow(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name        string   `json:"name"`
		Description string   `json:"description"`
		Status      string   `json:"status"`
		Owner       string   `json:"owner"`
		Tags        []string `json:"tags"`
		FolderID    string   `json:"folderId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid JSON", 400)
		return
	}
	if ok, err := p.folderExists(req.FolderID); err != nil || !ok {
		http.Error(w, "folder not found", 400)
		return
	}
	if req.Name == "" {
		http.Error(w, "name is required", 400)
		return
	}
	if req.Status == "" {
		req.Status = "draft"
	}
	if !validFlowStatuses[req.Status] {
		http.Error(w, "status must be one of: draft, active, archived", 400)
		return
	}
	if req.Tags == nil {
		req.Tags = []string{}
	}
	tagsJSON, _ := json.Marshal(req.Tags)
	id := randomID()
	if _, err := p.db.Exec(
		`INSERT INTO flows (id, name, description, status, owner, tags, folder_id) VALUES (?, ?, ?, ?, ?, ?, NULLIF(?, ''))`,
		id, req.Name, req.Description, req.Status, req.Owner, string(tagsJSON), req.FolderID,
	); err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	f := Flow{ID: id, Name: req.Name, Description: req.Description, Status: req.Status, Owner: req.Owner, Tags: req.Tags, FolderID: req.FolderID, Steps: []FlowStep{}, Links: []FlowLink{}}
	_ = p.db.QueryRow(`SELECT created_at, updated_at FROM flows WHERE id = ?`, id).Scan(&f.CreatedAt, &f.UpdatedAt)
	w.WriteHeader(201)
	writeJSON(w, f)
}

func (p *Platform) getFlow(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	row := p.db.QueryRow(`SELECT id, name, description, status, owner, tags, COALESCE(folder_id,''), created_at, updated_at FROM flows WHERE id = ?`, id)
	f, err := scanFlow(row)
	if err == sql.ErrNoRows {
		http.Error(w, "not found", 404)
		return
	}
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	f.Steps, err = p.loadFlowSteps(id)
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	// Enrich steps with feature snapshots in parallel.
	type result struct {
		idx  int
		snap *FeatureSnapshot
		err  error
	}
	ch := make(chan result, len(f.Steps))
	for i, s := range f.Steps {
		go func(idx int, slug, featureID string) {
			snap, err := p.fetchFeatureSnapshot(slug, featureID)
			ch <- result{idx, snap, err}
		}(i, s.ProjectSlug, s.FeatureID)
	}
	for range f.Steps {
		res := <-ch
		i := res.idx
		if res.err != nil {
			reason := "fetch_error"
			if _, wbErr := p.getWorkbench(f.Steps[i].ProjectSlug); wbErr != nil {
				reason = "project_not_registered"
			} else {
				reason = "feature_not_found"
			}
			f.Steps[i].Tombstoned = true
			f.Steps[i].TombstonedReason = reason
			p.db.Exec(`UPDATE flow_steps SET tombstoned=1, tombstoned_reason=? WHERE id=?`, reason, f.Steps[i].ID)
		} else {
			f.Steps[i].Feature = res.snap
			if res.snap.Confidence == "orphaned" {
				f.Steps[i].Tombstoned = true
				f.Steps[i].TombstonedReason = "feature_not_found"
				p.db.Exec(`UPDATE flow_steps SET tombstoned=1, tombstoned_reason='feature_not_found' WHERE id=?`, f.Steps[i].ID)
			} else if f.Steps[i].Tombstoned {
				// The feature resolves again: tombstones must clear when it recovers.
				f.Steps[i].Tombstoned = false
				f.Steps[i].TombstonedReason = ""
				p.db.Exec(`UPDATE flow_steps SET tombstoned=0, tombstoned_reason='' WHERE id=?`, f.Steps[i].ID)
			}
		}
	}
	f.Links, err = p.loadFlowLinks(id)
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	writeJSON(w, f)
}

func (p *Platform) updateFlow(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var req struct {
		Name        *string  `json:"name"`
		Description *string  `json:"description"`
		Status      *string  `json:"status"`
		Owner       *string  `json:"owner"`
		Tags        []string `json:"tags"`
		FolderID    *string  `json:"folderId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid JSON", 400)
		return
	}

	var cur Flow
	var tagsJSON string
	err := p.db.QueryRow(`SELECT id, name, description, status, owner, tags, COALESCE(folder_id,''), created_at, updated_at FROM flows WHERE id = ?`, id).
		Scan(&cur.ID, &cur.Name, &cur.Description, &cur.Status, &cur.Owner, &tagsJSON, &cur.FolderID, &cur.CreatedAt, &cur.UpdatedAt)
	if err == sql.ErrNoRows {
		http.Error(w, "not found", 404)
		return
	}
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	json.Unmarshal([]byte(tagsJSON), &cur.Tags)

	if req.Name != nil {
		if strings.TrimSpace(*req.Name) == "" {
			http.Error(w, "name cannot be empty", 400)
			return
		}
		cur.Name = *req.Name
	}
	if req.Description != nil {
		cur.Description = *req.Description
	}
	if req.Status != nil {
		if !validFlowStatuses[*req.Status] {
			http.Error(w, "status must be one of: draft, active, archived", 400)
			return
		}
		cur.Status = *req.Status
	}
	if req.Owner != nil {
		cur.Owner = *req.Owner
	}
	if req.Tags != nil {
		cur.Tags = req.Tags
	}
	if req.FolderID != nil {
		if ok, err := p.folderExists(*req.FolderID); err != nil || !ok {
			http.Error(w, "folder not found", 400)
			return
		}
		cur.FolderID = *req.FolderID
	}
	if cur.Tags == nil {
		cur.Tags = []string{}
	}
	newTagsJSON, _ := json.Marshal(cur.Tags)
	if _, err := p.db.Exec(
		`UPDATE flows SET name=?, description=?, status=?, owner=?, tags=?, folder_id=NULLIF(?, ''), updated_at=datetime('now') WHERE id=?`,
		cur.Name, cur.Description, cur.Status, cur.Owner, string(newTagsJSON), cur.FolderID, id,
	); err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	// Respond with the flow as stored: fresh updatedAt, and its real steps and
	// links (this is a metadata update; they are unchanged, not emptied).
	_ = p.db.QueryRow(`SELECT updated_at FROM flows WHERE id = ?`, id).Scan(&cur.UpdatedAt)
	if cur.Steps, err = p.loadFlowSteps(id); err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	if cur.Links, err = p.loadFlowLinks(id); err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	writeJSON(w, cur)
}

func (p *Platform) deleteFlow(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	res, err := p.db.Exec(`DELETE FROM flows WHERE id = ?`, id)
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		http.Error(w, "not found", 404)
		return
	}
	w.WriteHeader(204)
}

func (p *Platform) addFlowStep(w http.ResponseWriter, r *http.Request) {
	flowID := r.PathValue("id")
	var req struct {
		ParentStepID    string `json:"parentStepId"`
		BranchCondition string `json:"branchCondition"`
		ProjectSlug     string `json:"projectSlug"`
		FeatureID       string `json:"featureId"`
		Note            string `json:"note"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid JSON", 400)
		return
	}
	if req.ProjectSlug == "" || req.FeatureID == "" {
		http.Error(w, "projectSlug and featureId are required", 400)
		return
	}

	var exists int
	p.db.QueryRow(`SELECT 1 FROM flows WHERE id = ?`, flowID).Scan(&exists)
	if exists == 0 {
		http.Error(w, "flow not found", 404)
		return
	}

	if req.ParentStepID != "" {
		var parentExists int
		p.db.QueryRow(`SELECT 1 FROM flow_steps WHERE id=? AND flow_id=?`, req.ParentStepID, flowID).Scan(&parentExists)
		if parentExists == 0 {
			http.Error(w, "parentStepId not found in this flow", 400)
			return
		}
	}

	var pos int
	if req.ParentStepID != "" {
		p.db.QueryRow(`SELECT COALESCE(MAX(position)+1,0) FROM flow_steps WHERE flow_id=? AND parent_step_id=?`, flowID, req.ParentStepID).Scan(&pos)
	} else {
		p.db.QueryRow(`SELECT COALESCE(MAX(position)+1,0) FROM flow_steps WHERE flow_id=? AND parent_step_id IS NULL`, flowID).Scan(&pos)
	}

	id := randomID()
	var parentArg any
	if req.ParentStepID != "" {
		parentArg = req.ParentStepID
	}
	if _, err := p.db.Exec(
		`INSERT INTO flow_steps (id, flow_id, parent_step_id, position, branch_condition, project_slug, feature_id, note) VALUES (?,?,?,?,?,?,?,?)`,
		id, flowID, parentArg, pos, req.BranchCondition, req.ProjectSlug, req.FeatureID, req.Note,
	); err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	p.db.Exec(`UPDATE flows SET updated_at=datetime('now') WHERE id=?`, flowID)

	s := FlowStep{ID: id, FlowID: flowID, ParentStepID: req.ParentStepID, Position: pos,
		BranchCondition: req.BranchCondition, ProjectSlug: req.ProjectSlug, FeatureID: req.FeatureID, Note: req.Note}
	_ = p.db.QueryRow(`SELECT created_at FROM flow_steps WHERE id = ?`, id).Scan(&s.CreatedAt)

	// Enrich with feature snapshot; determine tombstone reason at creation time.
	snap, snapErr := p.fetchFeatureSnapshot(req.ProjectSlug, req.FeatureID)
	if snapErr != nil {
		reason := "fetch_error"
		if _, wbErr := p.getWorkbench(req.ProjectSlug); wbErr != nil {
			reason = "project_not_registered"
		} else {
			reason = "feature_not_found"
		}
		s.Tombstoned = true
		s.TombstonedReason = reason
		p.db.Exec(`UPDATE flow_steps SET tombstoned=1, tombstoned_reason=? WHERE id=?`, reason, id)
	} else {
		s.Feature = snap
		if snap.Confidence == "orphaned" {
			s.Tombstoned = true
			s.TombstonedReason = "feature_not_found"
			p.db.Exec(`UPDATE flow_steps SET tombstoned=1, tombstoned_reason='feature_not_found' WHERE id=?`, id)
		}
	}

	w.WriteHeader(201)
	writeJSON(w, s)
}

func (p *Platform) updateFlowStep(w http.ResponseWriter, r *http.Request) {
	flowID := r.PathValue("id")
	stepID := r.PathValue("stepId")
	var req struct {
		Note            *string `json:"note"`
		BranchCondition *string `json:"branchCondition"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid JSON", 400)
		return
	}

	var s FlowStep
	var parentID sql.NullString
	var tombInt int
	err := p.db.QueryRow(
		`SELECT id, flow_id, parent_step_id, position, branch_condition, project_slug, feature_id, note, tombstoned, created_at FROM flow_steps WHERE id=? AND flow_id=?`,
		stepID, flowID,
	).Scan(&s.ID, &s.FlowID, &parentID, &s.Position, &s.BranchCondition, &s.ProjectSlug, &s.FeatureID, &s.Note, &tombInt, &s.CreatedAt)
	if err == sql.ErrNoRows {
		http.Error(w, "not found", 404)
		return
	}
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	s.ParentStepID = parentID.String
	s.Tombstoned = tombInt != 0

	if req.Note != nil {
		s.Note = *req.Note
	}
	if req.BranchCondition != nil {
		s.BranchCondition = *req.BranchCondition
	}
	if _, err := p.db.Exec(
		`UPDATE flow_steps SET note=?, branch_condition=? WHERE id=?`,
		s.Note, s.BranchCondition, stepID,
	); err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	p.db.Exec(`UPDATE flows SET updated_at=datetime('now') WHERE id=?`, flowID)
	writeJSON(w, s)
}

func (p *Platform) removeFlowStep(w http.ResponseWriter, r *http.Request) {
	flowID := r.PathValue("id")
	stepID := r.PathValue("stepId")
	res, err := p.db.Exec(`DELETE FROM flow_steps WHERE id=? AND flow_id=?`, stepID, flowID)
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		http.Error(w, "not found", 404)
		return
	}
	p.db.Exec(`UPDATE flows SET updated_at=datetime('now') WHERE id=?`, flowID)
	w.WriteHeader(204)
}

func (p *Platform) moveFlowStep(w http.ResponseWriter, r *http.Request) {
	flowID := r.PathValue("id")
	stepID := r.PathValue("stepId")

	var dir int
	switch r.URL.Query().Get("dir") {
	case "-1":
		dir = -1
	case "1":
		dir = 1
	default:
		http.Error(w, "dir must be -1 or 1", 400)
		return
	}

	var pos int
	var parentID sql.NullString
	err := p.db.QueryRow(`SELECT position, parent_step_id FROM flow_steps WHERE id=? AND flow_id=?`, stepID, flowID).
		Scan(&pos, &parentID)
	if err == sql.ErrNoRows {
		http.Error(w, "not found", 404)
		return
	}
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}

	// Find the actual neighbour in sorted order rather than assuming
	// sequential positions (gaps form when steps are deleted).
	var neighbourQuery string
	var neighbourArgs []any
	if dir == -1 {
		if parentID.Valid {
			neighbourQuery = `SELECT id, position FROM flow_steps WHERE flow_id=? AND parent_step_id=? AND position<? AND id!=? ORDER BY position DESC LIMIT 1`
			neighbourArgs = []any{flowID, parentID.String, pos, stepID}
		} else {
			neighbourQuery = `SELECT id, position FROM flow_steps WHERE flow_id=? AND parent_step_id IS NULL AND position<? AND id!=? ORDER BY position DESC LIMIT 1`
			neighbourArgs = []any{flowID, pos, stepID}
		}
	} else {
		if parentID.Valid {
			neighbourQuery = `SELECT id, position FROM flow_steps WHERE flow_id=? AND parent_step_id=? AND position>? AND id!=? ORDER BY position ASC LIMIT 1`
			neighbourArgs = []any{flowID, parentID.String, pos, stepID}
		} else {
			neighbourQuery = `SELECT id, position FROM flow_steps WHERE flow_id=? AND parent_step_id IS NULL AND position>? AND id!=? ORDER BY position ASC LIMIT 1`
			neighbourArgs = []any{flowID, pos, stepID}
		}
	}

	var swapID string
	var swapPos int
	p.db.QueryRow(neighbourQuery, neighbourArgs...).Scan(&swapID, &swapPos)

	tx, err := p.db.Begin()
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	defer tx.Rollback()

	if swapID != "" {
		tx.Exec(`UPDATE flow_steps SET position=? WHERE id=?`, swapPos, stepID)
		tx.Exec(`UPDATE flow_steps SET position=? WHERE id=?`, pos, swapID)
	}
	tx.Exec(`UPDATE flows SET updated_at=datetime('now') WHERE id=?`, flowID)

	if err := tx.Commit(); err != nil {
		http.Error(w, err.Error(), 500)
		return
	}

	var s FlowStep
	var pID sql.NullString
	var tombInt int
	p.db.QueryRow(
		`SELECT id, flow_id, parent_step_id, position, branch_condition, project_slug, feature_id, note, tombstoned, created_at FROM flow_steps WHERE id=?`, stepID,
	).Scan(&s.ID, &s.FlowID, &pID, &s.Position, &s.BranchCondition, &s.ProjectSlug, &s.FeatureID, &s.Note, &tombInt, &s.CreatedAt)
	s.ParentStepID = pID.String
	s.Tombstoned = tombInt != 0
	writeJSON(w, s)
}

// setFlowStepInput is the request body for PUT /flows/{id}/steps
type setFlowStepInput struct {
	ClientID        string `json:"clientId"`
	ParentClientID  string `json:"parentClientId"`
	BranchCondition string `json:"branchCondition"`
	ProjectSlug     string `json:"projectSlug"`
	FeatureID       string `json:"featureId"`
	Note            string `json:"note"`
}

type setFlowLinkInput struct {
	FromClientID string   `json:"fromClientId"`
	ToClientID   string   `json:"toClientId"`
	Description  string   `json:"description"`
	Comment      string   `json:"comment"`
	Tags         []string `json:"tags"`
}

func (p *Platform) setFlowSteps(w http.ResponseWriter, r *http.Request) {
	flowID := r.PathValue("id")

	var req struct {
		Steps []setFlowStepInput `json:"steps"`
		Links []setFlowLinkInput `json:"links"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid JSON", 400)
		return
	}

	if err := validateStepTree(req.Steps); err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	if err := validateStepLinks(req.Steps, req.Links); err != nil {
		http.Error(w, err.Error(), 400)
		return
	}

	var exists int
	p.db.QueryRow(`SELECT 1 FROM flows WHERE id = ?`, flowID).Scan(&exists)
	if exists == 0 {
		http.Error(w, "flow not found", 404)
		return
	}

	tx, err := p.db.Begin()
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	defer tx.Rollback()

	tx.Exec(`DELETE FROM flow_step_links WHERE flow_id=?`, flowID)
	tx.Exec(`DELETE FROM flow_steps WHERE flow_id=?`, flowID)

	// Map clientId → server-assigned ID
	idMap := make(map[string]string, len(req.Steps))
	for _, s := range req.Steps {
		idMap[s.ClientID] = randomID()
	}

	// Insert steps: roots first (parentClientId == ""), then children.
	// Since the tree is acyclic and single-rooted, sort by depth.
	inserted := make(map[string]bool)
	posCounter := make(map[string]int)

	var insertStep func(s setFlowStepInput) error
	insertStep = func(s setFlowStepInput) error {
		if inserted[s.ClientID] {
			return nil
		}
		if s.ParentClientID != "" && !inserted[s.ParentClientID] {
			// Insert parent first.
			for _, candidate := range req.Steps {
				if candidate.ClientID == s.ParentClientID {
					if err := insertStep(candidate); err != nil {
						return err
					}
					break
				}
			}
		}
		serverID := idMap[s.ClientID]
		var parentArg any
		posKey := ""
		if s.ParentClientID != "" {
			parentServerID := idMap[s.ParentClientID]
			parentArg = parentServerID
			posKey = parentServerID
		}
		pos := posCounter[posKey]
		posCounter[posKey]++
		_, err := tx.Exec(
			`INSERT INTO flow_steps (id, flow_id, parent_step_id, position, branch_condition, project_slug, feature_id, note) VALUES (?,?,?,?,?,?,?,?)`,
			serverID, flowID, parentArg, pos, s.BranchCondition, s.ProjectSlug, s.FeatureID, s.Note,
		)
		if err != nil {
			return err
		}
		inserted[s.ClientID] = true
		return nil
	}

	for _, s := range req.Steps {
		if err := insertStep(s); err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
	}

	for _, l := range req.Links {
		fromID, ok1 := idMap[l.FromClientID]
		toID, ok2 := idMap[l.ToClientID]
		if !ok1 || !ok2 {
			http.Error(w, fmt.Sprintf("link references unknown clientId: %s → %s", l.FromClientID, l.ToClientID), 400)
			return
		}
		if l.Tags == nil {
			l.Tags = []string{}
		}
		lTagsJSON, _ := json.Marshal(l.Tags)
		if _, err := tx.Exec(
			`INSERT INTO flow_step_links (flow_id, from_step_id, to_step_id, description, comment, tags) VALUES (?,?,?,?,?,?)`,
			flowID, fromID, toID, l.Description, l.Comment, string(lTagsJSON),
		); err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
	}

	tx.Exec(`UPDATE flows SET updated_at=datetime('now') WHERE id=?`, flowID)

	if err := tx.Commit(); err != nil {
		http.Error(w, err.Error(), 500)
		return
	}

	// Capture enriched flow via getFlow, then wrap with the clientId→stepId map.
	flowRec := httptest.NewRecorder()
	p.getFlow(flowRec, r)
	if flowRec.Code >= 400 {
		w.WriteHeader(flowRec.Code)
		w.Write(flowRec.Body.Bytes())
		return
	}
	var enrichedFlow Flow
	json.Unmarshal(flowRec.Body.Bytes(), &enrichedFlow)
	writeJSON(w, struct {
		Flow    Flow              `json:"flow"`
		StepIds map[string]string `json:"stepIds"`
	}{Flow: enrichedFlow, StepIds: idMap})
}

// validateStepLinks applies the rules addFlowStep and setFlowLink enforce one
// at a time to a whole set-steps payload: every step names a feature, and
// links join two distinct known steps, at most once per (from, to) pair.
func validateStepLinks(steps []setFlowStepInput, links []setFlowLinkInput) error {
	known := make(map[string]bool, len(steps))
	for _, s := range steps {
		if s.ProjectSlug == "" || s.FeatureID == "" {
			return fmt.Errorf("step %q: projectSlug and featureId are required", s.ClientID)
		}
		known[s.ClientID] = true
	}
	seen := make(map[[2]string]bool, len(links))
	for _, l := range links {
		if !known[l.FromClientID] || !known[l.ToClientID] {
			return fmt.Errorf("link references unknown clientId: %s → %s", l.FromClientID, l.ToClientID)
		}
		if l.FromClientID == l.ToClientID {
			return fmt.Errorf("link %s → %s: a step cannot link to itself", l.FromClientID, l.ToClientID)
		}
		key := [2]string{l.FromClientID, l.ToClientID}
		if seen[key] {
			return fmt.Errorf("duplicate link %s → %s", l.FromClientID, l.ToClientID)
		}
		seen[key] = true
	}
	return nil
}

func validateStepTree(steps []setFlowStepInput) error {
	if len(steps) == 0 {
		return nil
	}

	seen := make(map[string]bool, len(steps))
	for _, s := range steps {
		if s.ClientID == "" {
			return fmt.Errorf("each step must have a non-empty clientId")
		}
		if seen[s.ClientID] {
			return fmt.Errorf("duplicate clientId: %q", s.ClientID)
		}
		seen[s.ClientID] = true
	}

	var roots int
	for _, s := range steps {
		if s.ParentClientID == "" {
			roots++
		} else if !seen[s.ParentClientID] {
			return fmt.Errorf("step %q references unknown parentClientId %q", s.ClientID, s.ParentClientID)
		}
	}
	if roots != 1 {
		return fmt.Errorf("exactly one root step (parentClientId null/empty) required, found %d", roots)
	}

	// Cycle detection via DFS.
	children := make(map[string][]string, len(steps))
	for _, s := range steps {
		if s.ParentClientID != "" {
			children[s.ParentClientID] = append(children[s.ParentClientID], s.ClientID)
		}
	}
	visited := make(map[string]int, len(steps)) // 0=unvisited,1=in-progress,2=done
	var dfs func(id string) error
	dfs = func(id string) error {
		if visited[id] == 1 {
			return fmt.Errorf("cycle detected at step %q", id)
		}
		if visited[id] == 2 {
			return nil
		}
		visited[id] = 1
		for _, child := range children[id] {
			if err := dfs(child); err != nil {
				return err
			}
		}
		visited[id] = 2
		return nil
	}
	for _, s := range steps {
		if s.ParentClientID == "" {
			if err := dfs(s.ClientID); err != nil {
				return err
			}
		}
	}
	return nil
}

func (p *Platform) setFlowLink(w http.ResponseWriter, r *http.Request) {
	flowID := r.PathValue("id")
	fromID := r.PathValue("fromId")
	toID := r.PathValue("toId")

	// Fields left out of the body keep their current value on an existing
	// link (and default to empty on a new one), so editing one field - e.g.
	// the edge label - doesn't wipe the comment and tags.
	var req struct {
		Description *string   `json:"description"`
		Comment     *string   `json:"comment"`
		Tags        *[]string `json:"tags"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil && err != io.EOF {
		http.Error(w, "invalid JSON", 400)
		return
	}

	var exists int
	p.db.QueryRow(`SELECT 1 FROM flows WHERE id = ?`, flowID).Scan(&exists)
	if exists == 0 {
		http.Error(w, "flow not found", 404)
		return
	}
	if fromID == toID {
		http.Error(w, "a step cannot link to itself", 400)
		return
	}
	// Both ends must be steps of this flow. They may belong to different projects
	// (that is what makes a link cross-project), but never to a different flow.
	var inFlow int
	p.db.QueryRow(`SELECT COUNT(*) FROM flow_steps WHERE flow_id = ? AND id IN (?, ?)`, flowID, fromID, toID).Scan(&inFlow)
	if inFlow != 2 {
		http.Error(w, "both steps must belong to this flow", 400)
		return
	}

	link := FlowLink{FlowID: flowID, FromStepID: fromID, ToStepID: toID, Tags: []string{}}
	var curTags string
	if err := p.db.QueryRow(`SELECT description, comment, tags FROM flow_step_links WHERE flow_id=? AND from_step_id=? AND to_step_id=?`, flowID, fromID, toID).
		Scan(&link.Description, &link.Comment, &curTags); err == nil {
		if json.Unmarshal([]byte(curTags), &link.Tags) != nil || link.Tags == nil {
			link.Tags = []string{}
		}
	}
	if req.Description != nil {
		link.Description = *req.Description
	}
	if req.Comment != nil {
		link.Comment = *req.Comment
	}
	if req.Tags != nil {
		link.Tags = *req.Tags
		if link.Tags == nil {
			link.Tags = []string{}
		}
	}

	tagsJSON, _ := json.Marshal(link.Tags)
	if _, err := p.db.Exec(
		`INSERT INTO flow_step_links (flow_id, from_step_id, to_step_id, description, comment, tags) VALUES (?,?,?,?,?,?)
		 ON CONFLICT(from_step_id, to_step_id) DO UPDATE SET
		   description=excluded.description, comment=excluded.comment, tags=excluded.tags`,
		flowID, fromID, toID, link.Description, link.Comment, string(tagsJSON),
	); err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	p.db.Exec(`UPDATE flows SET updated_at=datetime('now') WHERE id=?`, flowID)
	writeJSON(w, link)
}

func (p *Platform) deleteFlowLink(w http.ResponseWriter, r *http.Request) {
	flowID := r.PathValue("id")
	fromID := r.PathValue("fromId")
	toID := r.PathValue("toId")
	res, err := p.db.Exec(`DELETE FROM flow_step_links WHERE flow_id=? AND from_step_id=? AND to_step_id=?`, flowID, fromID, toID)
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		http.Error(w, "not found", 404)
		return
	}
	p.db.Exec(`UPDATE flows SET updated_at=datetime('now') WHERE id=?`, flowID)
	w.WriteHeader(204)
}

func (p *Platform) fetchFeatureSnapshot(projectSlug, featureID string) (*FeatureSnapshot, error) {
	wb, err := p.getWorkbench(projectSlug)
	if err != nil {
		return nil, err
	}
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/api/features/"+featureID+"?commit=HEAD", nil)
	wb.Handler().ServeHTTP(rec, req)
	if rec.Code != 200 {
		return nil, fmt.Errorf("feature not found")
	}
	var feat struct {
		Title           string          `json:"title"`
		Kind            string          `json:"kind"`
		Operation       string          `json:"operation"`
		Protocol        string          `json:"protocol"`
		Confidence      string          `json:"confidence"`
		EffectiveAnchor json.RawMessage `json:"effectiveAnchor"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &feat); err != nil {
		return nil, err
	}
	var projName string
	p.db.QueryRow("SELECT name FROM projects WHERE slug=?", projectSlug).Scan(&projName)
	return &FeatureSnapshot{
		Title: feat.Title, Kind: feat.Kind,
		Operation: feat.Operation, Protocol: feat.Protocol,
		ProjectName:     projName,
		Confidence:      feat.Confidence,
		EffectiveAnchor: feat.EffectiveAnchor,
	}, nil
}

type rawFeature struct {
	ID        string          `json:"id"`
	Title     string          `json:"title"`
	Kind      string          `json:"kind"`
	Operation string          `json:"operation"`
	Protocol  string          `json:"protocol"`
	Tags      []string        `json:"tags"`
	Anchor    json.RawMessage `json:"anchor"`
}

type CatalogFeature struct {
	ProjectSlug string          `json:"projectSlug"`
	ProjectName string          `json:"projectName"`
	ID          string          `json:"id"`
	Title       string          `json:"title"`
	Kind        string          `json:"kind"`
	Operation   string          `json:"operation,omitempty"`
	Protocol    string          `json:"protocol,omitempty"`
	Tags        []string        `json:"tags,omitempty"`
	Anchor      json.RawMessage `json:"anchor,omitempty"`
	Tombstoned  bool            `json:"tombstoned,omitempty"`
}

func (p *Platform) featuresForProject(slug, name string) ([]CatalogFeature, error) {
	wb, err := p.getWorkbench(slug)
	if err != nil {
		return nil, err
	}
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/api/features", nil)
	wb.Handler().ServeHTTP(rec, req)
	if rec.Code != 200 {
		return nil, fmt.Errorf("features fetch failed: %d", rec.Code)
	}
	var raw []rawFeature
	if err := json.Unmarshal(rec.Body.Bytes(), &raw); err != nil {
		return nil, err
	}
	out := make([]CatalogFeature, len(raw))
	for i, f := range raw {
		out[i] = CatalogFeature{
			ProjectSlug: slug,
			ProjectName: name,
			ID:          f.ID,
			Title:       f.Title,
			Kind:        f.Kind,
			Operation:   f.Operation,
			Protocol:    f.Protocol,
			Tags:        f.Tags,
			Anchor:      f.Anchor,
		}
	}
	return out, nil
}

func (p *Platform) searchFeatures(w http.ResponseWriter, r *http.Request) {
	q := strings.ToLower(r.URL.Query().Get("q"))
	kind := r.URL.Query().Get("kind")
	projects := r.URL.Query()["project"]
	limit := 50
	if l := r.URL.Query().Get("limit"); l != "" {
		if n, err := strconv.Atoi(l); err == nil && n > 0 {
			limit = min(n, 200) // documented maximum: clamp, don't fall back to the default
		}
	}

	// Determine which project slugs to query.
	type projEntry struct{ slug, name string }
	var entries []projEntry
	if len(projects) > 0 {
		for _, slug := range projects {
			var name string
			if err := p.db.QueryRow("SELECT name FROM projects WHERE slug=?", slug).Scan(&name); err != nil {
				// An unknown slug is a caller mistake (typo, removed project),
				// not an empty result.
				http.Error(w, "project not found: "+slug, 404)
				return
			}
			entries = append(entries, projEntry{slug, name})
		}
	} else {
		rows, err := p.db.Query("SELECT slug, name FROM projects ORDER BY name")
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		defer rows.Close()
		for rows.Next() {
			var e projEntry
			rows.Scan(&e.slug, &e.name)
			entries = append(entries, e)
		}
	}

	var all []CatalogFeature
	for _, e := range entries {
		feats, err := p.featuresForProject(e.slug, e.name)
		if err != nil {
			continue
		}
		all = append(all, feats...)
	}

	// Filter by kind and free text.
	var filtered []CatalogFeature
	for _, f := range all {
		if kind != "" && f.Kind != kind {
			continue
		}
		if q != "" {
			title := strings.ToLower(f.Title)
			op := strings.ToLower(f.Operation)
			tagMatch := false
			for _, t := range f.Tags {
				if strings.Contains(strings.ToLower(t), q) {
					tagMatch = true
					break
				}
			}
			if !strings.Contains(title, q) && !strings.Contains(op, q) && !tagMatch {
				continue
			}
		}
		filtered = append(filtered, f)
	}

	// Sort by relevance: title prefix > title contains > tag/op match.
	if q != "" {
		type scored struct {
			f     CatalogFeature
			score int
		}
		var ss []scored
		for _, f := range filtered {
			title := strings.ToLower(f.Title)
			score := 0
			if strings.HasPrefix(title, q) {
				score = 3
			} else if strings.Contains(title, q) {
				score = 2
			} else {
				score = 1
			}
			ss = append(ss, scored{f, score})
		}
		sort.Slice(ss, func(i, j int) bool {
			if ss[i].score != ss[j].score {
				return ss[i].score > ss[j].score
			}
			return ss[i].f.Title < ss[j].f.Title
		})
		filtered = make([]CatalogFeature, len(ss))
		for i, s := range ss {
			filtered[i] = s.f
		}
	}

	if len(filtered) > limit {
		filtered = filtered[:limit]
	}
	if filtered == nil {
		filtered = []CatalogFeature{}
	}
	writeJSON(w, filtered)
}

func (p *Platform) batchFeatures(w http.ResponseWriter, r *http.Request) {
	refsParam := r.URL.Query().Get("refs")
	if refsParam == "" {
		writeJSON(w, []CatalogFeature{})
		return
	}
	var result []CatalogFeature
	for _, pair := range strings.Split(refsParam, ",") {
		parts := strings.SplitN(strings.TrimSpace(pair), ":", 2)
		if len(parts) != 2 {
			continue
		}
		slug, id := parts[0], parts[1]
		snap, err := p.fetchFeatureSnapshot(slug, id)
		if err != nil || snap == nil {
			var projName string
			p.db.QueryRow("SELECT name FROM projects WHERE slug=?", slug).Scan(&projName)
			result = append(result, CatalogFeature{
				ProjectSlug: slug,
				ProjectName: projName,
				ID:          id,
				Tombstoned:  true,
			})
			continue
		}
		result = append(result, CatalogFeature{
			ProjectSlug: slug,
			ProjectName: snap.ProjectName,
			ID:          id,
			Title:       snap.Title,
			Kind:        snap.Kind,
			Operation:   snap.Operation,
			Protocol:    snap.Protocol,
		})
	}
	if result == nil {
		result = []CatalogFeature{}
	}
	writeJSON(w, result)
}

// registerPlatformRoutes wires every /api/platform/* REST route onto mux. The server
// and the MCP in-process proxy (Handler) share it so the two can never drift apart.
func (p *Platform) registerPlatformRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/platform/projects", p.listProjects)
	mux.HandleFunc("POST /api/platform/projects", p.createProject)
	mux.HandleFunc("PATCH /api/platform/projects/{slug}", p.updateProject)
	mux.HandleFunc("DELETE /api/platform/projects/{slug}", p.deleteProject)
	mux.HandleFunc("GET /api/platform/baselines", p.listAllBaselines)
	mux.HandleFunc("GET /api/platform/settings", p.getSettings)
	mux.HandleFunc("PUT /api/platform/settings", p.putSettings)
	mux.HandleFunc("GET /api/platform/flows/facets", p.listFlowFacets)
	mux.HandleFunc("GET /api/platform/flows", p.listFlows)
	mux.HandleFunc("POST /api/platform/flows", p.createFlow)
	mux.HandleFunc("GET /api/platform/flows/{id}", p.getFlow)
	mux.HandleFunc("PATCH /api/platform/flows/{id}", p.updateFlow)
	mux.HandleFunc("DELETE /api/platform/flows/{id}", p.deleteFlow)
	mux.HandleFunc("POST /api/platform/flows/{id}/steps", p.addFlowStep)
	mux.HandleFunc("PATCH /api/platform/flows/{id}/steps/{stepId}", p.updateFlowStep)
	mux.HandleFunc("DELETE /api/platform/flows/{id}/steps/{stepId}", p.removeFlowStep)
	mux.HandleFunc("PUT /api/platform/flows/{id}/steps", p.setFlowSteps)
	mux.HandleFunc("POST /api/platform/flows/{id}/steps/{stepId}/move", p.moveFlowStep)
	mux.HandleFunc("PUT /api/platform/flows/{id}/links/{fromId}/{toId}", p.setFlowLink)
	mux.HandleFunc("DELETE /api/platform/flows/{id}/links/{fromId}/{toId}", p.deleteFlowLink)
	mux.HandleFunc("GET /api/platform/flows/{id}/baselines", p.listFlowBaselines)
	mux.HandleFunc("GET /api/platform/flows/{id}/baselines/latest", p.latestFlowBaseline)
	mux.HandleFunc("GET /api/platform/flows/{id}/baselines/{bId}", p.getFlowBaseline)
	mux.HandleFunc("POST /api/platform/flows/{id}/baselines", p.createFlowBaseline)
	mux.HandleFunc("DELETE /api/platform/flows/{id}/baselines/{bId}", p.deleteFlowBaseline)
	mux.HandleFunc("GET /api/platform/flows/{id}/delta", p.getFlowDelta)
	mux.HandleFunc("GET /api/platform/flows/{id}/findings", p.listFlowFindings)
	mux.HandleFunc("GET /api/platform/features/search", p.searchFeatures)
	mux.HandleFunc("GET /api/platform/features", p.batchFeatures)
	mux.HandleFunc("GET /api/platform/flow-views", p.listFlowViews)
	mux.HandleFunc("POST /api/platform/flow-views", p.createFlowView)
	mux.HandleFunc("PATCH /api/platform/flow-views/{id}", p.updateFlowView)
	mux.HandleFunc("DELETE /api/platform/flow-views/{id}", p.deleteFlowView)
	p.registerFolderRoutes(mux)
}

// Handler returns the platform's REST mux (used internally for MCP in-process calls).
func (p *Platform) Handler() http.Handler {
	mux := http.NewServeMux()
	p.registerPlatformRoutes(mux)
	return mux
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(v)
}

func randomID() string {
	b := make([]byte, 8)
	rand.Read(b)
	return hex.EncodeToString(b)
}

func slugify(name string) string {
	s := strings.ToLower(name)
	s = strings.Map(func(r rune) rune {
		if r >= 'a' && r <= 'z' || r >= '0' && r <= '9' {
			return r
		}
		return '-'
	}, s)
	// Collapse multiple dashes.
	for strings.Contains(s, "--") {
		s = strings.ReplaceAll(s, "--", "-")
	}
	return strings.Trim(s, "-")
}
