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

	"github.com/google/uuid"
)

type commentsHandlers struct {
	db         *db.DB
	repo       *git.Repo
	reconciler *reconcile.Reconciler
	broker     *events.Broker
}

func (h *commentsHandlers) list(w http.ResponseWriter, r *http.Request) {
	fileID := r.URL.Query().Get("fileId")
	findingID := r.URL.Query().Get("findingId")
	featureID := r.URL.Query().Get("featureId")
	commit := r.URL.Query().Get("commit")
	includeResolved := r.URL.Query().Get("include_resolved") == "true"
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	offset, _ := strconv.Atoi(r.URL.Query().Get("offset"))
	if limit < 0 {
		limit = 0
	}
	if offset < 0 {
		offset = 0
	}

	comments, total, err := h.db.ListComments(fileID, findingID, limit, offset, featureID)
	if err != nil {
		writeInternalError(w, err)
		return
	}

	// Post-filter resolved comments
	if !includeResolved {
		filtered := comments[:0]
		for _, c := range comments {
			if c.ResolvedCommit == nil {
				filtered = append(filtered, c)
			}
		}
		comments = filtered
		total = len(comments)
	}

	// When commit param present, enrich with effective positions
	if commit != "" && h.reconciler != nil {
		positions, err := h.reconciler.GetEffectivePositions(fileID, commit)
		if err == nil {
			enriched := make([]model.CommentWithPosition, 0, len(comments))
			for _, c := range comments {
				cp := model.CommentWithPosition{Comment: c}
				if pos, ok := positions[c.ID]; ok {
					cp.Confidence = pos.Confidence
					if pos.FileID != nil && pos.LineStart != nil && pos.LineEnd != nil {
						cp.EffectiveAnchor = &model.Anchor{
							FileID:   *pos.FileID,
							CommitID: pos.CommitID,
							LineRange: &model.LineRange{
								Start: *pos.LineStart,
								End:   *pos.LineEnd,
							},
						}
					}
				}
				enriched = append(enriched, cp)
			}
			if limit > 0 {
				writeJSON(w, http.StatusOK, PaginatedResponse{Data: enriched, Total: total, Limit: limit, Offset: offset})
			} else {
				writeJSON(w, http.StatusOK, enriched)
			}
			return
		}
	}

	if comments == nil {
		comments = []model.Comment{}
	}
	if limit > 0 {
		writeJSON(w, http.StatusOK, PaginatedResponse{Data: comments, Total: total, Limit: limit, Offset: offset})
	} else {
		writeJSON(w, http.StatusOK, comments)
	}
}

func (h *commentsHandlers) create(w http.ResponseWriter, r *http.Request) {
	var c model.Comment
	if !decodeBody(w, r, &c) {
		return
	}
	if c.ID == "" {
		c.ID = uuid.New().String()
	}
	if c.Author == "" || c.Text == "" {
		writeError(w, http.StatusBadRequest, "author and text are required")
		return
	}
	if c.Anchor.CommitID == "" {
		if h.repo == nil {
			writeError(w, http.StatusBadRequest, "commitId is required")
			return
		}
		head, err := h.repo.ResolveRef("HEAD")
		if err != nil {
			writeError(w, http.StatusBadRequest, "commitId is required: "+err.Error())
			return
		}
		c.Anchor.CommitID = head
	}

	// Validate or default timestamp to RFC3339
	if c.Timestamp == "" {
		c.Timestamp = time.Now().UTC().Format(time.RFC3339)
	} else if _, err := time.Parse(time.RFC3339, c.Timestamp); err != nil {
		writeError(w, http.StatusBadRequest, "timestamp must be RFC3339 format: "+err.Error())
		return
	}

	// Compute lineHash from file content at anchor commit
	if c.Anchor.LineRange != nil && c.Anchor.CommitID != "" && h.repo != nil {
		content, err := h.repo.Show(c.Anchor.CommitID, c.Anchor.FileID)
		if err == nil {
			lines := strings.Split(content, "\n")
			start := c.Anchor.LineRange.Start - 1
			end := c.Anchor.LineRange.End
			if end == 0 {
				end = c.Anchor.LineRange.Start
			}
			if start >= 0 && start < end && end <= len(lines) {
				c.LineHash = reconcile.LineHash(lines[start:end])
			}
		}
	}

	if err := h.db.CreateComment(&c); err != nil {
		writeDBError(w, err)
		return
	}

	// Create initial position entry
	if c.Anchor.LineRange != nil {
		fileID := c.Anchor.FileID
		_ = h.db.InsertPosition(&model.AnnotationPosition{
			AnnotationID:   c.ID,
			AnnotationType: "comment",
			CommitID:       c.Anchor.CommitID,
			FileID:         &fileID,
			LineStart:      &c.Anchor.LineRange.Start,
			LineEnd:        &c.Anchor.LineRange.End,
			Confidence:     "exact",
		})
	}

	if h.broker != nil {
		h.broker.Publish(events.TopicAnnotations)
	}
	writeJSON(w, http.StatusCreated, c)
}

func (h *commentsHandlers) get(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" {
		writeError(w, http.StatusBadRequest, "id is required")
		return
	}
	comment, err := h.db.GetComment(id)
	if err != nil {
		if strings.Contains(err.Error(), "not found") {
			writeError(w, http.StatusNotFound, "comment not found")
		} else {
			writeInternalError(w, err)
		}
		return
	}
	writeJSON(w, http.StatusOK, comment)
}

func (h *commentsHandlers) update(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" {
		writeError(w, http.StatusBadRequest, "id is required")
		return
	}
	var updates map[string]any
	if !decodeBody(w, r, &updates) {
		return
	}
	if err := h.db.UpdateComment(id, updates); err != nil {
		writeDBError(w, err)
		return
	}
	if h.broker != nil {
		h.broker.Publish(events.TopicAnnotations)
	}
	updated, err := h.db.GetComment(id)
	if err != nil || updated == nil {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	writeJSON(w, http.StatusOK, updated)
}

func (h *commentsHandlers) delete(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" {
		writeError(w, http.StatusBadRequest, "id is required")
		return
	}
	if err := h.db.DeleteComment(id); err != nil {
		writeInternalError(w, err)
		return
	}
	if h.broker != nil {
		h.broker.Publish(events.TopicAnnotations)
	}
	w.WriteHeader(http.StatusNoContent)
}
