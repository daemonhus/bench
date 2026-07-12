package git

import "bench/internal/model"

// Backend is the git implementation behind *Repo, provided by GoGitBackend.
// Name() is intentionally not on Backend: it's derived from the path and
// doesn't touch git state.
type Backend interface {
	Head() (string, error)
	DefaultBranch() string
	BranchTip(branch string) (string, error)
	ResolveRef(ref string) (string, error)

	Log(limit int) ([]model.CommitInfo, error)
	LogRange(from, to, path string, limit int) ([]model.CommitInfo, error)
	Graph(limit int) ([]model.GraphCommit, error)
	Activity(scale string, periods int) ([]model.ActivityBucket, error)

	Tree(commitish string) ([]model.FileEntry, error)
	Show(commitish, path string) (string, error)

	Diff(from, to, path string) (*model.DiffResult, error)
	DiffRaw(from, to, path string) (string, error)
	DiffFiles(from, to string) ([]string, error)
	DiffStat(from, to string) ([]model.FileStat, error)
	DetectRename(from, to, path string) (string, error)

	IsAncestor(ancestor, descendant string) (bool, error)
	MergeBase(a, b string) (string, error)
	RevList(from, to string) ([]string, error)

	Branches() ([]model.BranchInfo, error)
	RemoteURL() string

	Grep(pattern, commit, path string, caseInsensitive, fixed bool, maxResults int) ([]model.GrepMatch, error)
	Blame(commit, path string, lineStart, lineEnd int) ([]model.BlameLine, error)
	OriginSuggestion(file, commitish string, lineStart, lineEnd int) (*model.OriginSuggestion, error)

	PinCommit(sha string) error
	UnpinCommit(sha string) error
	ListPinnedCommits() ([]string, error)
}
