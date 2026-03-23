package workbench

import (
	"database/sql"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"strings"

	"bench/internal/api"
	"bench/internal/db"
	"bench/internal/events"
	"bench/internal/git"
	"bench/internal/mcp"
	"bench/internal/model"
	"bench/internal/reconcile"

	"github.com/google/uuid"
)

// Re-exported types so external packages (platform) can use them.
type ProjectStats = model.ProjectStats
type Baseline = model.Baseline
type BaselineDelta = model.BaselineDelta
type FileStat = model.FileStat

// Workbench is a single-project code review instance.
type Workbench struct {
	DB         *db.DB
	Repo       *git.Repo
	Reconciler *reconcile.Reconciler
	Broker     *events.Broker
	mcp        http.Handler
	api        http.Handler
}

// Open creates a standalone workbench with its own SQLite file.
func Open(repoPath, dbPath string) (*Workbench, error) {
	repo := git.NewRepo(repoPath)
	database, err := db.Open(dbPath)
	if err != nil {
		return nil, err
	}
	return newWorkbench(repo, database), nil
}

// OpenScoped creates a workbench using a shared database connection,
// scoped to the given project ID. Used by the platform.
func OpenScoped(repoPath string, conn *sql.DB, projectID string) *Workbench {
	repo := git.NewRepo(repoPath)
	database := db.OpenScoped(conn, projectID)
	return newWorkbench(repo, database)
}

func newWorkbench(repo *git.Repo, database *db.DB) *Workbench {
	reconciler := reconcile.NewReconciler(repo, database, database, database, reconcile.WithResolver(database))
	broker := events.NewBroker()
	return &Workbench{
		DB:         database,
		Repo:       repo,
		Reconciler: reconciler,
		Broker:     broker,
		mcp:        mcp.NewHandler(database, repo, reconciler, broker),
		api:        api.NewRouter(repo, database, broker),
	}
}

// Handler returns the combined API + MCP handler.
// Does NOT include middleware (CORS, logging, auth) — the caller adds those.
// Routes are relative: /api/git/commits, /api/findings, /mcp, etc.
func (w *Workbench) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.Handle("/api/", w.api)
	mux.Handle("/mcp", w.mcp)
	return mux
}

// APIHandler returns just the REST API handler (no MCP).
func (w *Workbench) APIHandler() http.Handler {
	return w.api
}

// MCPHandler returns just the MCP handler.
func (w *Workbench) MCPHandler() http.Handler {
	return w.mcp
}

// Stats queries the project DB for aggregate metrics.
func (w *Workbench) Stats() (model.ProjectStats, error) {
	summary, err := w.DB.FindingSummary()
	if err != nil {
		return model.ProjectStats{}, err
	}
	openComments, err := w.DB.UnresolvedCommentCount()
	if err != nil {
		return model.ProjectStats{}, err
	}

	stats := model.ProjectStats{
		BySeverity:     make(map[string]int),
		BySeverityOpen: make(map[string]int),
		ByStatus:       make(map[string]int),
		ByCategory:     make(map[string]int),
	}
	for _, row := range summary {
		stats.FindingsTotal += row.Count
		stats.BySeverity[row.Severity] += row.Count
		stats.ByStatus[row.Status] += row.Count
		if row.Status == "draft" || row.Status == "open" || row.Status == "in-progress" {
			stats.FindingsOpen += row.Count
			stats.BySeverityOpen[row.Severity] += row.Count
		}
	}

	cats, err := w.DB.FindingCategorySummary()
	if err != nil {
		return model.ProjectStats{}, err
	}
	stats.ByCategory = cats

	comments, _, err := w.DB.ListComments("", "", 0, 0)
	if err != nil {
		return model.ProjectStats{}, err
	}
	stats.CommentsTotal = len(comments)
	stats.CommentsOpen = openComments

	return stats, nil
}

// ListBaselines returns all baselines, newest first.
func (w *Workbench) ListBaselines(limit int) ([]model.Baseline, error) {
	return w.DB.ListBaselines(limit)
}

// CreateInitialBaseline creates an empty baseline at the default branch tip.
// Used by the platform to bootstrap new projects so they start with a baseline.
func (w *Workbench) CreateInitialBaseline() error {
	head, err := w.Repo.BranchTip(w.Repo.DefaultBranch())
	if err != nil {
		head, err = w.Repo.Head()
		if err != nil {
			return fmt.Errorf("resolve HEAD: %w", err)
		}
	}

	b := &model.Baseline{
		ID:         uuid.New().String(),
		CommitID:   head,
		Reviewer:   "system",
		Summary:    "Initial baseline",
		BySeverity: map[string]int{},
		ByStatus:   map[string]int{},
		ByCategory: map[string]int{},
		FindingIDs: []string{},
	}
	return w.DB.CreateBaseline(b)
}

// Close releases the database connection (if standalone) and stops background work.
func (w *Workbench) Close() error {
	return w.DB.Close()
}

// RunMigrations runs all bench schema migrations on an existing connection.
// The platform calls this once at startup for the shared database.
func RunMigrations(conn *sql.DB) error {
	return db.RunMigrations(conn)
}

// SPAHandler serves the embedded dist/ directory with SPA fallback to index.html.
func SPAHandler() http.Handler {
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

// WithMiddleware wraps a handler with CORS and logging middleware.
// Convenience re-export for standalone mode.
func WithMiddleware(h http.Handler) http.Handler {
	return api.WithMiddleware(h)
}
