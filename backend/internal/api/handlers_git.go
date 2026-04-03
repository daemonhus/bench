package api

import (
	"net/http"
	"strconv"
	"strings"

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
	if limit > 500 {
		limit = 500
	}

	fromCommit := r.URL.Query().Get("from_commit")
	toCommit := r.URL.Query().Get("to_commit")
	path := r.URL.Query().Get("path")

	var commits []model.CommitInfo
	var err error
	if fromCommit != "" || toCommit != "" || path != "" {
		commits, err = h.repo.LogRange(fromCommit, toCommit, path, limit)
	} else {
		commits, err = h.repo.Log(limit)
	}
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
	if prefix := r.URL.Query().Get("prefix"); prefix != "" {
		filtered := entries[:0]
		for _, e := range entries {
			if strings.HasPrefix(e.Path, prefix) {
				filtered = append(filtered, e)
			}
		}
		entries = filtered
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

	// Support optional line range filtering.
	lineStart, _ := strconv.Atoi(r.URL.Query().Get("line_start"))
	lineEnd, _ := strconv.Atoi(r.URL.Query().Get("line_end"))
	if lineStart > 0 || lineEnd > 0 {
		lines := strings.Split(content, "\n")
		start := 0
		end := len(lines)
		if lineStart > 0 {
			start = lineStart - 1 // 0-indexed
		}
		if lineEnd > 0 && lineEnd < end {
			end = lineEnd
		}
		if start >= len(lines) {
			writeError(w, http.StatusBadRequest, "line_start exceeds file length")
			return
		}
		content = strings.Join(lines[start:end], "\n")
	}

	writeJSON(w, http.StatusOK, map[string]string{"content": content})
}

func (h *gitHandlers) blame(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Query().Get("path")
	if path == "" {
		writeError(w, http.StatusBadRequest, "path query param is required")
		return
	}
	commit := r.URL.Query().Get("commit")
	lineStart, _ := strconv.Atoi(r.URL.Query().Get("line_start"))
	lineEnd, _ := strconv.Atoi(r.URL.Query().Get("line_end"))

	lines, err := h.repo.Blame(commit, path, lineStart, lineEnd)
	if err != nil {
		writeInternalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, lines)
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
	fixed := r.URL.Query().Get("fixed") == "true"
	maxResults := 100
	if s := r.URL.Query().Get("max_results"); s != "" {
		if n, err := strconv.Atoi(s); err == nil && n > 0 {
			maxResults = n
			if maxResults > 500 {
				maxResults = 500
			}
		}
	}
	matches, err := h.repo.Grep(pattern, commit, path, caseInsensitive, fixed, maxResults)
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
	if from == "" || to == "" {
		writeError(w, http.StatusBadRequest, "from and to query params are required")
		return
	}
	result, err := h.repo.Diff(from, to, path)
	if err != nil {
		writeInternalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}
