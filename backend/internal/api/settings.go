package api

import (
	"net/http"

	"bench/internal/db"
)

type settingsHandlers struct {
	db *db.DB
}

func (h *settingsHandlers) get(w http.ResponseWriter, r *http.Request) {
	settings, err := h.db.GetAllSettings()
	if err != nil {
		writeInternalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, settings)
}

func (h *settingsHandlers) put(w http.ResponseWriter, r *http.Request) {
	var body map[string]string
	if !decodeBody(w, r, &body) {
		return
	}
	if err := h.db.PutSettings(body); err != nil {
		writeInternalError(w, err)
		return
	}
	w.WriteHeader(204)
}
