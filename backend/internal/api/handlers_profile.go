package api

import (
	"errors"
	"net/http"

	"bench/internal/db"
	"bench/internal/events"
	"bench/internal/model"
)

type profileHandlers struct {
	db     *db.DB
	broker *events.Broker
}

// GET /api/profile
func (h *profileHandlers) get(w http.ResponseWriter, r *http.Request) {
	p, err := h.db.GetServiceProfile()
	if err != nil {
		writeInternalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, p)
}

// PATCH /api/profile — partial update: only fields present in the body are
// overlaid onto the stored profile. Array fields replace the full list.
func (h *profileHandlers) update(w http.ResponseWriter, r *http.Request) {
	p, err := h.db.GetServiceProfile()
	if err != nil {
		writeInternalError(w, err)
		return
	}
	// Decoding into the current profile overlays only the provided fields.
	// updatedAt is server-stamped on write, so a client-supplied value is
	// harmless.
	if !decodeBody(w, r, &p) {
		return
	}
	if err := p.Validate(); err != nil {
		var verr *model.ProfileValidationError
		if errors.As(err, &verr) {
			writeError(w, http.StatusBadRequest, verr.Error())
			return
		}
		writeInternalError(w, err)
		return
	}
	if err := h.db.PutServiceProfile(p); err != nil {
		writeDBError(w, err)
		return
	}
	updated, err := h.db.GetServiceProfile()
	if err != nil {
		writeInternalError(w, err)
		return
	}
	if h.broker != nil {
		h.broker.Publish(events.TopicProfile)
	}
	writeJSON(w, http.StatusOK, updated)
}

// serviceProfileIfConfigured returns the profile for embedding in overview
// responses (summary, delta), or nil when it has never been configured —
// so absence is itself a signal.
func serviceProfileIfConfigured(database *db.DB) (*model.ServiceProfile, error) {
	configured, err := database.ProfileConfigured()
	if err != nil || !configured {
		return nil, err
	}
	p, err := database.GetServiceProfile()
	if err != nil {
		return nil, err
	}
	return &p, nil
}

// profileGateMessage names every remedy so any client (human or bot) can
// self-serve.
const profileGateMessage = "service profile not configured — configure it before recording review annotations: " +
	"`bench profile set` (CLI), PATCH /api/profile (REST), update_service_profile (MCP), or the Config tab (UI). " +
	"Call get_service_profile / GET /api/profile to see the available fields."

// requireProfile wraps next and rejects review-judgment writes with 412 until
// the service profile has been configured. Reads, the profile endpoints
// themselves, settings, and reconcile are exempt.
func requireProfile(database *db.DB, next http.Handler) http.Handler {
	gatedPrefixes := []string{
		"/api/findings",
		"/api/comments",
		"/api/features",
		"/api/refs",
		"/api/baselines",
		"/api/coverage",
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet, http.MethodHead, http.MethodOptions:
			next.ServeHTTP(w, r)
			return
		}
		gated := false
		for _, prefix := range gatedPrefixes {
			if len(r.URL.Path) >= len(prefix) && r.URL.Path[:len(prefix)] == prefix {
				gated = true
				break
			}
		}
		if gated {
			configured, err := database.ProfileConfigured()
			if err != nil {
				writeInternalError(w, err)
				return
			}
			if !configured {
				writeError(w, http.StatusPreconditionFailed, profileGateMessage)
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}
