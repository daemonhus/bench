package api

import (
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strings"
)

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(v); err != nil {
		log.Printf("writeJSON: %v", err)
	}
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

func writeInternalError(w http.ResponseWriter, err error) {
	log.Printf("internal error: %v", err)
	writeError(w, http.StatusInternalServerError, "internal error")
}

// writeDBError returns a 400 for SQLite constraint violations so callers see
// the real reason (e.g. "CHECK constraint failed: status IN (...)") instead of
// an opaque 500.  All other DB errors fall through to writeInternalError.
func writeDBError(w http.ResponseWriter, err error) {
	if strings.Contains(strings.ToLower(err.Error()), "constraint") {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeInternalError(w, err)
}

// decodeBody reads and decodes a JSON request body with a 1MB limit.
// Returns true on success; writes an error response and returns false on failure.
func decodeBody(w http.ResponseWriter, r *http.Request, v any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	if err := json.NewDecoder(r.Body).Decode(v); err != nil {
		var maxErr *http.MaxBytesError
		var typeErr *json.UnmarshalTypeError
		if errors.As(err, &maxErr) {
			writeError(w, http.StatusRequestEntityTooLarge, "request body too large")
		} else if errors.As(err, &typeErr) {
			writeError(w, http.StatusBadRequest, "invalid field type: "+typeErr.Field+" must be "+typeErr.Type.String()+", got "+typeErr.Value)
		} else {
			writeError(w, http.StatusBadRequest, "invalid JSON")
		}
		return false
	}
	return true
}

// PaginatedResponse wraps a result set with offset-based pagination metadata.
type PaginatedResponse struct {
	Data   any `json:"data"`
	Total  int `json:"total"`
	Limit  int `json:"limit"`
	Offset int `json:"offset"`
}
