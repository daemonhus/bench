package api

import (
	"net/http"
	"strconv"
	"strings"
	"time"

	"bench/internal/db"
	"bench/internal/events"
	"bench/internal/git"
	"bench/internal/model"
	"bench/internal/reconcile"
)

type findingsHandlers struct {
	db         *db.DB
	repo       *git.Repo
	reconciler *reconcile.Reconciler
	broker     *events.Broker
}

func (h *findingsHandlers) list(w http.ResponseWriter, r *http.Request) {
	fileID := r.URL.Query().Get("fileId")
	commit := r.URL.Query().Get("commit")
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	offset, _ := strconv.Atoi(r.URL.Query().Get("offset"))
	if limit < 0 {
		limit = 0
	}
	if offset < 0 {
		offset = 0
	}

	findings, total, err := h.db.ListFindings(fileID, limit, offset)
	if err != nil {
		writeInternalError(w, err)
		return
	}

	// Enrich with comment counts
	if len(findings) > 0 {
		ids := make([]string, len(findings))
		for i := range findings {
			ids[i] = findings[i].ID
		}
		if counts, err := h.db.CommentCountsByFinding(ids); err == nil {
			for i := range findings {
				findings[i].CommentCount = counts[findings[i].ID]
			}
		}
	}

	// When commit param present, enrich with effective positions
	if commit != "" && h.reconciler != nil {
		positions, err := h.reconciler.GetEffectivePositions(fileID, commit)
		if err == nil {
			enriched := make([]model.FindingWithPosition, 0, len(findings))
			for _, f := range findings {
				fp := model.FindingWithPosition{Finding: f}
				if pos, ok := positions[f.ID]; ok {
					fp.Confidence = pos.Confidence
					if pos.FileID != nil && pos.LineStart != nil && pos.LineEnd != nil {
						fp.EffectiveAnchor = &model.Anchor{
							FileID:   *pos.FileID,
							CommitID: pos.CommitID,
							LineRange: &model.LineRange{
								Start: *pos.LineStart,
								End:   *pos.LineEnd,
							},
						}
					}
				}
				enriched = append(enriched, fp)
			}
			if limit > 0 {
				writeJSON(w, http.StatusOK, PaginatedResponse{Data: enriched, Total: total, Limit: limit, Offset: offset})
			} else {
				writeJSON(w, http.StatusOK, enriched)
			}
			return
		}
	}

	if findings == nil {
		findings = []model.Finding{}
	}
	if limit > 0 {
		writeJSON(w, http.StatusOK, PaginatedResponse{Data: findings, Total: total, Limit: limit, Offset: offset})
	} else {
		writeJSON(w, http.StatusOK, findings)
	}
}

func (h *findingsHandlers) create(w http.ResponseWriter, r *http.Request) {
	var f model.Finding
	if !decodeBody(w, r, &f) {
		return
	}
	if f.ID == "" || f.Title == "" || f.Severity == "" {
		writeError(w, http.StatusBadRequest, "id, title, and severity are required")
		return
	}

	// Validate or default createdAt to RFC3339
	if f.CreatedAt == "" {
		f.CreatedAt = time.Now().UTC().Format(time.RFC3339)
	} else if _, err := time.Parse(time.RFC3339, f.CreatedAt); err != nil {
		writeError(w, http.StatusBadRequest, "createdAt must be RFC3339 format: "+err.Error())
		return
	}

	// Compute lineHash from file content at anchor commit
	if f.Anchor.LineRange != nil && f.Anchor.CommitID != "" && h.repo != nil {
		content, err := h.repo.Show(f.Anchor.CommitID, f.Anchor.FileID)
		if err == nil {
			lines := strings.Split(content, "\n")
			start := f.Anchor.LineRange.Start - 1 // 0-based
			end := f.Anchor.LineRange.End         // exclusive for slice
			if start >= 0 && end <= len(lines) {
				f.LineHash = reconcile.LineHash(lines[start:end])
			}
		}
	}

	if err := h.db.CreateFinding(&f); err != nil {
		writeInternalError(w, err)
		return
	}

	// Create initial position entry
	if f.Anchor.LineRange != nil {
		fileID := f.Anchor.FileID
		_ = h.db.InsertPosition(&model.AnnotationPosition{
			AnnotationID:   f.ID,
			AnnotationType: "finding",
			CommitID:       f.Anchor.CommitID,
			FileID:         &fileID,
			LineStart:      &f.Anchor.LineRange.Start,
			LineEnd:        &f.Anchor.LineRange.End,
			Confidence:     "exact",
		})
	}

	if h.broker != nil {
		h.broker.Publish(events.TopicAnnotations)
	}
	writeJSON(w, http.StatusCreated, f)
}

func (h *findingsHandlers) update(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" {
		writeError(w, http.StatusBadRequest, "id is required")
		return
	}
	var updates map[string]any
	if !decodeBody(w, r, &updates) {
		return
	}
	finding, err := h.db.UpdateFinding(id, updates)
	if err != nil {
		writeInternalError(w, err)
		return
	}
	if h.broker != nil {
		h.broker.Publish(events.TopicAnnotations)
	}
	writeJSON(w, http.StatusOK, finding)
}

func (h *findingsHandlers) delete(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" {
		writeError(w, http.StatusBadRequest, "id is required")
		return
	}
	if err := h.db.DeleteFinding(id); err != nil {
		if strings.Contains(err.Error(), "not found") {
			writeError(w, http.StatusNotFound, "finding not found")
		} else {
			writeInternalError(w, err)
		}
		return
	}
	if h.broker != nil {
		h.broker.Publish(events.TopicAnnotations)
	}
	w.WriteHeader(http.StatusNoContent)
}
