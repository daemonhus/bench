package api

import (
	"fmt"
	"net/http"
	"strings"

	"bench/internal/db"
	"bench/internal/git"
	"bench/internal/reconcile"
	"bench/internal/review"
)

type analyticsHandlers struct {
	db         *db.DB
	repo       *git.Repo
	reconciler *reconcile.Reconciler
}

// GET /api/summary?commit= - counts on the commit's history (all_branches=true for every branch)
func (h *analyticsHandlers) summary(w http.ResponseWriter, r *http.Request) {
	commit := r.URL.Query().Get("commit")
	if commit == "" {
		b, err := reviewBranch(h.db, h.repo, r)
		if err != nil {
			writeInternalError(w, err)
			return
		}
		commit = b.Tip
	}

	// What's on the commit's history, unless all_branches=true.
	var scope *review.Scope
	if r.URL.Query().Get("all_branches") != "true" {
		scope = review.NewScope(h.repo, commit)
	}
	findings, _, err := h.db.ListFindings("", 0, 0)
	if err != nil {
		writeInternalError(w, err)
		return
	}
	comments, _, err := h.db.ListComments("", "", 0, 0)
	if err != nil {
		writeInternalError(w, err)
		return
	}
	counts := review.Summarise(scope, findings, comments)

	reconHead, err := h.reconciler.GetReconciledHeadAt(commit)
	if err != nil {
		writeInternalError(w, err)
		return
	}

	type sevGroup struct {
		Counts map[string]int `json:"counts"`
		Total  int            `json:"total"`
	}
	bySeverity := make(map[string]*sevGroup)
	for sev, byStatus := range counts.BySeverity {
		g := &sevGroup{Counts: byStatus}
		for _, n := range byStatus {
			g.Total += n
		}
		bySeverity[sev] = g
	}

	// Embed the service profile so agents entering via the summary absorb
	// the service context without an extra call. Null when unconfigured.
	profile, err := serviceProfileIfConfigured(h.db)
	if err != nil {
		writeInternalError(w, err)
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"commit":             commit,
		"totalFindings":      counts.Findings,
		"bySeverity":         bySeverity,
		"unresolvedComments": counts.UnresolvedComments,
		"reconciliation":     reconHead,
		"serviceProfile":     profile,
	})
}

// GET /api/findings/search?query=&status=&severity=
func (h *analyticsHandlers) searchFindings(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query().Get("query")
	if query == "" {
		writeError(w, http.StatusBadRequest, "query parameter is required")
		return
	}
	status := r.URL.Query().Get("status")
	severity := r.URL.Query().Get("severity")

	findings, err := h.db.SearchFindings(query, status, severity, 50)
	if err != nil {
		writeInternalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, findings)
}

// POST /api/coverage/mark {path, commit, reviewer?, note?}
func (h *analyticsHandlers) markReviewed(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Path     string `json:"path"`
		Commit   string `json:"commit"`
		Reviewer string `json:"reviewer"`
		Note     string `json:"note"`
	}
	if !decodeBody(w, r, &req) {
		return
	}
	if req.Path == "" || req.Commit == "" {
		writeError(w, http.StatusBadRequest, "path and commit are required")
		return
	}
	if req.Reviewer == "" {
		req.Reviewer = "cli"
	}

	if err := h.db.MarkReviewed(req.Path, req.Commit, req.Reviewer, req.Note); err != nil {
		writeInternalError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// GET /api/coverage?commit=&path=&only_unreviewed=true
func (h *analyticsHandlers) coverage(w http.ResponseWriter, r *http.Request) {
	commit := r.URL.Query().Get("commit")
	if commit == "" {
		b, err := reviewBranch(h.db, h.repo, r)
		if err != nil {
			writeInternalError(w, err)
			return
		}
		commit = b.Tip
	}
	pathPrefix := r.URL.Query().Get("path")
	onlyUnreviewed := r.URL.Query().Get("only_unreviewed") == "true"

	entries, err := h.repo.Tree(commit)
	if err != nil {
		writeInternalError(w, err)
		return
	}

	// All entries, not just those under pathPrefix: a mark on a directory
	// above pathPrefix still covers the files below it.
	progress, err := h.db.GetReviewProgress("")
	if err != nil {
		writeInternalError(w, err)
		return
	}
	reviews := db.NewReviewLookup(progress)

	type fileEntry struct {
		Path       string `json:"path"`
		Status     string `json:"status"`
		ReviewedAt string `json:"reviewedAt,omitempty"`
		Reviewer   string `json:"reviewer,omitempty"`
	}
	var files []fileEntry
	reviewed, unreviewed, stale := 0, 0, 0

	for _, e := range entries {
		if pathPrefix != "" && !strings.HasPrefix(e.Path, pathPrefix) {
			continue
		}
		rp, ok := reviews.For(e.Path)
		if !ok {
			unreviewed++
			files = append(files, fileEntry{Path: e.Path, Status: "unreviewed"})
			continue
		}
		changed, err := h.repo.DiffFiles(rp.CommitID, commit)
		if err != nil {
			if onlyUnreviewed {
				reviewed++
				continue
			}
			reviewed++
			files = append(files, fileEntry{
				Path: e.Path, Status: "reviewed",
				ReviewedAt: rp.ReviewedAt, Reviewer: rp.Reviewer,
			})
			continue
		}
		isStale := false
		for _, f := range changed {
			if f == e.Path {
				isStale = true
				break
			}
		}
		if isStale {
			stale++
			files = append(files, fileEntry{
				Path: e.Path, Status: "stale",
				ReviewedAt: rp.ReviewedAt, Reviewer: rp.Reviewer,
			})
		} else {
			if onlyUnreviewed {
				reviewed++
				continue
			}
			reviewed++
			files = append(files, fileEntry{
				Path: e.Path, Status: "reviewed",
				ReviewedAt: rp.ReviewedAt, Reviewer: rp.Reviewer,
			})
		}
	}

	totalFiles := reviewed + unreviewed + stale
	coveragePct := 0.0
	if totalFiles > 0 {
		coveragePct = float64(reviewed) / float64(totalFiles) * 100
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"totalFiles":  totalFiles,
		"reviewed":    reviewed,
		"unreviewed":  unreviewed,
		"stale":       stale,
		"coveragePct": fmt.Sprintf("%.1f", coveragePct),
		"files":       files,
	})
}
