package api

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"time"

	"bench/internal/db"
	"bench/internal/events"
	"bench/internal/model"

	"github.com/google/uuid"
)

type refsHandlers struct {
	db     *db.DB
	broker *events.Broker
}

func (h *refsHandlers) list(w http.ResponseWriter, r *http.Request) {
	entityType := r.URL.Query().Get("entityType")
	entityID := r.URL.Query().Get("entityId")
	provider := r.URL.Query().Get("provider")

	refs, err := h.db.ListRefs(entityType, entityID, provider)
	if err != nil {
		writeInternalError(w, err)
		return
	}
	if refs == nil {
		refs = []model.Ref{}
	}
	writeJSON(w, http.StatusOK, refs)
}

func (h *refsHandlers) get(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" {
		writeError(w, http.StatusBadRequest, "id is required")
		return
	}
	ref, err := h.db.GetRef(id)
	if err != nil {
		writeError(w, http.StatusNotFound, "ref not found")
		return
	}
	writeJSON(w, http.StatusOK, ref)
}

func (h *refsHandlers) create(w http.ResponseWriter, r *http.Request) {
	data, err := io.ReadAll(r.Body)
	if err != nil {
		writeError(w, http.StatusBadRequest, "failed to read body")
		return
	}

	now := time.Now().UTC().Format(time.RFC3339)

	// Detect array vs object by first non-whitespace character
	trimmed := strings.TrimSpace(string(data))
	if strings.HasPrefix(trimmed, "[") {
		var items []model.Ref
		if err := json.Unmarshal(data, &items); err != nil {
			writeError(w, http.StatusBadRequest, "invalid JSON array: "+err.Error())
			return
		}
		for i := range items {
			if items[i].ID == "" {
				items[i].ID = uuid.New().String()
			}
			if items[i].CreatedAt == "" {
				items[i].CreatedAt = now
			}
			if items[i].Provider == "" {
				items[i].Provider = model.InferProvider(items[i].URL)
			}
		}
		ids, err := h.db.BatchCreateRefs(items)
		if err != nil {
			writeDBError(w, err)
			return
		}
		if h.broker != nil {
			h.broker.Publish(events.TopicAnnotations)
		}
		writeJSON(w, http.StatusCreated, map[string]any{"ids": ids})
		return
	}

	var ref model.Ref
	if err := json.Unmarshal(data, &ref); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON: "+err.Error())
		return
	}
	if ref.ID == "" {
		ref.ID = uuid.New().String()
	}
	if ref.CreatedAt == "" {
		ref.CreatedAt = now
	}
	if ref.EntityType == "" || ref.EntityID == "" || ref.URL == "" {
		writeError(w, http.StatusBadRequest, "entityType, entityId, and url are required")
		return
	}
	if ref.Provider == "" {
		ref.Provider = model.InferProvider(ref.URL)
	}
	if err := h.db.CreateRef(&ref); err != nil {
		writeDBError(w, err)
		return
	}
	if h.broker != nil {
		h.broker.Publish(events.TopicAnnotations)
	}
	writeJSON(w, http.StatusCreated, ref)
}

func (h *refsHandlers) update(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" {
		writeError(w, http.StatusBadRequest, "id is required")
		return
	}
	var updates map[string]any
	if !decodeBody(w, r, &updates) {
		return
	}
	ref, err := h.db.UpdateRef(id, updates)
	if err != nil {
		if strings.Contains(err.Error(), "not found") {
			writeError(w, http.StatusNotFound, "ref not found")
		} else {
			writeDBError(w, err)
		}
		return
	}
	if h.broker != nil {
		h.broker.Publish(events.TopicAnnotations)
	}
	writeJSON(w, http.StatusOK, ref)
}

func (h *refsHandlers) delete(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" {
		writeError(w, http.StatusBadRequest, "id is required")
		return
	}
	if err := h.db.DeleteRef(id); err != nil {
		if strings.Contains(err.Error(), "not found") {
			writeError(w, http.StatusNotFound, "ref not found")
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
