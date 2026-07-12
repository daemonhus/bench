package git

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	gogit "github.com/go-git/go-git/v5"
	"github.com/go-git/go-git/v5/plumbing"
	"github.com/go-git/go-git/v5/plumbing/format/diff"
	"github.com/go-git/go-git/v5/plumbing/object"
	"github.com/go-git/go-git/v5/plumbing/storer"

	"bench/internal/model"
)

// GoGitBackend is the in-process go-git implementation of Backend. Open is
// deferred to first use; tests exercise it against repos built by the
// fixture helper.
type GoGitBackend struct {
	path string
	// repo is lazily opened on first use, guarded by openOnce so concurrent
	// first calls don't race on assignment.
	repo     *gogit.Repository
	openOnce sync.Once
	openErr  error
}

// NewGoGitBackend returns a go-git-backed Backend rooted at path.
func NewGoGitBackend(path string) *GoGitBackend {
	return &GoGitBackend{path: path}
}

func (b *GoGitBackend) open() (*gogit.Repository, error) {
	b.openOnce.Do(func() {
		r, err := gogit.PlainOpen(b.path)
		if err != nil {
			b.openErr = fmt.Errorf("gogit open %s: %w", b.path, err)
			return
		}
		b.repo = r
	})
	return b.repo, b.openErr
}

// classifyGoGitErr wraps go-git's ref/object-lookup errors as ErrUnknownRef,
// matching the CLI backend's stderr-based classification. Any other error is
// returned unchanged.
func classifyGoGitErr(err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, plumbing.ErrReferenceNotFound) ||
		errors.Is(err, plumbing.ErrObjectNotFound) ||
		errors.Is(err, object.ErrFileNotFound) ||
		errors.Is(err, object.ErrDirectoryNotFound) {
		return fmt.Errorf("%w: %s", ErrUnknownRef, err.Error())
	}
	return err
}

// resolveCommit maps a commitish to a *object.Commit. ResolveRevision can
// return a hash for non-existent objects, so the CommitObject call is what
// surfaces ErrObjectNotFound. Errors are classified as ErrUnknownRef here
// so callers don't each have to remember to do it.
func (b *GoGitBackend) resolveCommit(repo *gogit.Repository, commitish string) (*object.Commit, error) {
	h, err := repo.ResolveRevision(plumbing.Revision(commitish))
	if err != nil {
		return nil, classifyGoGitErr(err)
	}
	c, err := repo.CommitObject(*h)
	if err != nil {
		return nil, classifyGoGitErr(err)
	}
	return c, nil
}

func (b *GoGitBackend) Head() (string, error) {
	repo, err := b.open()
	if err != nil {
		return "", err
	}
	ref, err := repo.Head()
	if err != nil {
		return "", classifyGoGitErr(err)
	}
	return ref.Hash().String(), nil
}

func (b *GoGitBackend) DefaultBranch() string {
	repo, err := b.open()
	if err != nil {
		return "main"
	}
	// 1. origin/HEAD → "main" or similar (symbolic ref pointing into refs/remotes/origin/…).
	if ref, err := repo.Reference(plumbing.ReferenceName("refs/remotes/origin/HEAD"), false); err == nil {
		if ref.Type() == plumbing.SymbolicReference {
			target := ref.Target().String()
			if strings.HasPrefix(target, "refs/remotes/origin/") {
				if name := strings.TrimPrefix(target, "refs/remotes/origin/"); name != "" {
					return name
				}
			}
		}
	}
	// 2. main, then master.
	if _, err := repo.Reference(plumbing.NewBranchReferenceName("main"), false); err == nil {
		return "main"
	}
	if _, err := repo.Reference(plumbing.NewBranchReferenceName("master"), false); err == nil {
		return "master"
	}
	// 3. Whatever HEAD currently points at (skipping detached HEAD).
	if head, err := repo.Head(); err == nil {
		if name := head.Name().Short(); name != "" && name != "HEAD" {
			return name
		}
	}
	return "main"
}

func (b *GoGitBackend) BranchTip(branch string) (string, error) {
	if err := validateRef(branch); err != nil {
		return "", err
	}
	repo, err := b.open()
	if err != nil {
		return "", err
	}
	ref, err := repo.Reference(plumbing.NewBranchReferenceName(branch), true)
	if err != nil {
		// Mirror CLI: "branch %q not found" regardless of underlying cause.
		return "", fmt.Errorf("branch %q not found", branch)
	}
	return ref.Hash().String(), nil
}

func (b *GoGitBackend) ResolveRef(ref string) (string, error) {
	if err := validateRef(ref); err != nil {
		return "", err
	}
	repo, err := b.open()
	if err != nil {
		return "", err
	}
	h, err := repo.ResolveRevision(plumbing.Revision(ref))
	if err != nil {
		return "", classifyGoGitErr(err)
	}
	return h.String(), nil
}

// toCommitInfo converts an object.Commit to the shared CommitInfo shape.
// Short hash is truncated to 7 chars (matches `git log --format=%h` default);
// subject is the first line of the commit message; date uses RFC3339 which
// is the same ISO 8601 format the CLI emits via %aI.
func toCommitInfo(c *object.Commit) model.CommitInfo {
	hash := c.Hash.String()
	short := hash
	if len(short) > 7 {
		short = short[:7]
	}
	subject := c.Message
	if i := strings.Index(subject, "\n"); i >= 0 {
		subject = subject[:i]
	}
	return model.CommitInfo{
		Hash:      hash,
		ShortHash: short,
		Author:    c.Author.Name,
		Date:      c.Author.When.Format(time.RFC3339),
		Subject:   subject,
	}
}

func (b *GoGitBackend) Log(limit int) ([]model.CommitInfo, error) {
	if limit <= 0 {
		limit = 50
	}
	repo, err := b.open()
	if err != nil {
		return nil, err
	}
	head, err := repo.Head()
	if err != nil {
		return nil, classifyGoGitErr(err)
	}
	iter, err := repo.Log(&gogit.LogOptions{From: head.Hash()})
	if err != nil {
		return nil, err
	}
	defer iter.Close()
	var commits []model.CommitInfo
	err = iter.ForEach(func(c *object.Commit) error {
		if len(commits) >= limit {
			return storer.ErrStop
		}
		commits = append(commits, toCommitInfo(c))
		return nil
	})
	if err != nil {
		return nil, err
	}
	return commits, nil
}

func (b *GoGitBackend) LogRange(from, to, path string, limit int) ([]model.CommitInfo, error) {
	if to == "" {
		to = "HEAD"
	}
	if err := validateRef(to); err != nil {
		return nil, err
	}
	if from != "" {
		if err := validateRef(from); err != nil {
			return nil, err
		}
	}
	if path != "" {
		if err := validatePath(path); err != nil {
			return nil, err
		}
	}
	if limit <= 0 {
		limit = 100
	}

	repo, err := b.open()
	if err != nil {
		return nil, err
	}
	toHash, err := repo.ResolveRevision(plumbing.Revision(to))
	if err != nil {
		return nil, classifyGoGitErr(err)
	}
	var fromHash plumbing.Hash
	if from != "" {
		h, err := repo.ResolveRevision(plumbing.Revision(from))
		if err != nil {
			return nil, classifyGoGitErr(err)
		}
		fromHash = *h
	}

	opts := &gogit.LogOptions{From: *toHash}
	if path != "" {
		target := path
		opts.PathFilter = func(p string) bool { return p == target }
	}
	iter, err := repo.Log(opts)
	if err != nil {
		return nil, err
	}
	defer iter.Close()

	var commits []model.CommitInfo
	err = iter.ForEach(func(c *object.Commit) error {
		// `from` is exclusive - mirror CLI's `from..to` semantics.
		if from != "" && c.Hash == fromHash {
			return storer.ErrStop
		}
		commits = append(commits, toCommitInfo(c))
		if len(commits) >= limit {
			return storer.ErrStop
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return commits, nil
}

func (b *GoGitBackend) Graph(limit int) ([]model.GraphCommit, error) {
	if limit <= 0 {
		limit = 100
	}
	repo, err := b.open()
	if err != nil {
		return nil, err
	}

	// Build commit → []refName index. Skip HEAD and refs/remotes/*, matching
	// the CLI's %D output with the remote-prefix filter in backend_cli.go.
	refsAt := map[plumbing.Hash][]string{}
	refIter, err := repo.References()
	if err != nil {
		return nil, err
	}
	err = refIter.ForEach(func(r *plumbing.Reference) error {
		n := r.Name().String()
		if n == "HEAD" || strings.HasPrefix(n, "refs/remotes/") {
			return nil
		}
		var short string
		switch {
		case strings.HasPrefix(n, "refs/heads/"):
			short = strings.TrimPrefix(n, "refs/heads/")
		case strings.HasPrefix(n, "refs/tags/"):
			short = strings.TrimPrefix(n, "refs/tags/")
		default:
			return nil
		}
		resolved, err := repo.Reference(r.Name(), true)
		if err != nil {
			return nil //nolint:nilerr
		}
		refsAt[resolved.Hash()] = append(refsAt[resolved.Hash()], short)
		return nil
	})
	refIter.Close()
	if err != nil {
		return nil, err
	}

	iter, err := repo.Log(&gogit.LogOptions{All: true, Order: gogit.LogOrderBSF})
	if err != nil {
		return nil, err
	}
	defer iter.Close()

	var commits []model.GraphCommit
	err = iter.ForEach(func(c *object.Commit) error {
		if len(commits) >= limit {
			return storer.ErrStop
		}
		// nil when empty (matches CLI's `var parents []string` - DeepEqual
		// distinguishes nil from zero-length slices).
		var parents []string
		for _, p := range c.ParentHashes {
			parents = append(parents, p.String())
		}
		info := toCommitInfo(c)
		commits = append(commits, model.GraphCommit{
			Hash:      info.Hash,
			ShortHash: info.ShortHash,
			Author:    info.Author,
			Date:      info.Date,
			Subject:   info.Subject,
			Parents:   parents,
			Refs:      refsAt[c.Hash],
		})
		return nil
	})
	if err != nil {
		return nil, err
	}
	return commits, nil
}

// activityCommitCap bounds the log walk for Activity so a huge repo can't
// stall the endpoint; periods older than the cap's reach simply read as quiet.
const activityCommitCap = 3000

// periodStartUTC truncates t to the start of its bucket, in UTC: the day
// itself, the Monday of its week, the 1st of its month, or the 1st of January.
func periodStartUTC(t time.Time, scale string) time.Time {
	u := t.UTC()
	d := time.Date(u.Year(), u.Month(), u.Day(), 0, 0, 0, 0, time.UTC)
	switch scale {
	case "day":
		return d
	case "month":
		return time.Date(u.Year(), u.Month(), 1, 0, 0, 0, 0, time.UTC)
	case "year":
		return time.Date(u.Year(), 1, 1, 0, 0, 0, 0, time.UTC)
	default: // week
		return d.AddDate(0, 0, -int((d.Weekday()+6)%7))
	}
}

// periodAdd advances a bucket start by n periods at the given scale.
func periodAdd(t time.Time, scale string, n int) time.Time {
	switch scale {
	case "day":
		return t.AddDate(0, 0, n)
	case "month":
		return t.AddDate(0, n, 0)
	case "year":
		return t.AddDate(n, 0, 0)
	default: // week
		return t.AddDate(0, 0, 7*n)
	}
}

func (b *GoGitBackend) Activity(scale string, periods int) ([]model.ActivityBucket, error) {
	if scale != "day" && scale != "month" && scale != "year" {
		scale = "week"
	}
	if periods <= 0 {
		periods = 52
	}
	repo, err := b.open()
	if err != nil {
		return nil, err
	}
	iter, err := repo.Log(&gogit.LogOptions{All: true, Order: gogit.LogOrderCommitterTime})
	if err != nil {
		return nil, err
	}
	defer iter.Close()

	var commits []*object.Commit
	err = iter.ForEach(func(c *object.Commit) error {
		if len(commits) >= activityCommitCap {
			return storer.ErrStop
		}
		// Stash entries are working-state snapshots, not activity.
		if strings.HasPrefix(c.Message, "WIP on ") || strings.HasPrefix(c.Message, "index on ") {
			return nil
		}
		commits = append(commits, c)
		return nil
	})
	if err != nil {
		return nil, err
	}
	if len(commits) == 0 {
		return []model.ActivityBucket{}, nil
	}

	// Anchor the last bucket to the newest author date rather than the wall
	// clock, so a repo that went quiet still shows its active period instead
	// of trailing empty buckets.
	newest := commits[0].Author.When
	for _, c := range commits {
		if c.Author.When.After(newest) {
			newest = c.Author.When
		}
	}
	anchor := periodStartUTC(newest, scale)
	cutoff := periodAdd(anchor, scale, -(periods - 1))

	out := make([]model.ActivityBucket, periods)
	authorsPerBucket := make([]map[string]int, periods)
	index := map[string]int{}
	for i := range out {
		start := periodAdd(cutoff, scale, i).Format("2006-01-02")
		out[i] = model.ActivityBucket{Start: start, Authors: []model.ActivityAuthor{}}
		authorsPerBucket[i] = map[string]int{}
		index[start] = i
	}

	first := len(out) - 1 // trim leading empty buckets below
	for _, c := range commits {
		i, ok := index[periodStartUTC(c.Author.When, scale).Format("2006-01-02")]
		if !ok {
			continue // older than the window
		}
		if i < first {
			first = i
		}
		w := &out[i]
		w.Commits++
		authorsPerBucket[i][c.Author.Name]++
		if len(c.ParentHashes) > 1 {
			w.Merges++
			continue // a merge's diffstat would double-count the branch's work
		}
		if stats, err := c.Stats(); err == nil {
			for _, fs := range stats {
				w.Additions += fs.Addition
				w.Deletions += fs.Deletion
			}
		}
	}

	for i := range out {
		names := make([]string, 0, len(authorsPerBucket[i]))
		for n := range authorsPerBucket[i] {
			names = append(names, n)
		}
		sort.Slice(names, func(a, b int) bool {
			ca, cb := authorsPerBucket[i][names[a]], authorsPerBucket[i][names[b]]
			if ca != cb {
				return ca > cb
			}
			return names[a] < names[b]
		})
		for _, n := range names {
			out[i].Authors = append(out[i].Authors, model.ActivityAuthor{Name: n, Commits: authorsPerBucket[i][n]})
		}
	}
	return out[first:], nil
}

// RangeStats counts commits and merges in from..to (from exclusive), the
// same range semantics as LogRange. Stash entries are skipped.
func (b *GoGitBackend) RangeStats(from, to string) (model.RangeStats, error) {
	var stats model.RangeStats
	if to == "" {
		to = "HEAD"
	}
	if err := validateRef(to); err != nil {
		return stats, err
	}
	if from != "" {
		if err := validateRef(from); err != nil {
			return stats, err
		}
	}
	repo, err := b.open()
	if err != nil {
		return stats, err
	}
	toHash, err := repo.ResolveRevision(plumbing.Revision(to))
	if err != nil {
		return stats, classifyGoGitErr(err)
	}
	var fromHash plumbing.Hash
	if from != "" {
		h, err := repo.ResolveRevision(plumbing.Revision(from))
		if err != nil {
			return stats, classifyGoGitErr(err)
		}
		fromHash = *h
	}

	iter, err := repo.Log(&gogit.LogOptions{From: *toHash})
	if err != nil {
		return stats, err
	}
	defer iter.Close()
	const rangeStatsCap = 5000
	err = iter.ForEach(func(c *object.Commit) error {
		if from != "" && c.Hash == fromHash {
			return storer.ErrStop
		}
		if stats.Commits >= rangeStatsCap {
			return storer.ErrStop
		}
		if strings.HasPrefix(c.Message, "WIP on ") || strings.HasPrefix(c.Message, "index on ") {
			return nil
		}
		stats.Commits++
		if len(c.ParentHashes) > 1 {
			stats.Merges++
		}
		return nil
	})
	if err != nil {
		return stats, err
	}
	return stats, nil
}

// originMergeWalkCap bounds the first-parent walk when locating the merge
// that brought a commit into the mainline.
const originMergeWalkCap = 500

// OriginSuggestion derives origin context for an anchor: the blame candidate
// (newest commit touching the anchored lines), the merge that brought it to
// the mainline (whose subject usually names the branch or MR), and recent
// commits on the file.
func (b *GoGitBackend) OriginSuggestion(file, commitish string, lineStart, lineEnd int) (*model.OriginSuggestion, error) {
	lines, err := b.Blame(commitish, file, lineStart, lineEnd)
	if err != nil {
		return nil, err
	}
	if len(lines) == 0 {
		return nil, fmt.Errorf("no blame data for %s", file)
	}
	s := &model.OriginSuggestion{Origin: model.OriginCandidateFromBlame(lines)}

	repo, err := b.open()
	if err != nil {
		return nil, err
	}
	// Blame emits short hashes; resolve to the full commit.
	var intro *object.Commit
	if introHash, err := repo.ResolveRevision(plumbing.Revision(s.IntroducedCommit)); err == nil {
		s.IntroducedCommit = introHash.String()
		if c, err := repo.CommitObject(*introHash); err == nil {
			intro = c
			s.CommitSubject = toCommitInfo(c).Subject
		}
	}

	// Walk HEAD's first-parent chain for the merge that brought the
	// introducing commit in: the last chain commit that contains it whose
	// mainline parent does not.
	if intro != nil {
		if head, err := repo.Head(); err == nil {
			if cur, err := repo.CommitObject(head.Hash()); err == nil {
				if reachable, err := intro.IsAncestor(cur); err == nil && reachable {
					for steps := 0; steps < originMergeWalkCap; steps++ {
						if cur.Hash == intro.Hash || cur.NumParents() == 0 {
							break // introduced directly on the mainline
						}
						first, err := cur.Parent(0)
						if err != nil {
							break
						}
						onMainline, err := intro.IsAncestor(first)
						if err != nil {
							break
						}
						if !onMainline {
							if cur.NumParents() > 1 {
								s.MergeCommit = cur.Hash.String()
								s.MergeSubject = toCommitInfo(cur).Subject
								if branch := model.BranchFromMergeSubject(s.MergeSubject); branch != "" {
									// Where it started and what it merged to:
									// an "into y" clause wins, else the walk's
									// mainline is the default branch.
									target := model.MergeTargetFromSubject(s.MergeSubject)
									if target == "" {
										target = b.DefaultBranch()
									}
									s.Branch = model.BranchFlow(branch, target)
								}
							}
							break
						}
						cur = first
					}
				}
			}
		}
	}

	// Recent commits touching the file: what the surface looked like around
	// the time it was annotated.
	if ctxCommits, err := b.LogRange("", "HEAD", file, 5); err == nil {
		s.Context = ctxCommits
	}
	return s, nil
}

func (b *GoGitBackend) Tree(commitish string) ([]model.FileEntry, error) {
	if err := validateRef(commitish); err != nil {
		return nil, err
	}
	repo, err := b.open()
	if err != nil {
		return nil, err
	}
	commit, err := b.resolveCommit(repo, commitish)
	if err != nil {
		return nil, err
	}
	tree, err := commit.Tree()
	if err != nil {
		return nil, classifyGoGitErr(err)
	}
	entries := []model.FileEntry{}
	err = tree.Files().ForEach(func(f *object.File) error {
		entries = append(entries, model.FileEntry{Path: f.Name, Type: "blob"})
		return nil
	})
	if err != nil {
		return nil, err
	}
	return entries, nil
}

func (b *GoGitBackend) Show(commitish, path string) (string, error) {
	if err := validateRef(commitish); err != nil {
		return "", err
	}
	if err := validatePath(path); err != nil {
		return "", err
	}
	repo, err := b.open()
	if err != nil {
		return "", err
	}
	commit, err := b.resolveCommit(repo, commitish)
	if err != nil {
		return "", err
	}
	file, err := commit.File(path)
	if err != nil {
		return "", classifyGoGitErr(err)
	}
	contents, err := file.Contents()
	if err != nil {
		return "", err
	}
	return contents, nil
}

// diffTrees resolves two commitishes and returns their change set with
// rename detection enabled - mirrors the CLI's default (`diff.renames=true`)
// so a rename surfaces as one Change with both From.Name and To.Name set,
// not a delete+add pair.
func (b *GoGitBackend) diffTrees(from, to string) (object.Changes, error) {
	repo, err := b.open()
	if err != nil {
		return nil, err
	}
	fromCommit, err := b.resolveCommit(repo, from)
	if err != nil {
		return nil, err
	}
	toCommit, err := b.resolveCommit(repo, to)
	if err != nil {
		return nil, err
	}
	fromTree, err := fromCommit.Tree()
	if err != nil {
		return nil, err
	}
	toTree, err := toCommit.Tree()
	if err != nil {
		return nil, err
	}
	return object.DiffTreeWithOptions(context.Background(), fromTree, toTree, &object.DiffTreeOptions{
		DetectRenames: true,
	})
}

// patchForPath finds the single-file patch for `path` across a change set.
// Returns "" if the path wasn't touched between the two trees.
func patchForPath(changes object.Changes, path string) (string, error) {
	for _, ch := range changes {
		if ch.From.Name == path || ch.To.Name == path {
			p, err := ch.Patch()
			if err != nil {
				return "", err
			}
			return p.String(), nil
		}
	}
	return "", nil
}

func (b *GoGitBackend) Diff(from, to, path string) (*model.DiffResult, error) {
	if err := validateRef(from); err != nil {
		return nil, err
	}
	if err := validateRef(to); err != nil {
		return nil, err
	}
	if err := validatePath(path); err != nil {
		return nil, err
	}
	changes, err := b.diffTrees(from, to)
	if err != nil {
		return nil, err
	}
	raw, err := patchForPath(changes, path)
	if err != nil {
		return nil, err
	}
	// If `path` was deleted in `to`, Show errors with ErrUnknownRef - that's
	// not a failure, the diff is still the useful output. Leave FullContent
	// empty and return the raw patch.
	full, err := b.Show(to, path)
	if err != nil {
		if errors.Is(err, ErrUnknownRef) {
			full = ""
		} else {
			return nil, err
		}
	}
	return &model.DiffResult{Raw: raw, FullContent: full}, nil
}

func (b *GoGitBackend) DiffRaw(from, to, path string) (string, error) {
	if err := validateRef(from); err != nil {
		return "", err
	}
	if err := validateRef(to); err != nil {
		return "", err
	}
	if err := validatePath(path); err != nil {
		return "", err
	}
	changes, err := b.diffTrees(from, to)
	if err != nil {
		return "", err
	}
	return patchForPath(changes, path)
}

func (b *GoGitBackend) DiffFiles(from, to string) ([]string, error) {
	if err := validateRef(from); err != nil {
		return nil, err
	}
	if err := validateRef(to); err != nil {
		return nil, err
	}
	changes, err := b.diffTrees(from, to)
	if err != nil {
		return nil, err
	}
	var files []string
	for _, ch := range changes {
		// Rename detection is on, so renames emit one Change with both
		// names set. Prefer To - matches CLI's --name-only output.
		if ch.To.Name != "" {
			files = append(files, ch.To.Name)
		} else if ch.From.Name != "" {
			files = append(files, ch.From.Name)
		}
	}
	return files, nil
}

// countChunkLines counts how many lines a chunk contributes - `\n`-separated
// plus a trailing-line adjustment when the chunk doesn't end in newline
// (git's own counting behaves the same).
func countChunkLines(content string) int {
	if content == "" {
		return 0
	}
	n := strings.Count(content, "\n")
	if !strings.HasSuffix(content, "\n") {
		n++
	}
	return n
}

func (b *GoGitBackend) DiffStat(from, to string) ([]model.FileStat, error) {
	if err := validateRef(from); err != nil {
		return nil, err
	}
	if err := validateRef(to); err != nil {
		return nil, err
	}
	changes, err := b.diffTrees(from, to)
	if err != nil {
		return nil, err
	}
	var stats []model.FileStat
	for _, ch := range changes {
		patch, err := ch.Patch()
		if err != nil {
			return nil, err
		}
		var path string
		if ch.To.Name != "" {
			path = ch.To.Name
		} else {
			path = ch.From.Name
		}
		var added, deleted int
		for _, fp := range patch.FilePatches() {
			for _, chunk := range fp.Chunks() {
				switch chunk.Type() {
				case diff.Add:
					added += countChunkLines(chunk.Content())
				case diff.Delete:
					deleted += countChunkLines(chunk.Content())
				}
			}
		}
		stats = append(stats, model.FileStat{Path: path, Added: added, Deleted: deleted})
	}
	return stats, nil
}

func (b *GoGitBackend) DetectRename(from, to, path string) (string, error) {
	if err := validateRef(from); err != nil {
		return "", err
	}
	if err := validateRef(to); err != nil {
		return "", err
	}
	if err := validatePath(path); err != nil {
		return "", err
	}
	changes, err := b.diffTrees(from, to)
	if err != nil {
		return "", err
	}
	for _, ch := range changes {
		if ch.From.Name == path && ch.To.Name != "" && ch.To.Name != path {
			return ch.To.Name, nil
		}
	}
	return "", nil
}

func (b *GoGitBackend) IsAncestor(ancestor, descendant string) (bool, error) {
	if err := validateRef(ancestor); err != nil {
		return false, err
	}
	if err := validateRef(descendant); err != nil {
		return false, err
	}
	repo, err := b.open()
	if err != nil {
		return false, err
	}
	a, err := b.resolveCommit(repo, ancestor)
	if err != nil {
		return false, err
	}
	d, err := b.resolveCommit(repo, descendant)
	if err != nil {
		return false, err
	}
	return a.IsAncestor(d)
}

func (b *GoGitBackend) MergeBase(a, c string) (string, error) {
	if err := validateRef(a); err != nil {
		return "", err
	}
	if err := validateRef(c); err != nil {
		return "", err
	}
	repo, err := b.open()
	if err != nil {
		return "", err
	}
	aCommit, err := b.resolveCommit(repo, a)
	if err != nil {
		return "", err
	}
	cCommit, err := b.resolveCommit(repo, c)
	if err != nil {
		return "", err
	}
	bases, err := aCommit.MergeBase(cCommit)
	if err != nil {
		return "", err
	}
	if len(bases) == 0 {
		return "", fmt.Errorf("no merge base for %s and %s", a, c)
	}
	return bases[0].Hash.String(), nil
}

func (b *GoGitBackend) RevList(from, to string) ([]string, error) {
	if err := validateRef(from); err != nil {
		return nil, err
	}
	if err := validateRef(to); err != nil {
		return nil, err
	}
	repo, err := b.open()
	if err != nil {
		return nil, err
	}
	toHash, err := repo.ResolveRevision(plumbing.Revision(to))
	if err != nil {
		return nil, classifyGoGitErr(err)
	}
	fromHash, err := repo.ResolveRevision(plumbing.Revision(from))
	if err != nil {
		return nil, classifyGoGitErr(err)
	}
	iter, err := repo.Log(&gogit.LogOptions{From: *toHash})
	if err != nil {
		return nil, err
	}
	defer iter.Close()
	var commits []string
	err = iter.ForEach(func(c *object.Commit) error {
		if c.Hash == *fromHash {
			return storer.ErrStop
		}
		commits = append(commits, c.Hash.String())
		return nil
	})
	if err != nil {
		return nil, err
	}
	// CLI uses --reverse → oldest first; our walk is newest first.
	for i, j := 0, len(commits)-1; i < j; i, j = i+1, j-1 {
		commits[i], commits[j] = commits[j], commits[i]
	}
	return commits, nil
}

func (b *GoGitBackend) Branches() ([]model.BranchInfo, error) {
	repo, err := b.open()
	if err != nil {
		return nil, err
	}
	// Current branch name (for IsCurrent). Detached HEAD → empty string;
	// no branch will match it, so IsCurrent is correctly false everywhere.
	var currentName string
	if head, err := repo.Head(); err == nil {
		currentName = head.Name().Short()
	}

	iter, err := repo.References()
	if err != nil {
		return nil, err
	}
	defer iter.Close()

	var branches []model.BranchInfo
	err = iter.ForEach(func(r *plumbing.Reference) error {
		n := r.Name().String()
		isLocal := strings.HasPrefix(n, "refs/heads/")
		isRemote := strings.HasPrefix(n, "refs/remotes/")
		if !isLocal && !isRemote {
			return nil
		}
		var short string
		if isLocal {
			short = strings.TrimPrefix(n, "refs/heads/")
		} else {
			short = strings.TrimPrefix(n, "refs/remotes/")
		}
		// Resolve symbolic refs (e.g. refs/remotes/origin/HEAD) to the hash
		// they target - matches CLI's %(objectname:short).
		resolved, err := repo.Reference(r.Name(), true)
		if err != nil {
			return nil //nolint:nilerr // skip refs that don't resolve
		}
		hash := resolved.Hash().String()
		if len(hash) > 7 {
			hash = hash[:7]
		}
		branches = append(branches, model.BranchInfo{
			Name:      short,
			Head:      hash,
			IsCurrent: isLocal && short == currentName,
			IsRemote:  isRemote,
		})
		return nil
	})
	if err != nil {
		return nil, err
	}
	return branches, nil
}

func (b *GoGitBackend) RemoteURL() string {
	repo, err := b.open()
	if err != nil {
		return ""
	}
	remote, err := repo.Remote("origin")
	if err != nil {
		return ""
	}
	urls := remote.Config().URLs
	if len(urls) == 0 {
		return ""
	}
	return urls[0]
}

// Grep walks the tree at commit, compiles one pattern, and scans every blob
// line-by-line. CLI uses `git grep` which is parallelized natively; we do
// the same with a small worker pool. Results are unordered - the parity
// harness sorts both sides before comparing.
func (b *GoGitBackend) Grep(pattern, commit, path string, caseInsensitive, fixed bool, maxResults int) ([]model.GrepMatch, error) {
	if commit != "" {
		if err := validateRef(commit); err != nil {
			return nil, err
		}
	}
	if path != "" {
		if err := validatePath(path); err != nil {
			return nil, err
		}
	}

	expr := pattern
	if fixed {
		expr = regexp.QuoteMeta(expr)
	}
	if caseInsensitive {
		expr = "(?i)" + expr
	}
	re, err := regexp.Compile(expr)
	if err != nil {
		return nil, fmt.Errorf("gogit grep: compile pattern: %w", err)
	}

	repo, err := b.open()
	if err != nil {
		return nil, err
	}
	if commit == "" {
		commit = "HEAD"
	}
	c, err := b.resolveCommit(repo, commit)
	if err != nil {
		return nil, err
	}
	tree, err := c.Tree()
	if err != nil {
		return nil, err
	}

	type blob struct {
		path     string
		contents string
	}
	const byteCeiling = 64 * 1024 * 1024
	var scanned int64

	workers := runtime.NumCPU()
	jobs := make(chan blob, workers*2)
	results := make(chan model.GrepMatch, workers*4)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	var wg sync.WaitGroup
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for job := range jobs {
				select {
				case <-ctx.Done():
					return
				default:
				}
				lineNum := 0
				for _, line := range strings.Split(job.contents, "\n") {
					lineNum++
					if re.MatchString(line) {
						select {
						case results <- model.GrepMatch{File: job.path, Line: lineNum, Text: line}:
						case <-ctx.Done():
							return
						}
					}
				}
			}
		}()
	}

	// Feeder: walk tree.Files(), filter by path prefix, enqueue blobs.
	feedErr := make(chan error, 1)
	go func() {
		defer close(jobs)
		iter := tree.Files()
		defer iter.Close()
		feedErr <- iter.ForEach(func(f *object.File) error {
			if path != "" && !strings.HasPrefix(f.Name, path) {
				return nil
			}
			bin, err := f.IsBinary()
			if err != nil {
				return nil //nolint:nilerr
			}
			if bin {
				return nil
			}
			if scanned+f.Size > byteCeiling {
				return storer.ErrStop
			}
			scanned += f.Size
			contents, err := f.Contents()
			if err != nil {
				return nil //nolint:nilerr
			}
			select {
			case jobs <- blob{path: f.Name, contents: contents}:
			case <-ctx.Done():
				return storer.ErrStop
			}
			return nil
		})
	}()

	// Collector: drain results, enforce maxResults.
	done := make(chan struct{})
	var matches []model.GrepMatch
	go func() {
		defer close(done)
		for m := range results {
			if maxResults > 0 && len(matches) >= maxResults {
				cancel()
				continue
			}
			matches = append(matches, m)
		}
	}()

	wg.Wait()
	close(results)
	<-done
	if err := <-feedErr; err != nil && !errors.Is(err, storer.ErrStop) {
		return nil, err
	}
	return matches, nil
}

// Blame delegates to go-git's native blame. We accept the O(history) cost
// on large files - the CLI stays available via BENCH_GIT_BACKEND=cli.
func (b *GoGitBackend) Blame(commit, path string, lineStart, lineEnd int) ([]model.BlameLine, error) {
	if commit == "" {
		commit = "HEAD"
	}
	if err := validateRef(commit); err != nil {
		return nil, err
	}
	if err := validatePath(path); err != nil {
		return nil, err
	}

	repo, err := b.open()
	if err != nil {
		return nil, err
	}
	c, err := b.resolveCommit(repo, commit)
	if err != nil {
		return nil, err
	}
	result, err := gogit.Blame(c, path)
	if err != nil {
		return nil, classifyGoGitErr(err)
	}

	out := make([]model.BlameLine, 0, len(result.Lines))
	for i, line := range result.Lines {
		lineNum := i + 1
		if lineStart > 0 && lineNum < lineStart {
			continue
		}
		if lineEnd > 0 && lineNum > lineEnd {
			break
		}
		hash := line.Hash.String()
		if len(hash) > 7 {
			hash = hash[:7]
		}
		out = append(out, model.BlameLine{
			CommitHash: hash,
			Author:     line.AuthorName,
			// CLI emits the porcelain `author-time` value, a unix timestamp
			// string. Match the shape even though parity only asserts
			// Line/Text.
			AuthorDate: strconv.FormatInt(line.Date.Unix(), 10),
			Line:       lineNum,
			Text:       line.Text,
		})
	}
	return out, nil
}

func (b *GoGitBackend) PinCommit(sha string) error {
	sha = strings.ToLower(strings.TrimSpace(sha))
	if !shaRe.MatchString(sha) {
		return fmt.Errorf("PinCommit: expected 40-hex sha, got %q", sha)
	}
	repo, err := b.open()
	if err != nil {
		return err
	}
	hash := plumbing.NewHash(sha)
	if _, err := repo.CommitObject(hash); err != nil {
		if errors.Is(err, plumbing.ErrObjectNotFound) {
			return fmt.Errorf("%w: %s", ErrUnknownRef, sha)
		}
		return fmt.Errorf("pin %s: %w", sha, err)
	}
	refName := plumbing.ReferenceName(KeepRefPrefix + sha)
	if err := repo.Storer.SetReference(plumbing.NewHashReference(refName, hash)); err != nil {
		return fmt.Errorf("pin %s: %w", sha, err)
	}
	return nil
}

func (b *GoGitBackend) UnpinCommit(sha string) error {
	sha = strings.ToLower(strings.TrimSpace(sha))
	if !shaRe.MatchString(sha) {
		return fmt.Errorf("UnpinCommit: expected 40-hex sha, got %q", sha)
	}
	repo, err := b.open()
	if err != nil {
		return err
	}
	refName := plumbing.ReferenceName(KeepRefPrefix + sha)
	if err := repo.Storer.RemoveReference(refName); err != nil {
		// Missing ref is a no-op, mirroring CLI.
		if errors.Is(err, plumbing.ErrReferenceNotFound) {
			return nil
		}
		return fmt.Errorf("unpin %s: %w", sha, err)
	}
	return nil
}

func (b *GoGitBackend) ListPinnedCommits() ([]string, error) {
	repo, err := b.open()
	if err != nil {
		return nil, err
	}
	iter, err := repo.References()
	if err != nil {
		return nil, err
	}
	defer iter.Close()
	var shas []string
	err = iter.ForEach(func(r *plumbing.Reference) error {
		name := r.Name().String()
		if !strings.HasPrefix(name, KeepRefPrefix) {
			return nil
		}
		shas = append(shas, strings.TrimPrefix(name, KeepRefPrefix))
		return nil
	})
	if err != nil {
		return nil, err
	}
	return shas, nil
}

// compile-time assertion that GoGitBackend satisfies Backend.
var _ Backend = (*GoGitBackend)(nil)
