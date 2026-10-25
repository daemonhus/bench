package api

import (
	"errors"
	"fmt"
	"log"
	"net/http"
	"strings"

	"bench/internal/db"
	"bench/internal/git"
	"bench/internal/model"
	"bench/internal/reconcile"
)

type reconcileHandlers struct {
	reconciler *reconcile.Reconciler
	repo       *git.Repo // for validating the target commit exists in this project
	db         *db.DB    // for annotation history lookups
}

// POST /api/reconcile → 202 with job ID; targetCommit defaults to the review branch's head
func (h *reconcileHandlers) start(w http.ResponseWriter, r *http.Request) {
	var req struct {
		TargetCommit string   `json:"targetCommit"`
		FilePaths    []string `json:"filePaths,omitempty"`
	}
	if !decodeBody(w, r, &req) {
		return
	}
	if req.TargetCommit == "" {
		// The review branch's head, as the UI reconciles to.
		b, err := reviewBranch(h.db, h.repo, r)
		if err != nil {
			writeInternalError(w, err)
			return
		}
		req.TargetCommit = b.Tip
	}

	// Validate the target commit actually exists in this project's repo before
	// starting a job. Without this, an unknown or foreign commit (e.g. a SHA
	// pasted from a different project) silently orphans every annotation in the
	// project instead of failing loudly. Resolving also canonicalises refs like
	// "HEAD" to a full SHA so reconciled positions are pinned to a stable commit.
	resolved, err := h.repo.ResolveRef(req.TargetCommit)
	if err != nil {
		if errors.Is(err, git.ErrUnknownRef) {
			writeError(w, http.StatusBadRequest, fmt.Sprintf("targetCommit %q was not found in this project's repository", req.TargetCommit))
			return
		}
		writeInternalError(w, err)
		return
	}

	jobID := h.reconciler.StartJob(resolved, req.FilePaths)
	s := h.reconciler.GetJob(jobID)
	log.Printf("[reconcile] started job %s target=%s files=%v status=%s", jobID, resolved, req.FilePaths, s.Status)
	writeJSON(w, http.StatusAccepted, s)
}

// GET /api/reconcile/head → how far annotations are reconciled towards the review branch's head
func (h *reconcileHandlers) head(w http.ResponseWriter, r *http.Request) {
	b, err := reviewBranch(h.db, h.repo, r)
	if err != nil {
		writeInternalError(w, err)
		return
	}
	head, err := h.reconciler.GetReconciledHeadAt(b.Tip)
	if err != nil {
		writeInternalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, head)
}

// GET /api/reconcile/status?jobId= or ?fileId=&commit=
func (h *reconcileHandlers) status(w http.ResponseWriter, r *http.Request) {
	jobID := r.URL.Query().Get("jobId")
	if jobID != "" {
		s := h.reconciler.GetJob(jobID)
		if s == nil {
			log.Printf("[reconcile] status: job %s not found", jobID)
			writeError(w, http.StatusNotFound, "job not found")
			return
		}
		log.Printf("[reconcile] status: job %s → %s", jobID, s.Status)
		writeJSON(w, http.StatusOK, s)
		return
	}

	fileID := r.URL.Query().Get("fileId")
	commit := r.URL.Query().Get("commit")
	if fileID != "" && commit != "" {
		status, err := h.reconciler.GetFileStatus(fileID, commit)
		if err != nil {
			writeInternalError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, status)
		return
	}

	writeError(w, http.StatusBadRequest, "provide jobId or fileId+commit")
}

// GET /api/annotations/{type}/{id}/history → position history
func (h *reconcileHandlers) history(w http.ResponseWriter, r *http.Request) {
	annType := r.PathValue("type")
	annID := r.PathValue("id")
	if annType != "finding" && annType != "comment" && annType != "feature" {
		writeError(w, http.StatusBadRequest, "type must be 'finding', 'comment', or 'feature'")
		return
	}
	if annID == "" {
		writeError(w, http.StatusBadRequest, "id is required")
		return
	}

	positions, err := h.db.GetPositions(annID, annType)
	if err != nil {
		writeInternalError(w, err)
		return
	}
	if positions == nil {
		positions = []model.AnnotationPosition{}
		// No history: distinguish "never moved" from "no such annotation" (a
		// typo'd ID otherwise looks like a valid, empty history).
		var getErr error
		switch annType {
		case "finding":
			_, getErr = h.db.GetFinding(annID)
		case "comment":
			_, getErr = h.db.GetComment(annID)
		case "feature":
			_, getErr = h.db.GetFeature(annID)
		}
		if getErr != nil && strings.Contains(getErr.Error(), "not found") {
			writeError(w, http.StatusNotFound, annType+" not found: "+annID)
			return
		}
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"id":        annID,
		"type":      annType,
		"positions": positions,
	})
}
