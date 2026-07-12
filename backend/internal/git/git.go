package git

import (
	"errors"
	"fmt"
	"path/filepath"
	"regexp"
	"strings"

	"bench/internal/model"
)

// shaRe matches a full 40-hex git sha, used to validate pin/unpin inputs.
var shaRe = regexp.MustCompile(`^[0-9a-f]{40}$`)

var validRef = regexp.MustCompile(`^[a-zA-Z0-9_.^~/-]+$`)

func validateRef(ref string) error {
	if !validRef.MatchString(ref) {
		return fmt.Errorf("invalid git ref: %q", ref)
	}
	return nil
}

func validatePath(p string) error {
	if strings.HasPrefix(p, "-") {
		return fmt.Errorf("invalid path: %q", p)
	}
	return nil
}

// ErrUnknownRef is returned when a commitish cannot be resolved — typically
// because the commit has been rebased/GC'd or the DB references a sha from a
// different checkout. Callers should map this to 404.
var ErrUnknownRef = errors.New("unknown git ref")

// KeepRefPrefix is the ref namespace bench uses to pin commits it cares
// about (baselines, anchored annotations) so they survive rebases and GC.
// A ref at refs/bench/keep/<sha> → <sha> makes the commit and its full
// ancestor chain reachable even after history rewrites.
const KeepRefPrefix = "refs/bench/keep/"

// Repo is the public handle for git operations. It delegates to GoGitBackend.
type Repo struct {
	path    string
	backend Backend
}

// NewRepo returns a *Repo rooted at path.
func NewRepo(path string) *Repo {
	return &Repo{path: path, backend: NewGoGitBackend(path)}
}

// Name returns the repository directory name (last path component). It never
// touches git, so it lives on Repo rather than on Backend.
func (r *Repo) Name() string {
	abs, err := filepath.Abs(r.path)
	if err != nil {
		return filepath.Base(r.path)
	}
	return filepath.Base(abs)
}

func (r *Repo) Head() (string, error) { return r.backend.Head() }

func (r *Repo) DefaultBranch() string { return r.backend.DefaultBranch() }

func (r *Repo) BranchTip(branch string) (string, error) { return r.backend.BranchTip(branch) }

func (r *Repo) ResolveRef(ref string) (string, error) { return r.backend.ResolveRef(ref) }

func (r *Repo) Log(limit int) ([]model.CommitInfo, error) { return r.backend.Log(limit) }

func (r *Repo) LogRange(from, to, path string, limit int) ([]model.CommitInfo, error) {
	return r.backend.LogRange(from, to, path, limit)
}

func (r *Repo) Graph(limit int) ([]model.GraphCommit, error) { return r.backend.Graph(limit) }

func (r *Repo) Activity(scale string, periods int) ([]model.ActivityBucket, error) {
	return r.backend.Activity(scale, periods)
}

func (r *Repo) RangeStats(from, to string) (model.RangeStats, error) {
	return r.backend.RangeStats(from, to)
}

func (r *Repo) Tree(commitish string) ([]model.FileEntry, error) { return r.backend.Tree(commitish) }

func (r *Repo) Show(commitish, path string) (string, error) { return r.backend.Show(commitish, path) }

func (r *Repo) Diff(from, to, path string) (*model.DiffResult, error) {
	return r.backend.Diff(from, to, path)
}

func (r *Repo) DiffRaw(from, to, path string) (string, error) {
	return r.backend.DiffRaw(from, to, path)
}

func (r *Repo) DiffFiles(from, to string) ([]string, error) {
	return r.backend.DiffFiles(from, to)
}

func (r *Repo) DiffStat(from, to string) ([]model.FileStat, error) {
	return r.backend.DiffStat(from, to)
}

func (r *Repo) DetectRename(from, to, path string) (string, error) {
	return r.backend.DetectRename(from, to, path)
}

func (r *Repo) IsAncestor(ancestor, descendant string) (bool, error) {
	return r.backend.IsAncestor(ancestor, descendant)
}

func (r *Repo) MergeBase(a, b string) (string, error) { return r.backend.MergeBase(a, b) }

func (r *Repo) RevList(from, to string) ([]string, error) { return r.backend.RevList(from, to) }

func (r *Repo) Branches() ([]model.BranchInfo, error) { return r.backend.Branches() }

func (r *Repo) RemoteURL() string { return r.backend.RemoteURL() }

func (r *Repo) Grep(pattern, commit, path string, caseInsensitive, fixed bool, maxResults int) ([]model.GrepMatch, error) {
	return r.backend.Grep(pattern, commit, path, caseInsensitive, fixed, maxResults)
}

func (r *Repo) Blame(commit, path string, lineStart, lineEnd int) ([]model.BlameLine, error) {
	return r.backend.Blame(commit, path, lineStart, lineEnd)
}

func (r *Repo) OriginSuggestion(file, commitish string, lineStart, lineEnd int) (*model.OriginSuggestion, error) {
	return r.backend.OriginSuggestion(file, commitish, lineStart, lineEnd)
}

func (r *Repo) PinCommit(sha string) error { return r.backend.PinCommit(sha) }

func (r *Repo) UnpinCommit(sha string) error { return r.backend.UnpinCommit(sha) }

func (r *Repo) ListPinnedCommits() ([]string, error) { return r.backend.ListPinnedCommits() }
