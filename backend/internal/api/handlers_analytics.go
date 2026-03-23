package api

import (
	"fmt"
	"net/http"
	"strings"

	"bench/internal/db"
	"bench/internal/git"
	"bench/internal/reconcile"
)

type analyticsHandlers struct {
	db         *db.DB
	repo       *git.Repo
	reconciler *reconcile.Reconciler
}

// GET /api/summary?commit=
func (h *analyticsHandlers) summary(w http.ResponseWriter, r *http.Request) {
	commit := r.URL.Query().Get("commit")
	if commit == "" {
		head, err := h.repo.Head()
		if err != nil {
			writeInternalError(w, fmt.Errorf("resolve HEAD: %w", err))
			return
		}
		commit = head
	}

	summary, err := h.db.FindingSummary()
	if err != nil {
		writeInternalError(w, err)
		return
	}

	unresolvedComments, err := h.db.UnresolvedCommentCount()
	if err != nil {
		writeInternalError(w, err)
		return
	}

	reconHead, err := h.reconciler.GetReconciledHead()
	if err != nil {
		writeInternalError(w, err)
		return
	}

	// Build severity breakdown.
	type sevGroup struct {
		Counts map[string]int `json:"counts"`
		Total  int            `json:"total"`
	}
	bySeverity := make(map[string]*sevGroup)
	totalFindings := 0
	for _, row := range summary {
		g, ok := bySeverity[row.Severity]
		if !ok {
			g = &sevGroup{Counts: make(map[string]int)}
			bySeverity[row.Severity] = g
		}
		g.Counts[row.Status] = row.Count
		g.Total += row.Count
		totalFindings += row.Count
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"commit":             commit,
		"totalFindings":      totalFindings,
		"bySeverity":         bySeverity,
		"unresolvedComments": unresolvedComments,
		"reconciliation":     reconHead,
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
		head, err := h.repo.Head()
		if err != nil {
			writeInternalError(w, fmt.Errorf("resolve HEAD: %w", err))
			return
		}
		commit = head
	}
	pathPrefix := r.URL.Query().Get("path")
	onlyUnreviewed := r.URL.Query().Get("only_unreviewed") == "true"

	entries, err := h.repo.Tree(commit)
	if err != nil {
		writeInternalError(w, err)
		return
	}

	progress, err := h.db.GetReviewProgress(pathPrefix)
	if err != nil {
		writeInternalError(w, err)
		return
	}
	progressMap := make(map[string]*struct {
		commitID   string
		reviewer   string
		note       string
		reviewedAt string
	})
	for _, rp := range progress {
		progressMap[rp.FileID] = &struct {
			commitID   string
			reviewer   string
			note       string
			reviewedAt string
		}{rp.CommitID, rp.Reviewer, rp.Note, rp.ReviewedAt}
	}

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
		rp, ok := progressMap[e.Path]
		if !ok {
			unreviewed++
			files = append(files, fileEntry{Path: e.Path, Status: "unreviewed"})
			continue
		}
		changed, err := h.repo.DiffFiles(rp.commitID, commit)
		if err != nil {
			if onlyUnreviewed {
				reviewed++
				continue
			}
			reviewed++
			files = append(files, fileEntry{
				Path: e.Path, Status: "reviewed",
				ReviewedAt: rp.reviewedAt, Reviewer: rp.reviewer,
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
				ReviewedAt: rp.reviewedAt, Reviewer: rp.reviewer,
			})
		} else {
			if onlyUnreviewed {
				reviewed++
				continue
			}
			reviewed++
			files = append(files, fileEntry{
				Path: e.Path, Status: "reviewed",
				ReviewedAt: rp.reviewedAt, Reviewer: rp.reviewer,
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
