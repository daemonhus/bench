package api

import (
	"errors"
	"net/http"
	"strconv"

	"bench/internal/db"
	"bench/internal/events"
	"bench/internal/git"
	"bench/internal/review"
)

// branchHeader carries the UI's address override (?branch= in the page
// address), so every request a page makes is looked at on the same branch.
const branchHeader = "X-Bench-Branch"

// offBranchHeader on a list response counts the items left out because they
// are on other branches.
const offBranchHeader = "X-Bench-Off-Branch"

// requestedBranch is the branch a request asks for: ?branch= or the header.
func requestedBranch(r *http.Request) string {
	if b := r.URL.Query().Get("branch"); b != "" {
		return b
	}
	return r.Header.Get(branchHeader)
}

// reviewBranch is the review branch in effect for a request.
func reviewBranch(d *db.DB, repo *git.Repo, r *http.Request) (review.Branch, error) {
	return review.Resolve(d, repo, requestedBranch(r))
}

// branchScope is what a list of findings, comments or features is filtered
// to: the review branch, or nil (everything) for ?all_branches=true.
func branchScope(d *db.DB, repo *git.Repo, r *http.Request) (*review.Scope, error) {
	if r.URL.Query().Get("all_branches") == "true" {
		return nil, nil
	}
	b, err := reviewBranch(d, repo, r)
	if err != nil {
		return nil, err
	}
	return review.NewScope(repo, b.Tip), nil
}

// keepOnBranch filters items to those whose anchor commit is on the scope's
// branch and counts the rest in the response's offBranchHeader.
func keepOnBranch[T any](w http.ResponseWriter, scope *review.Scope, items []T, commitOf func(T) string) []T {
	if scope == nil {
		return items
	}
	kept := items[:0]
	off := 0
	for _, it := range items {
		if scope.Has(commitOf(it)) {
			kept = append(kept, it)
		} else {
			off++
		}
	}
	w.Header().Set(offBranchHeader, strconv.Itoa(off))
	return kept
}

type reviewBranchHandlers struct {
	db     *db.DB
	repo   *git.Repo
	broker *events.Broker
}

// GET /api/review-branch → the branch in effect (?branch= to ask about another)
func (h *reviewBranchHandlers) get(w http.ResponseWriter, r *http.Request) {
	b, err := reviewBranch(h.db, h.repo, r)
	if err != nil {
		writeInternalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, b)
}

// PUT /api/review-branch {branch} → saves it for the project; "" is the default branch
func (h *reviewBranchHandlers) put(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Branch string `json:"branch"`
	}
	if !decodeBody(w, r, &body) {
		return
	}
	if err := review.Save(h.db, h.repo, body.Branch); err != nil {
		if errors.Is(err, review.ErrUnknownBranch) || errors.Is(err, git.ErrInvalidArgument) {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		writeInternalError(w, err)
		return
	}
	if h.broker != nil {
		h.broker.Publish(events.TopicGit)
	}
	b, err := review.Resolve(h.db, h.repo, "")
	if err != nil {
		writeInternalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, b)
}
