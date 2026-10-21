package workbench

import (
	"database/sql"
	"fmt"
	"net/http"

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
type BranchActivity = model.BranchActivity

// Workbench is a single-project code review instance.
type Workbench struct {
	DB         *db.DB
	Repo       *git.Repo
	Reconciler *reconcile.Reconciler
	Broker     *events.Broker
	mcp        http.Handler
	api        http.Handler
}

// Option customises workbench behaviour.
type Option func(*options)

type options struct {
	requireProfile bool
	crossLinks     model.CrossLinks
}

// WithRequireProfile controls the service-profile write gate (default true):
// review-judgment writes (findings, comments, features, refs, baselines,
// coverage) are rejected across REST and MCP until the service profile has
// been configured.
func WithRequireProfile(v bool) Option {
	return func(o *options) { o.requireProfile = v }
}

// WithCrossLinks lets the project's features and findings link to other projects' features
// ("<project>:<id>" references): the server's store of links that span projects. Without it
// such references are refused.
func WithCrossLinks(c model.CrossLinks) Option {
	return func(o *options) { o.crossLinks = c }
}

// Open creates a standalone workbench with its own SQLite file.
// The project ID is derived from the repo directory name, so two containers
// pointing at different repos can safely share the same database file.
func Open(repoPath, dbPath string, opts ...Option) (*Workbench, error) {
	repo := git.NewRepo(repoPath)
	database, err := db.Open(dbPath, repo.Name())
	if err != nil {
		return nil, err
	}
	return newWorkbench(repo, database, opts...), nil
}

// OpenScoped creates a workbench using a shared database connection,
// scoped to the given project ID. Used by the platform.
func OpenScoped(repoPath string, conn *sql.DB, projectID string, opts ...Option) *Workbench {
	repo := git.NewRepo(repoPath)
	database := db.OpenScoped(conn, projectID)
	return newWorkbench(repo, database, opts...)
}

func newWorkbench(repo *git.Repo, database *db.DB, opts ...Option) *Workbench {
	o := options{requireProfile: true}
	for _, opt := range opts {
		opt(&o)
	}
	if o.crossLinks != nil {
		database.SetCrossLinks(o.crossLinks)
	}
	// Annotations anchored to "HEAD" or a branch are stored at the commit it names now.
	database.SetCommitResolver(func(ref string) (string, bool) {
		sha, err := repo.ResolveRef(ref)
		return sha, err == nil && sha != ""
	})
	reconciler := reconcile.NewReconciler(repo, database, database, database, reconcile.WithResolver(database))
	broker := events.NewBroker()
	return &Workbench{
		DB:         database,
		Repo:       repo,
		Reconciler: reconciler,
		Broker:     broker,
		mcp:        mcp.NewHandler(database, repo, reconciler, broker, mcp.WithRequireProfile(o.requireProfile)),
		api:        api.NewRouter(repo, database, broker, api.WithRequireProfile(o.requireProfile)),
	}
}

// Handler returns the combined API + MCP handler.
// Does NOT include middleware (CORS, logging, auth) - the caller adds those.
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

	features, _, err := w.DB.ListFeatures("", "", 0, 0)
	if err != nil {
		return model.ProjectStats{}, err
	}
	stats.ByKind = make(map[string]int)
	for _, f := range features {
		stats.FeaturesTotal++
		if f.Status == "draft" || f.Status == "active" {
			stats.FeaturesActive++
		}
		stats.ByKind[f.Kind]++
	}

	return stats, nil
}

// ListBaselines returns all baselines, newest first.
func (w *Workbench) ListBaselines(limit int) ([]model.Baseline, error) {
	return w.DB.ListBaselines(limit)
}

// CreateInitialBaseline creates an empty baseline at the default branch tip.
// Used by the platform to bootstrap new projects so they start with a baseline.
// It does nothing if the project already has a baseline: a project removed and
// registered again keeps its database, and a second "Initial baseline" with
// zero counts would misrepresent the review state it already holds.
func (w *Workbench) CreateInitialBaseline() error {
	if existing, err := w.DB.ListBaselines(1); err == nil && len(existing) > 0 {
		return nil
	}
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

// WithMiddleware wraps a handler with CORS and logging middleware.
// Convenience re-export for the server.
func WithMiddleware(h http.Handler) http.Handler {
	return api.WithMiddleware(h)
}
