package server

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
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
	// flowMu serialises flow graph edits (each reads the graph, then rewrites edges).
	flowMu sync.Mutex
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

// Routes is the whole server: project and cross-project REST, each project's workbench under
// /api/projects/{slug}/, the aggregate MCP at /mcp and the UI for everything else.
func (p *Platform) Routes() http.Handler {
	mux := http.NewServeMux()
	p.registerPlatformRoutes(mux)
	mux.Handle("/api/projects/{slug}/", p.workbenchRouter())
	mux.Handle("/mcp", newPlatformMCP(p))
	mux.Handle("/", spaHandler())
	return mux
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

	log.Printf("benchd listening on %s (data=%s)", addr, dataDir)
	return http.ListenAndServe(addr, workbench.WithMiddleware(p.Routes()))
}

func NewPlatform(dataDir string) (*Platform, error) {
	if err := moveDB(dataDir, legacyServerDBName, serverDBName); err != nil {
		return nil, err
	}
	dbPath := filepath.Join(dataDir, serverDBName)
	conn, err := sql.Open("sqlite", dbPath+"?_pragma=journal_mode(wal)&_pragma=foreign_keys(on)&_pragma=busy_timeout(5000)")
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
	// Old databases need tombstoned_reason before converting (older still lack it).
	if _, err := conn.Exec(`SELECT id FROM flow_steps LIMIT 0`); err == nil {
		if _, err := conn.Exec(`SELECT tombstoned_reason FROM flow_steps LIMIT 0`); err != nil {
			if _, err2 := conn.Exec(`ALTER TABLE flow_steps ADD COLUMN tombstoned_reason TEXT NOT NULL DEFAULT ''`); err2 != nil {
				return nil, err2
			}
		}
	}
	if err := setUpFlowGraph(conn, dataDir); err != nil {
		return nil, err
	}
	if err := setUpCrossLinks(conn); err != nil {
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
	if err := moveProjectDBs(conn, dataDir); err != nil {
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

	dbPath := filepath.Join(p.dataDir, projectDBName(slug, repoPath))
	wb, err = workbench.Open(repoPath, dbPath, workbench.WithCrossLinks(p.crossLinksFor(slug)))
	if err != nil {
		return nil, err
	}
	p.workbenches[slug] = wb
	return wb, nil
}

// enrichProject adds the live data (remote, activity, stats, risk) read from the project's workbench.
func (p *Platform) enrichProject(proj *Project) {
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
}

func (p *Platform) getProject(w http.ResponseWriter, r *http.Request) {
	var proj Project
	err := p.db.QueryRow("SELECT id, name, slug, repo_path, created_at FROM projects WHERE slug = ?", r.PathValue("slug")).
		Scan(&proj.ID, &proj.Name, &proj.Slug, &proj.RepoPath, &proj.CreatedAt)
	if err != nil {
		http.Error(w, "not found", 404)
		return
	}
	p.enrichProject(&proj)
	writeJSON(w, proj)
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
		p.enrichProject(&proj)
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
	if slugify(req.Name) == "" {
		http.Error(w, "name must contain at least one letter or digit (the project slug is derived from it)", 400)
		return
	}
	if p.projectNameTaken(req.Name, "") {
		http.Error(w, "project with that name already exists", 409)
		return
	}
	slug := p.freeSlug(req.Name)

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

	// A new path closes the project's workbench and renames its database to match.
	if newPath != currentPath {
		p.mu.Lock()
		if wb, ok := p.workbenches[slug]; ok {
			wb.Close()
			delete(p.workbenches, slug)
		}
		err := moveDB(p.dataDir, projectDBName(slug, currentPath), projectDBName(slug, newPath))
		p.mu.Unlock()
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
	}

	if _, err := p.db.Exec(
		"UPDATE projects SET name = ?, repo_path = ? WHERE slug = ?",
		newName, newPath, slug,
	); err != nil {
		http.Error(w, err.Error(), 500)
		return
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

// freeSlug derives a slug from name that no project holds; a clash ("Foo Bar", "foo-bar") gets
// the first free -2, -3, ... suffix.
func (p *Platform) freeSlug(name string) string {
	base := slugify(name)
	for i := 1; ; i++ {
		slug := base
		if i > 1 {
			slug = fmt.Sprintf("%s-%d", base, i)
		}
		var n int
		_ = p.db.QueryRow("SELECT COUNT(*) FROM projects WHERE slug = ?", slug).Scan(&n)
		if n == 0 {
			return slug
		}
	}
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

// workbenchRouter serves one project's workbench under /api/projects/{slug}/: the part after the
// slug maps onto the workbench's own routes (/api/projects/{slug}/findings → /api/findings,
// /api/projects/{slug}/mcp → /mcp).
func (p *Platform) workbenchRouter() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		wb, err := p.getWorkbench(r.PathValue("slug"))
		if err != nil {
			http.Error(w, "project not found", 404)
			return
		}

		rest := strings.TrimPrefix(r.URL.Path, "/api/projects/"+r.PathValue("slug")+"/")
		if rest == "mcp" {
			r.URL.Path = "/mcp"
		} else {
			r.URL.Path = "/api/" + rest
		}
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
	Edges       []FlowEdge `json:"edges"`
	// UsedIn lists the flows that slot this one in as a subflow.
	UsedIn []MapFlowRef `json:"usedIn,omitempty"`
}

// MarshalJSON always writes steps and edges as arrays, so a flow with no steps
// reads as `"steps": []` rather than a missing key or null.
func (f Flow) MarshalJSON() ([]byte, error) {
	type plain Flow
	if f.Steps == nil {
		f.Steps = []FlowStep{}
	}
	if f.Edges == nil {
		f.Edges = []FlowEdge{}
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
	// Zone is the trust zone the feature sits in: a "zone:<name>" tag on the feature, or else
	// its project's service profile trustZone.
	Zone string `json:"zone,omitempty"`
	// links are the features this one is linked to, as "<project>:<id>" (both ends' links).
	links []string
}

// FlowStep is one stop of a flow: a feature on a project, with what is true there.
type FlowStep struct {
	ID     string `json:"id"`
	FlowID string `json:"flowId"`
	// Position is the step's place in the flow's step order (it orders entry points).
	Position    int    `json:"position"`
	ProjectSlug string `json:"projectSlug"`
	FeatureID   string `json:"featureId"`
	// SubflowID makes the step a subflow: another flow slotted in as one block (ProjectSlug and
	// FeatureID are then empty). Its steps stay in that flow; the step stands for all of them.
	SubflowID string `json:"subflowId,omitempty"`
	Note      string `json:"note"`
	// Actor is who is acting at this step (anonymous, user, admin, service:billing, ...).
	Actor string `json:"actor"`
	// Controls are the checks applied here (authn, authz, validation, rate limit, ...).
	Controls         []string         `json:"controls"`
	Tombstoned       bool             `json:"tombstoned"`
	TombstonedReason string           `json:"tombstonedReason,omitempty"`
	CreatedAt        string           `json:"createdAt"`
	Feature          *FeatureSnapshot `json:"feature,omitempty"`
	Subflow          *SubflowSnapshot `json:"subflow,omitempty"`
}

// SubflowSnapshot is what a subflow step shows of the flow it stands for.
type SubflowSnapshot struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Status    string `json:"status"`
	StepCount int    `json:"stepCount"`
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

const stepCols = `id, flow_id, position, project_slug, feature_id, subflow_id, note, actor, controls, tombstoned, COALESCE(tombstoned_reason,''), created_at`

func scanStep(sc interface{ Scan(...any) error }) (FlowStep, error) {
	var s FlowStep
	var tombInt int
	var controls string
	if err := sc.Scan(&s.ID, &s.FlowID, &s.Position, &s.ProjectSlug, &s.FeatureID, &s.SubflowID, &s.Note, &s.Actor, &controls, &tombInt, &s.TombstonedReason, &s.CreatedAt); err != nil {
		return s, err
	}
	s.Tombstoned = tombInt != 0
	if json.Unmarshal([]byte(controls), &s.Controls) != nil || s.Controls == nil {
		s.Controls = []string{}
	}
	return s, nil
}

func (p *Platform) loadFlowSteps(flowID string) ([]FlowStep, error) {
	rows, err := p.db.Query(`SELECT `+stepCols+` FROM flow_steps WHERE flow_id = ? ORDER BY position, rowid`, flowID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	steps := []FlowStep{}
	for rows.Next() {
		s, err := scanStep(rows)
		if err != nil {
			return nil, err
		}
		steps = append(steps, s)
	}
	return steps, rows.Err()
}

func (p *Platform) loadFlowStep(flowID, stepID string) (*FlowStep, error) {
	s, err := scanStep(p.db.QueryRow(`SELECT `+stepCols+` FROM flow_steps WHERE id = ? AND flow_id = ?`, stepID, flowID))
	if err != nil {
		return nil, err
	}
	return &s, nil
}

// enrichStep attaches the step's feature snapshot and keeps its tombstone in step with
// whether the feature still resolves.
func (p *Platform) enrichStep(s *FlowStep) {
	if s == nil {
		return
	}
	tomb, reason := false, ""
	if s.SubflowID != "" {
		sub := SubflowSnapshot{ID: s.SubflowID}
		err := p.db.QueryRow(`SELECT name, status, (SELECT COUNT(*) FROM flow_steps WHERE flow_id = flows.id) FROM flows WHERE id = ?`, s.SubflowID).
			Scan(&sub.Name, &sub.Status, &sub.StepCount)
		if err != nil {
			tomb, reason = true, "flow_not_found"
		} else {
			s.Subflow = &sub
		}
		p.setTombstone(s, tomb, reason)
		return
	}
	snap, err := p.fetchFeatureSnapshot(s.ProjectSlug, s.FeatureID)
	if err != nil {
		tomb, reason = true, "feature_not_found"
		if _, wbErr := p.getWorkbench(s.ProjectSlug); wbErr != nil {
			reason = "project_not_registered"
		}
	} else {
		s.Feature = snap
		if snap.Confidence == "orphaned" {
			tomb, reason = true, "feature_not_found"
		}
	}
	p.setTombstone(s, tomb, reason)
}

// setTombstone records whether a step's target still resolves, writing only on a change.
func (p *Platform) setTombstone(s *FlowStep, tomb bool, reason string) {
	if tomb != s.Tombstoned || reason != s.TombstonedReason {
		s.Tombstoned, s.TombstonedReason = tomb, reason
		p.db.Exec(`UPDATE flow_steps SET tombstoned=?, tombstoned_reason=? WHERE id=?`, b2i(tomb), reason, s.ID)
	}
}

// loadFullFlow loads a flow with its steps (feature snapshots attached) and edges.
func (p *Platform) loadFullFlow(id string) (*Flow, error) {
	row := p.db.QueryRow(`SELECT id, name, description, status, owner, tags, COALESCE(folder_id,''), created_at, updated_at FROM flows WHERE id = ?`, id)
	f, err := scanFlow(row)
	if err != nil {
		return nil, err
	}
	if f.Steps, err = p.loadFlowSteps(id); err != nil {
		return nil, err
	}
	var wg sync.WaitGroup
	for i := range f.Steps {
		wg.Add(1)
		go func(s *FlowStep) { defer wg.Done(); p.enrichStep(s) }(&f.Steps[i])
	}
	wg.Wait()
	if f.Edges, err = loadFlowEdges(p.db, id); err != nil {
		return nil, err
	}
	annotateEdges(f)
	rows, err := p.db.Query(`SELECT DISTINCT f.id, f.name FROM flow_steps s JOIN flows f ON f.id = s.flow_id WHERE s.subflow_id = ? ORDER BY f.name`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var ref MapFlowRef
		if err := rows.Scan(&ref.ID, &ref.Name); err != nil {
			return nil, err
		}
		f.UsedIn = append(f.UsedIn, ref)
	}
	return f, rows.Err()
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
	// Shape is the step skeleton (no feature data) and ShapeEdges its edges as [from, to]
	// pairs in branch order: enough to draw the flow's outline.
	Shape      []FlowShapeNode `json:"shape"`
	ShapeEdges [][2]string     `json:"shapeEdges"`
}

// FlowShapeNode is one step in a FlowSummary's outline.
type FlowShapeNode struct {
	ID          string `json:"id"`
	Position    int    `json:"position"`
	ProjectSlug string `json:"projectSlug"`
	FeatureID   string `json:"featureId"`
	SubflowID   string `json:"subflowId,omitempty"`
}

// FlowsPage is the paginated response for GET /api/flows.
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
			projectConds[i] = "EXISTS (SELECT 1 FROM flow_steps fs WHERE fs.flow_id=f.id AND fs.project_slug=? AND fs.subflow_id='')"
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
		                       WHERE fs2.flow_id = f.id AND fs2.project_slug <> ''
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

// attachFlowShapes loads every listed flow's step skeleton and edges in two queries.
func (p *Platform) attachFlowShapes(items []FlowSummary) error {
	if len(items) == 0 {
		return nil
	}
	idx := make(map[string]int, len(items))
	args := make([]any, len(items))
	for i, it := range items {
		idx[it.ID] = i
		args[i] = it.ID
		items[i].Shape, items[i].ShapeEdges = []FlowShapeNode{}, [][2]string{}
	}
	in := `(` + strings.TrimSuffix(strings.Repeat("?,", len(items)), ",") + `)`
	rows, err := p.db.Query(`SELECT flow_id, id, position, project_slug, feature_id, subflow_id FROM flow_steps
		WHERE flow_id IN `+in+` ORDER BY position, rowid`, args...)
	if err != nil {
		return err
	}
	for rows.Next() {
		var flowID string
		var n FlowShapeNode
		if err := rows.Scan(&flowID, &n.ID, &n.Position, &n.ProjectSlug, &n.FeatureID, &n.SubflowID); err != nil {
			rows.Close()
			return err
		}
		if i, ok := idx[flowID]; ok {
			items[i].Shape = append(items[i].Shape, n)
		}
	}
	rows.Close()
	erows, err := p.db.Query(`SELECT flow_id, from_step_id, to_step_id FROM flow_edges WHERE flow_id IN `+in+` ORDER BY from_step_id, position, rowid`, args...)
	if err != nil {
		return err
	}
	defer erows.Close()
	for erows.Next() {
		var flowID, from, to string
		if err := erows.Scan(&flowID, &from, &to); err != nil {
			return err
		}
		if i, ok := idx[flowID]; ok {
			items[i].ShapeEdges = append(items[i].ShapeEdges, [2]string{from, to})
		}
	}
	return erows.Err()
}

// FacetItem is a single facet value with its count.
type FacetItem struct {
	Value string `json:"value"`
	Count int    `json:"count"`
}

// FacetsResponse is the response for GET /api/flows/facets.
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
			JOIN flow_steps fs ON fs.flow_id = f.id AND fs.project_slug <> ''
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
		// Optionally the whole graph at once (the export shape): created atomically.
		graphInput
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid JSON", 400)
		return
	}
	if ok, err := p.folderExists(req.FolderID); err != nil || !ok {
		http.Error(w, "folder not found", 400)
		return
	}
	if err := req.graphInput.normalize(); err != nil {
		http.Error(w, err.Error(), 400)
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
	p.flowMu.Lock()
	err := func() error {
		defer p.flowMu.Unlock()
		tx, err := p.db.Begin()
		if err != nil {
			return err
		}
		defer tx.Rollback()
		if _, err := tx.Exec(
			`INSERT INTO flows (id, name, description, status, owner, tags, folder_id) VALUES (?, ?, ?, ?, ?, ?, NULLIF(?, ''))`,
			id, req.Name, req.Description, req.Status, req.Owner, string(tagsJSON), req.FolderID,
		); err != nil {
			return err
		}
		if _, err := writeGraph(tx, id, req.graphInput); err != nil {
			return err
		}
		return tx.Commit()
	}()
	if err != nil {
		writeEditError(w, err)
		return
	}
	f, err := p.loadFullFlow(id)
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	w.WriteHeader(201)
	writeJSON(w, f)
}

func (p *Platform) getFlow(w http.ResponseWriter, r *http.Request) {
	f, err := p.loadFullFlow(r.PathValue("id"))
	if err == sql.ErrNoRows {
		http.Error(w, "not found", 404)
		return
	}
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
	// edges (this is a metadata update; they are unchanged, not emptied).
	_ = p.db.QueryRow(`SELECT updated_at FROM flows WHERE id = ?`, id).Scan(&cur.UpdatedAt)
	if cur.Steps, err = p.loadFlowSteps(id); err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	if cur.Edges, err = loadFlowEdges(p.db, id); err != nil {
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
		Tags            []string        `json:"tags"`
		LinkedFeatures  []struct {
			ID string `json:"id"`
		} `json:"linkedFeatures"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &feat); err != nil {
		return nil, err
	}
	var projName string
	p.db.QueryRow("SELECT name FROM projects WHERE slug=?", projectSlug).Scan(&projName)
	snap := &FeatureSnapshot{
		Title: feat.Title, Kind: feat.Kind,
		Operation: feat.Operation, Protocol: feat.Protocol,
		ProjectName:     projName,
		Confidence:      feat.Confidence,
		EffectiveAnchor: feat.EffectiveAnchor,
		Zone:            featureZone(feat.Tags, p.projectZone(wb)),
	}
	for _, l := range feat.LinkedFeatures {
		snap.links = append(snap.links, qualifiedRef(projectSlug, l.ID))
	}
	return snap, nil
}

// qualifiedRef writes a feature id as "<project>:<id>": a project's own links name its
// features by id alone, links to another project's features carry that project already.
func qualifiedRef(slug, id string) string {
	if strings.Contains(id, ":") {
		return id
	}
	return slug + ":" + id
}

// projectZone is the trust zone recorded in a project's service profile ("" when unset).
func (p *Platform) projectZone(wb *workbench.Workbench) string {
	prof, err := wb.DB.GetServiceProfile()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(prof.TrustZone)
}

// featureZone is a feature's trust zone: its "zone:<name>" tag, or else the project's.
func featureZone(tags []string, projectZone string) string {
	for _, t := range tags {
		if name, ok := strings.CutPrefix(t, "zone:"); ok && strings.TrimSpace(name) != "" {
			return strings.TrimSpace(name)
		}
	}
	return projectZone
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

// registerPlatformRoutes wires every project and cross-project REST route onto mux. The server
// and the MCP in-process proxy (Handler) share it so the two can never drift apart.
func (p *Platform) registerPlatformRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/projects", p.listProjects)
	mux.HandleFunc("POST /api/projects", p.createProject)
	mux.HandleFunc("GET /api/projects/{slug}", p.getProject)
	mux.HandleFunc("PATCH /api/projects/{slug}", p.updateProject)
	mux.HandleFunc("DELETE /api/projects/{slug}", p.deleteProject)
	mux.HandleFunc("GET /api/baselines", p.listAllBaselines)
	mux.HandleFunc("GET /api/settings", p.getSettings)
	mux.HandleFunc("PUT /api/settings", p.putSettings)
	mux.HandleFunc("GET /api/flows/facets", p.listFlowFacets)
	mux.HandleFunc("GET /api/flows", p.listFlows)
	mux.HandleFunc("POST /api/flows", p.createFlow)
	mux.HandleFunc("GET /api/flows/{id}", p.getFlow)
	mux.HandleFunc("PATCH /api/flows/{id}", p.updateFlow)
	mux.HandleFunc("DELETE /api/flows/{id}", p.deleteFlow)
	mux.HandleFunc("POST /api/flows/{id}/steps", p.addFlowStep)
	mux.HandleFunc("PATCH /api/flows/{id}/steps/{stepId}", p.updateFlowStep)
	mux.HandleFunc("DELETE /api/flows/{id}/steps/{stepId}", p.removeFlowStep)
	mux.HandleFunc("PUT /api/flows/{id}/steps", p.setFlowSteps)
	mux.HandleFunc("POST /api/flows/{id}/steps/{stepId}/move", p.moveFlowStep)
	mux.HandleFunc("GET /api/flows/{id}/steps/{stepId}/suggestions", p.suggestFlowSteps)
	mux.HandleFunc("PUT /api/flows/{id}/edges/{fromId}/{toId}", p.setFlowEdge)
	mux.HandleFunc("DELETE /api/flows/{id}/edges/{fromId}/{toId}", p.deleteFlowEdge)
	mux.HandleFunc("GET /api/flows/{id}/export", p.exportFlow)
	mux.HandleFunc("GET /api/service-map", p.serviceMap)
	mux.HandleFunc("GET /api/flows/{id}/baselines", p.listFlowBaselines)
	mux.HandleFunc("GET /api/flows/{id}/baselines/latest", p.latestFlowBaseline)
	mux.HandleFunc("GET /api/flows/{id}/baselines/{bId}", p.getFlowBaseline)
	mux.HandleFunc("POST /api/flows/{id}/baselines", p.createFlowBaseline)
	mux.HandleFunc("DELETE /api/flows/{id}/baselines/{bId}", p.deleteFlowBaseline)
	mux.HandleFunc("GET /api/flows/{id}/delta", p.getFlowDelta)
	mux.HandleFunc("GET /api/flows/{id}/findings", p.listFlowFindings)
	mux.HandleFunc("GET /api/features/search", p.searchFeatures)
	mux.HandleFunc("GET /api/features", p.batchFeatures)
	mux.HandleFunc("GET /api/flow-views", p.listFlowViews)
	mux.HandleFunc("POST /api/flow-views", p.createFlowView)
	mux.HandleFunc("PATCH /api/flow-views/{id}", p.updateFlowView)
	mux.HandleFunc("DELETE /api/flow-views/{id}", p.deleteFlowView)
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
