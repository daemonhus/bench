package api

import (
	"net/http"
	"strings"
	"time"

	"bench/internal/db"
	"bench/internal/events"
	"bench/internal/git"
	"bench/internal/model"
	"bench/internal/reconcile"

	"github.com/google/uuid"
)

type featuresHandlers struct {
	db         *db.DB
	repo       *git.Repo
	reconciler *reconcile.Reconciler
	broker     *events.Broker
}

func (h *featuresHandlers) list(w http.ResponseWriter, r *http.Request) {
	fileID := r.URL.Query().Get("fileId")
	commit := r.URL.Query().Get("commit")

	features, _, err := h.db.ListFeatures(fileID, 0, 0)
	if err != nil {
		writeInternalError(w, err)
		return
	}

	// Filter by kind/status query params
	kind := r.URL.Query().Get("kind")
	status := r.URL.Query().Get("status")
	if kind != "" || status != "" {
		filtered := features[:0]
		for _, f := range features {
			if kind != "" && f.Kind != kind {
				continue
			}
			if status != "" && f.Status != status {
				continue
			}
			filtered = append(filtered, f)
		}
		features = filtered
	}

	// When commit param present, enrich with effective positions
	if commit != "" && h.reconciler != nil && fileID != "" {
		positions, err := h.reconciler.GetEffectivePositions(fileID, commit)
		if err == nil {
			enriched := make([]model.FeatureWithPosition, 0, len(features))
			for _, f := range features {
				fp := model.FeatureWithPosition{Feature: f}
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
			writeJSON(w, http.StatusOK, enriched)
			return
		}
	}

	if features == nil {
		features = []model.Feature{}
	}
	writeJSON(w, http.StatusOK, features)
}

func (h *featuresHandlers) create(w http.ResponseWriter, r *http.Request) {
	var f model.Feature
	if !decodeBody(w, r, &f) {
		return
	}
	if f.ID == "" {
		f.ID = uuid.New().String()
	}
	if f.Title == "" || f.Kind == "" {
		writeError(w, http.StatusBadRequest, "title and kind are required")
		return
	}
	if f.Status == "" {
		f.Status = "active"
	}
	if f.Tags == nil {
		f.Tags = []string{}
	}

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
			start := f.Anchor.LineRange.Start - 1
			end := f.Anchor.LineRange.End
			if start >= 0 && end <= len(lines) {
				f.LineHash = reconcile.LineHash(lines[start:end])
			}
		}
	}

	if err := h.db.CreateFeature(&f); err != nil {
		writeInternalError(w, err)
		return
	}

	// Create initial position entry
	if f.Anchor.LineRange != nil {
		fileID := f.Anchor.FileID
		_ = h.db.InsertPosition(&model.AnnotationPosition{
			AnnotationID:   f.ID,
			AnnotationType: "feature",
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

func (h *featuresHandlers) update(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" {
		writeError(w, http.StatusBadRequest, "id is required")
		return
	}
	var updates map[string]any
	if !decodeBody(w, r, &updates) {
		return
	}
	feature, err := h.db.UpdateFeature(id, updates)
	if err != nil {
		writeInternalError(w, err)
		return
	}
	if h.broker != nil {
		h.broker.Publish(events.TopicAnnotations)
	}
	writeJSON(w, http.StatusOK, feature)
}

func (h *featuresHandlers) delete(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" {
		writeError(w, http.StatusBadRequest, "id is required")
		return
	}
	if err := h.db.DeleteFeature(id); err != nil {
		if strings.Contains(err.Error(), "not found") {
			writeError(w, http.StatusNotFound, "feature not found")
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
