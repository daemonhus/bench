package api

import (
	"net/http"
	"strconv"

	"bench/internal/git"
	"bench/internal/model"
)

type gitHandlers struct {
	repo *git.Repo
}

func (h *gitHandlers) info(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{
		"name":          h.repo.Name(),
		"defaultBranch": h.repo.DefaultBranch(),
		"remoteUrl":     h.repo.RemoteURL(),
	})
}

func (h *gitHandlers) listCommits(w http.ResponseWriter, r *http.Request) {
	limit := 50
	if s := r.URL.Query().Get("limit"); s != "" {
		if n, err := strconv.Atoi(s); err == nil && n > 0 {
			limit = n
		}
	}
	commits, err := h.repo.Log(limit)
	if err != nil {
		writeInternalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, commits)
}

func (h *gitHandlers) listTree(w http.ResponseWriter, r *http.Request) {
	commitish := r.PathValue("commitish")
	if commitish == "" {
		writeError(w, http.StatusBadRequest, "commitish is required")
		return
	}
	entries, err := h.repo.Tree(commitish)
	if err != nil {
		writeInternalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, entries)
}

func (h *gitHandlers) showFile(w http.ResponseWriter, r *http.Request) {
	commitish := r.PathValue("commitish")
	path := r.PathValue("path")
	if commitish == "" || path == "" {
		writeError(w, http.StatusBadRequest, "commitish and path are required")
		return
	}
	content, err := h.repo.Show(commitish, path)
	if err != nil {
		writeInternalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"content": content})
}

func (h *gitHandlers) listBranches(w http.ResponseWriter, r *http.Request) {
	branches, err := h.repo.Branches()
	if err != nil {
		writeInternalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, branches)
}

func (h *gitHandlers) graph(w http.ResponseWriter, r *http.Request) {
	limit := 100
	if s := r.URL.Query().Get("limit"); s != "" {
		if n, err := strconv.Atoi(s); err == nil && n > 0 {
			limit = n
		}
	}
	commits, err := h.repo.Graph(limit)
	if err != nil {
		writeInternalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, commits)
}

func (h *gitHandlers) diffFiles(w http.ResponseWriter, r *http.Request) {
	from := r.URL.Query().Get("from")
	to := r.URL.Query().Get("to")
	if from == "" || to == "" {
		writeError(w, http.StatusBadRequest, "from and to query params are required")
		return
	}
	files, err := h.repo.DiffFiles(from, to)
	if err != nil {
		writeInternalError(w, err)
		return
	}
	if files == nil {
		files = []string{}
	}
	writeJSON(w, http.StatusOK, files)
}

func (h *gitHandlers) search(w http.ResponseWriter, r *http.Request) {
	pattern := r.URL.Query().Get("pattern")
	if pattern == "" {
		writeError(w, http.StatusBadRequest, "pattern query param is required")
		return
	}
	if len(pattern) > 500 {
		writeError(w, http.StatusBadRequest, "pattern too long (max 500 chars)")
		return
	}
	commit := r.URL.Query().Get("commit")
	path := r.URL.Query().Get("path")
	caseInsensitive := r.URL.Query().Get("case_insensitive") == "true"
	maxResults := 100
	if s := r.URL.Query().Get("max_results"); s != "" {
		if n, err := strconv.Atoi(s); err == nil && n > 0 {
			maxResults = n
			if maxResults > 500 {
				maxResults = 500
			}
		}
	}
	matches, err := h.repo.Grep(pattern, commit, path, caseInsensitive, maxResults)
	if err != nil {
		writeInternalError(w, err)
		return
	}
	if matches == nil {
		matches = []model.GrepMatch{}
	}
	writeJSON(w, http.StatusOK, matches)
}

func (h *gitHandlers) diff(w http.ResponseWriter, r *http.Request) {
	from := r.URL.Query().Get("from")
	to := r.URL.Query().Get("to")
	path := r.URL.Query().Get("path")
	if from == "" || to == "" || path == "" {
		writeError(w, http.StatusBadRequest, "from, to, and path query params are required")
		return
	}
	result, err := h.repo.Diff(from, to, path)
	if err != nil {
		writeInternalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}
