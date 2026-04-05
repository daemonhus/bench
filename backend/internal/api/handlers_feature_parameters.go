package api

import (
	"net/http"
	"strings"
	"time"

	"bench/internal/db"
	"bench/internal/events"
	"bench/internal/model"

	"github.com/google/uuid"
)

type featureParamsHandlers struct {
	db     *db.DB
	broker *events.Broker
}

func (h *featureParamsHandlers) list(w http.ResponseWriter, r *http.Request) {
	featureID := r.PathValue("id")
	params, err := h.db.ListParameters(featureID)
	if err != nil {
		writeInternalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, params)
}

func (h *featureParamsHandlers) create(w http.ResponseWriter, r *http.Request) {
	featureID := r.PathValue("id")
	var p model.FeatureParameter
	if !decodeBody(w, r, &p) {
		return
	}
	p.FeatureID = featureID
	if p.Name == "" {
		writeError(w, http.StatusBadRequest, "name is required")
		return
	}
	if p.ID == "" {
		p.ID = uuid.New().String()
	}
	if p.CreatedAt == "" {
		p.CreatedAt = time.Now().UTC().Format(time.RFC3339)
	}
	if err := h.db.CreateParameter(&p); err != nil {
		writeDBError(w, err)
		return
	}
	if h.broker != nil {
		h.broker.Publish(events.TopicAnnotations)
	}
	writeJSON(w, http.StatusCreated, p)
}

func (h *featureParamsHandlers) get(w http.ResponseWriter, r *http.Request) {
	pid := r.PathValue("pid")
	if pid == "" {
		writeError(w, http.StatusBadRequest, "parameter id is required")
		return
	}
	p, err := h.db.GetParameter(pid)
	if err != nil {
		if strings.Contains(err.Error(), "not found") {
			writeError(w, http.StatusNotFound, "parameter not found")
		} else {
			writeInternalError(w, err)
		}
		return
	}
	writeJSON(w, http.StatusOK, p)
}

func (h *featureParamsHandlers) update(w http.ResponseWriter, r *http.Request) {
	pid := r.PathValue("pid")
	if pid == "" {
		writeError(w, http.StatusBadRequest, "parameter id is required")
		return
	}
	var updates map[string]any
	if !decodeBody(w, r, &updates) {
		return
	}
	p, err := h.db.UpdateParameter(pid, updates)
	if err != nil {
		if strings.Contains(err.Error(), "not found") {
			writeError(w, http.StatusNotFound, "parameter not found")
		} else {
			writeDBError(w, err)
		}
		return
	}
	if h.broker != nil {
		h.broker.Publish(events.TopicAnnotations)
	}
	writeJSON(w, http.StatusOK, p)
}

func (h *featureParamsHandlers) delete(w http.ResponseWriter, r *http.Request) {
	pid := r.PathValue("pid")
	if pid == "" {
		writeError(w, http.StatusBadRequest, "parameter id is required")
		return
	}
	if err := h.db.DeleteParameter(pid); err != nil {
		if strings.Contains(err.Error(), "not found") {
			writeError(w, http.StatusNotFound, "parameter not found")
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
