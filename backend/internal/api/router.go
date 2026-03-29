package api

import (
	"net/http"

	"bench/internal/db"
	"bench/internal/events"
	"bench/internal/git"
	"bench/internal/reconcile"
)

func NewRouter(repo *git.Repo, database *db.DB, broker *events.Broker) http.Handler {
	mux := http.NewServeMux()

	// Create reconciler (shared across handlers)
	reconciler := reconcile.NewReconciler(repo, database, database, database, reconcile.WithResolver(database))

	gh := &gitHandlers{repo: repo}
	mux.HandleFunc("GET /api/git/info", gh.info)
	mux.HandleFunc("GET /api/git/commits", gh.listCommits)
	mux.HandleFunc("GET /api/git/tree/{commitish}", gh.listTree)
	mux.HandleFunc("GET /api/git/show/{commitish}/{path...}", gh.showFile)
	mux.HandleFunc("GET /api/git/diff", gh.diff)
	mux.HandleFunc("GET /api/git/diff-files", gh.diffFiles)
	mux.HandleFunc("GET /api/git/branches", gh.listBranches)
	mux.HandleFunc("GET /api/git/graph", gh.graph)
	mux.HandleFunc("GET /api/git/search", gh.search)

	fh := &findingsHandlers{db: database, repo: repo, reconciler: reconciler, broker: broker}
	mux.HandleFunc("GET /api/findings", fh.list)
	mux.HandleFunc("GET /api/findings/{id}", fh.get)
	mux.HandleFunc("POST /api/findings", fh.create)
	mux.HandleFunc("PATCH /api/findings/{id}", fh.update)
	mux.HandleFunc("DELETE /api/findings/{id}", fh.delete)

	ch := &commentsHandlers{db: database, repo: repo, reconciler: reconciler, broker: broker}
	mux.HandleFunc("GET /api/comments", ch.list)
	mux.HandleFunc("GET /api/comments/{id}", ch.get)
	mux.HandleFunc("POST /api/comments", ch.create)
	mux.HandleFunc("PATCH /api/comments/{id}", ch.update)
	mux.HandleFunc("DELETE /api/comments/{id}", ch.delete)

	featureh := &featuresHandlers{db: database, repo: repo, reconciler: reconciler, broker: broker}
	mux.HandleFunc("GET /api/features", featureh.list)
	mux.HandleFunc("GET /api/features/{id}", featureh.get)
	mux.HandleFunc("POST /api/features", featureh.create)
	mux.HandleFunc("PATCH /api/features/{id}", featureh.update)
	mux.HandleFunc("DELETE /api/features/{id}", featureh.delete)

	rc := &reconcileHandlers{reconciler: reconciler, db: database}
	mux.HandleFunc("POST /api/reconcile", rc.start)
	mux.HandleFunc("GET /api/reconcile/head", rc.head)
	mux.HandleFunc("GET /api/reconcile/status", rc.status)
	mux.HandleFunc("GET /api/annotations/{type}/{id}/history", rc.history)

	bh := &baselineHandlers{db: database, repo: repo, broker: broker}
	mux.HandleFunc("GET /api/baselines", bh.list)
	mux.HandleFunc("GET /api/baselines/latest", bh.latest)
	mux.HandleFunc("GET /api/baselines/delta", bh.delta)
	mux.HandleFunc("GET /api/baselines/{id}/delta", bh.deltaFor)
	mux.HandleFunc("POST /api/baselines", bh.create)
	mux.HandleFunc("PATCH /api/baselines/{id}", bh.update)
	mux.HandleFunc("DELETE /api/baselines/{id}", bh.delete)

	ah := &analyticsHandlers{db: database, repo: repo, reconciler: reconciler}
	mux.HandleFunc("GET /api/summary", ah.summary)
	mux.HandleFunc("GET /api/findings/search", ah.searchFindings)
	mux.HandleFunc("GET /api/coverage", ah.coverage)
	mux.HandleFunc("POST /api/coverage/mark", ah.markReviewed)

	sh := &settingsHandlers{db: database}
	mux.HandleFunc("GET /api/settings", sh.get)
	mux.HandleFunc("PUT /api/settings", sh.put)

	eh := &eventsHandler{broker: broker}
	mux.HandleFunc("GET /api/events", eh.stream)

	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	})

	return mux
}
