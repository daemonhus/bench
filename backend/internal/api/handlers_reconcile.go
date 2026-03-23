package api

import (
	"log"
	"net/http"

	"bench/internal/db"
	"bench/internal/model"
	"bench/internal/reconcile"
)

type reconcileHandlers struct {
	reconciler *reconcile.Reconciler
	db         *db.DB // for annotation history lookups
}

// POST /api/reconcile → 202 with job ID
func (h *reconcileHandlers) start(w http.ResponseWriter, r *http.Request) {
	var req struct {
		TargetCommit string   `json:"targetCommit"`
		FilePaths    []string `json:"filePaths,omitempty"`
	}
	if !decodeBody(w, r, &req) {
		return
	}
	if req.TargetCommit == "" {
		writeError(w, http.StatusBadRequest, "targetCommit is required")
		return
	}

	jobID := h.reconciler.StartJob(req.TargetCommit, req.FilePaths)
	s := h.reconciler.GetJob(jobID)
	log.Printf("[reconcile] started job %s target=%s files=%v status=%s", jobID, req.TargetCommit, req.FilePaths, s.Status)
	writeJSON(w, http.StatusAccepted, s)
}

// GET /api/reconcile/head → reconciled HEAD
func (h *reconcileHandlers) head(w http.ResponseWriter, r *http.Request) {
	head, err := h.reconciler.GetReconciledHead()
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
	if annType != "finding" && annType != "comment" {
		writeError(w, http.StatusBadRequest, "type must be 'finding' or 'comment'")
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
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"id":        annID,
		"type":      annType,
		"positions": positions,
	})
}
