package api

import (
	"encoding/json"
	"net/http"

	"bench/internal/db"
	"bench/internal/events"
	"bench/internal/git"
	"bench/internal/model"
)

// originAnchorFn resolves an entity ID to its anchor, erroring when the
// entity does not exist. It doubles as the existence check for writes.
type originAnchorFn func(id string) (model.Anchor, error)

func (h *findingsHandlers) findingAnchor(id string) (model.Anchor, error) {
	f, err := h.db.GetFinding(id)
	if err != nil {
		return model.Anchor{}, err
	}
	return f.Anchor, nil
}

func (h *featuresHandlers) featureAnchor(id string) (model.Anchor, error) {
	f, err := h.db.GetFeature(id)
	if err != nil {
		return model.Anchor{}, err
	}
	return f.Anchor, nil
}

func (h *findingsHandlers) putOrigin(w http.ResponseWriter, r *http.Request) {
	originPut(h.db, h.repo, h.broker, "finding", h.findingAnchor, w, r)
}
func (h *findingsHandlers) deleteOrigin(w http.ResponseWriter, r *http.Request) {
	originDelete(h.db, h.broker, "finding", h.findingAnchor, w, r)
}
func (h *findingsHandlers) suggestOrigin(w http.ResponseWriter, r *http.Request) {
	originSuggest(h.repo, "finding", h.findingAnchor, w, r)
}
func (h *featuresHandlers) putOrigin(w http.ResponseWriter, r *http.Request) {
	originPut(h.db, h.repo, h.broker, "feature", h.featureAnchor, w, r)
}
func (h *featuresHandlers) deleteOrigin(w http.ResponseWriter, r *http.Request) {
	originDelete(h.db, h.broker, "feature", h.featureAnchor, w, r)
}
func (h *featuresHandlers) suggestOrigin(w http.ResponseWriter, r *http.Request) {
	originSuggest(h.repo, "feature", h.featureAnchor, w, r)
}

// originPut upserts the entity's historical context. Only fields present in
// the request body overwrite; the merge happens against the stored record.
func originPut(dbh *db.DB, repo *git.Repo, broker *events.Broker, entityType string, anchorOf originAnchorFn, w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if _, err := anchorOf(id); err != nil {
		writeError(w, http.StatusNotFound, entityType+" not found")
		return
	}
	var body struct {
		Explanation      *string `json:"explanation"`
		IntroducedCommit *string `json:"introducedCommit"`
		IntroducedDate   *string `json:"introducedDate"`
		Actor            *string `json:"actor"`
		Branch           *string `json:"branch"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON")
		return
	}

	current, err := dbh.GetOrigin(entityType, id)
	if err != nil {
		writeInternalError(w, err)
		return
	}
	merged := model.Origin{}
	if current != nil {
		merged = *current
	}
	if body.Explanation != nil {
		merged.Explanation = *body.Explanation
	}
	if body.IntroducedCommit != nil {
		merged.IntroducedCommit = *body.IntroducedCommit
	}
	if body.IntroducedDate != nil {
		merged.IntroducedDate = *body.IntroducedDate
	}
	if body.Actor != nil {
		merged.Actor = *body.Actor
	}
	if body.Branch != nil {
		merged.Branch = *body.Branch
	}

	// Normalise and pin the introduced commit when it resolves; unresolvable
	// values are stored as-is, since the introducing commit may legitimately
	// have been rewritten out of history.
	if body.IntroducedCommit != nil && merged.IntroducedCommit != "" {
		if sha, err := repo.ResolveRef(merged.IntroducedCommit); err == nil {
			merged.IntroducedCommit = sha
			_ = repo.PinCommit(sha)
		}
	}

	if err := dbh.PutOrigin(entityType, id, merged); err != nil {
		writeInternalError(w, err)
		return
	}
	updated, err := dbh.GetOrigin(entityType, id)
	if err != nil {
		writeInternalError(w, err)
		return
	}
	if broker != nil {
		broker.Publish(events.TopicAnnotations)
	}
	writeJSON(w, http.StatusOK, updated)
}

func originDelete(dbh *db.DB, broker *events.Broker, entityType string, anchorOf originAnchorFn, w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if _, err := anchorOf(id); err != nil {
		writeError(w, http.StatusNotFound, entityType+" not found")
		return
	}
	if err := dbh.DeleteOrigin(entityType, id); err != nil {
		writeInternalError(w, err)
		return
	}
	if broker != nil {
		broker.Publish(events.TopicAnnotations)
	}
	w.WriteHeader(http.StatusNoContent)
}

// originSuggest derives an origin candidate from the entity's anchor: blame
// picks the introducing commit, the first-parent walk finds the merge that
// brought it in (its subject usually names the branch or MR), and recent
// commits on the file give surrounding context. Read-only: the caller
// confirms the suggestion into a PUT, nothing is written here.
func originSuggest(repo *git.Repo, entityType string, anchorOf originAnchorFn, w http.ResponseWriter, r *http.Request) {
	anchor, err := anchorOf(r.PathValue("id"))
	if err != nil {
		writeError(w, http.StatusNotFound, entityType+" not found")
		return
	}
	start, end := 0, 0
	if anchor.LineRange != nil {
		start, end = anchor.LineRange.Start, anchor.LineRange.End
	}
	suggestion, err := repo.OriginSuggestion(anchor.FileID, anchor.CommitID, start, end)
	if err != nil {
		writeRefError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, suggestion)
}
