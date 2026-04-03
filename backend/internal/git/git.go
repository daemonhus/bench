package git

import (
	"fmt"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"bench/internal/model"
)

var validRef = regexp.MustCompile(`^[a-zA-Z0-9_.^~/-]+$`)

// Repo wraps git CLI operations for a local repository.
type Repo struct {
	path string
}

func NewRepo(path string) *Repo {
	return &Repo{path: path}
}

// Name returns the repository directory name (last path component).
func (r *Repo) Name() string {
	abs, err := filepath.Abs(r.path)
	if err != nil {
		return filepath.Base(r.path)
	}
	return filepath.Base(abs)
}

func (r *Repo) validateRef(ref string) error {
	if !validRef.MatchString(ref) {
		return fmt.Errorf("invalid git ref: %q", ref)
	}
	return nil
}

func (r *Repo) validatePath(p string) error {
	if strings.HasPrefix(p, "-") {
		return fmt.Errorf("invalid path: %q", p)
	}
	return nil
}

func (r *Repo) run(args ...string) (string, error) {
	cmd := exec.Command("git", append([]string{"-C", r.path}, args...)...)
	out, err := cmd.Output()
	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			return "", fmt.Errorf("git %s: %s", args[0], string(exitErr.Stderr))
		}
		return "", fmt.Errorf("git %s: %w", args[0], err)
	}
	return string(out), nil
}

// Log returns the most recent commits.
func (r *Repo) Log(limit int) ([]model.CommitInfo, error) {
	if limit <= 0 {
		limit = 50
	}
	out, err := r.run("log", "--format=%H%n%h%n%an%n%aI%n%s", "-n", strconv.Itoa(limit))
	if err != nil {
		return nil, err
	}
	lines := strings.Split(strings.TrimSpace(out), "\n")
	var commits []model.CommitInfo
	for i := 0; i+4 < len(lines); i += 5 {
		commits = append(commits, model.CommitInfo{
			Hash:      lines[i],
			ShortHash: lines[i+1],
			Author:    lines[i+2],
			Date:      lines[i+3],
			Subject:   lines[i+4],
		})
	}
	return commits, nil
}

// LogRange returns commits between from (exclusive) and to (inclusive),
// optionally filtered to those touching path. If from is empty, returns
// all ancestors of to. Uses the same CommitInfo format as Log.
func (r *Repo) LogRange(from, to, path string, limit int) ([]model.CommitInfo, error) {
	if to == "" {
		to = "HEAD"
	}
	if err := r.validateRef(to); err != nil {
		return nil, err
	}
	if from != "" {
		if err := r.validateRef(from); err != nil {
			return nil, err
		}
	}
	if path != "" {
		if err := r.validatePath(path); err != nil {
			return nil, err
		}
	}
	if limit <= 0 {
		limit = 100
	}

	args := []string{"log", "--format=%H%n%h%n%an%n%aI%n%s", "-n", strconv.Itoa(limit)}
	if from != "" {
		args = append(args, from+".."+to)
	} else {
		args = append(args, to)
	}
	if path != "" {
		args = append(args, "--", path)
	}

	out, err := r.run(args...)
	if err != nil {
		return nil, err
	}
	trimmed := strings.TrimSpace(out)
	if trimmed == "" {
		return nil, nil
	}
	lines := strings.Split(trimmed, "\n")
	var commits []model.CommitInfo
	for i := 0; i+4 < len(lines); i += 5 {
		commits = append(commits, model.CommitInfo{
			Hash:      lines[i],
			ShortHash: lines[i+1],
			Author:    lines[i+2],
			Date:      lines[i+3],
			Subject:   lines[i+4],
		})
	}
	return commits, nil
}

// Branches returns all local and remote branches.
func (r *Repo) Branches() ([]model.BranchInfo, error) {
	// Use full %(refname) so we can reliably distinguish local (refs/heads/*)
	// from remote tracking refs (refs/remotes/*) — short names alone are ambiguous
	// when local branches contain '/'.
	out, err := r.run("branch", "-a", "--format=%(refname)\t%(objectname:short)\t%(HEAD)")
	if err != nil {
		return nil, err
	}
	var branches []model.BranchInfo
	for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
		if line == "" {
			continue
		}
		parts := strings.SplitN(line, "\t", 3)
		if len(parts) < 3 {
			continue
		}
		refname := parts[0]
		isRemote := strings.HasPrefix(refname, "refs/remotes/")
		name := strings.TrimPrefix(refname, "refs/heads/")
		if isRemote {
			name = strings.TrimPrefix(refname, "refs/remotes/")
		}
		branches = append(branches, model.BranchInfo{
			Name:      name,
			Head:      parts[1],
			IsCurrent: strings.TrimSpace(parts[2]) == "*",
			IsRemote:  isRemote,
		})
	}
	return branches, nil
}

// Graph returns commits with parent and ref information for graph rendering.
func (r *Repo) Graph(limit int) ([]model.GraphCommit, error) {
	if limit <= 0 {
		limit = 100
	}
	// %H=hash %h=short %an=author %aI=date %s=subject %P=parents %D=refs
	// Using NUL (%x00) as field separator
	out, err := r.run("log", "--all", "--topo-order",
		"--format=%H%x00%h%x00%an%x00%aI%x00%s%x00%P%x00%D",
		"-n", strconv.Itoa(limit))
	if err != nil {
		return nil, err
	}
	// Build remote name set so we can skip remote-tracking refs in %D output.
	remoteSet := map[string]bool{}
	if remotesOut, err := r.run("remote"); err == nil {
		for _, name := range strings.Fields(remotesOut) {
			remoteSet[name] = true
		}
	}

	var commits []model.GraphCommit
	for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
		if line == "" {
			continue
		}
		parts := strings.SplitN(line, "\x00", 7)
		if len(parts) < 7 {
			continue
		}
		var parents []string
		if parts[5] != "" {
			parents = strings.Split(parts[5], " ")
		}
		var refs []string
		if parts[6] != "" {
			for _, ref := range strings.Split(parts[6], ", ") {
				ref = strings.TrimSpace(ref)
				ref = strings.TrimPrefix(ref, "HEAD -> ")
				if ref == "" || ref == "HEAD" {
					continue
				}
				// Skip remote-tracking refs: "origin/main", "origin/HEAD", or bare "origin"
				prefix := strings.SplitN(ref, "/", 2)[0]
				if remoteSet[prefix] {
					continue
				}
				refs = append(refs, ref)
			}
		}
		commits = append(commits, model.GraphCommit{
			Hash:      parts[0],
			ShortHash: parts[1],
			Author:    parts[2],
			Date:      parts[3],
			Subject:   parts[4],
			Parents:   parents,
			Refs:      refs,
		})
	}
	return commits, nil
}

// RemoteURL returns the URL of the "origin" remote, or empty string if none.
func (r *Repo) RemoteURL() string {
	out, err := r.run("remote", "get-url", "origin")
	if err != nil {
		return ""
	}
	return strings.TrimSpace(out)
}

// Tree lists files at a given commit.
func (r *Repo) Tree(commitish string) ([]model.FileEntry, error) {
	if err := r.validateRef(commitish); err != nil {
		return nil, err
	}
	out, err := r.run("ls-tree", "-r", "--name-only", commitish)
	if err != nil {
		return nil, err
	}
	entries := []model.FileEntry{}
	for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
		if line == "" {
			continue
		}
		entries = append(entries, model.FileEntry{Path: line, Type: "blob"})
	}
	return entries, nil
}

// Show returns the content of a file at a given commit.
func (r *Repo) Show(commitish, path string) (string, error) {
	if err := r.validateRef(commitish); err != nil {
		return "", err
	}
	if err := r.validatePath(path); err != nil {
		return "", err
	}
	return r.run("show", commitish+":"+path)
}

// Diff returns the unified diff between two refs for a given path.
func (r *Repo) Diff(from, to, path string) (*model.DiffResult, error) {
	if err := r.validateRef(from); err != nil {
		return nil, err
	}
	if err := r.validateRef(to); err != nil {
		return nil, err
	}
	if err := r.validatePath(path); err != nil {
		return nil, err
	}
	raw, err := r.run("diff", from+".."+to, "--", path)
	if err != nil {
		return nil, err
	}
	fullContent, err := r.Show(to, path)
	if err != nil {
		return nil, err
	}
	return &model.DiffResult{Raw: raw, FullContent: fullContent}, nil
}

// Head returns the full hash of the current HEAD commit.
func (r *Repo) Head() (string, error) {
	out, err := r.run("rev-parse", "HEAD")
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(out), nil
}

// DefaultBranch returns the name of the default branch (e.g. "main" or "master").
// It tries origin/HEAD first, then falls back to checking if "main" or "master" exist.
func (r *Repo) DefaultBranch() string {
	// Try symbolic-ref of origin/HEAD
	if out, err := r.run("symbolic-ref", "--short", "refs/remotes/origin/HEAD"); err == nil {
		name := strings.TrimSpace(out)
		// Strip "origin/" prefix
		if strings.HasPrefix(name, "origin/") {
			name = name[len("origin/"):]
		}
		if name != "" {
			return name
		}
	}

	// Fallback: check if "main" exists, then "master"
	if _, err := r.run("rev-parse", "--verify", "refs/heads/main"); err == nil {
		return "main"
	}
	if _, err := r.run("rev-parse", "--verify", "refs/heads/master"); err == nil {
		return "master"
	}

	// Last resort: current branch
	if out, err := r.run("rev-parse", "--abbrev-ref", "HEAD"); err == nil {
		if name := strings.TrimSpace(out); name != "" && name != "HEAD" {
			return name
		}
	}
	return "main"
}

// BranchTip returns the full commit hash at the tip of a named branch.
func (r *Repo) BranchTip(branch string) (string, error) {
	if err := r.validateRef(branch); err != nil {
		return "", err
	}
	out, err := r.run("rev-parse", "refs/heads/"+branch)
	if err != nil {
		return "", fmt.Errorf("branch %q not found", branch)
	}
	return strings.TrimSpace(out), nil
}

// ResolveRef resolves any ref (short hash, branch, tag) to its full 40-char hash.
func (r *Repo) ResolveRef(ref string) (string, error) {
	if err := r.validateRef(ref); err != nil {
		return "", err
	}
	out, err := r.run("rev-parse", ref)
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(out), nil
}

// RevList returns commit hashes between from (exclusive) and to (inclusive),
// in chronological order (oldest first).
func (r *Repo) RevList(from, to string) ([]string, error) {
	if err := r.validateRef(from); err != nil {
		return nil, err
	}
	if err := r.validateRef(to); err != nil {
		return nil, err
	}
	out, err := r.run("rev-list", "--reverse", from+".."+to)
	if err != nil {
		return nil, err
	}
	var commits []string
	for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
		if line != "" {
			commits = append(commits, line)
		}
	}
	return commits, nil
}

// IsAncestor returns true if ancestor is an ancestor of descendant.
// Uses git merge-base --is-ancestor which returns exit code 0 (yes) or 1 (no).
func (r *Repo) IsAncestor(ancestor, descendant string) (bool, error) {
	if err := r.validateRef(ancestor); err != nil {
		return false, err
	}
	if err := r.validateRef(descendant); err != nil {
		return false, err
	}
	cmd := exec.Command("git", "-C", r.path, "merge-base", "--is-ancestor", ancestor, descendant)
	err := cmd.Run()
	if err == nil {
		return true, nil
	}
	if exitErr, ok := err.(*exec.ExitError); ok {
		if exitErr.ExitCode() == 1 {
			return false, nil // not an ancestor, but not an error
		}
		return false, fmt.Errorf("git merge-base --is-ancestor: %s", string(exitErr.Stderr))
	}
	return false, fmt.Errorf("git merge-base --is-ancestor: %w", err)
}

// MergeBase returns the best common ancestor of two commits.
func (r *Repo) MergeBase(a, b string) (string, error) {
	if err := r.validateRef(a); err != nil {
		return "", err
	}
	if err := r.validateRef(b); err != nil {
		return "", err
	}
	out, err := r.run("merge-base", a, b)
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(out), nil
}

// DiffRaw returns just the raw unified diff between two refs for a path.
// Unlike Diff(), does not fetch fullContent — lighter for reconciliation.
func (r *Repo) DiffRaw(from, to, path string) (string, error) {
	if err := r.validateRef(from); err != nil {
		return "", err
	}
	if err := r.validateRef(to); err != nil {
		return "", err
	}
	if err := r.validatePath(path); err != nil {
		return "", err
	}
	return r.run("diff", from+".."+to, "--", path)
}

// DetectRename checks if path was renamed between two refs.
// Returns the new path if renamed, empty string if not.
func (r *Repo) DetectRename(from, to, path string) (string, error) {
	if err := r.validateRef(from); err != nil {
		return "", err
	}
	if err := r.validateRef(to); err != nil {
		return "", err
	}
	if err := r.validatePath(path); err != nil {
		return "", err
	}
	out, err := r.run("diff", "--diff-filter=R", "--name-status", "-M", from+".."+to)
	if err != nil {
		return "", err
	}
	if out == "" {
		return "", nil
	}
	for _, line := range strings.Split(out, "\n") {
		parts := strings.Split(line, "\t")
		if len(parts) >= 3 && strings.HasPrefix(parts[0], "R") && parts[1] == path {
			return parts[2], nil
		}
	}
	return "", nil
}

// Grep searches file contents using git grep.
func (r *Repo) Grep(pattern, commit, path string, caseInsensitive, fixed bool, maxResults int) ([]model.GrepMatch, error) {
	if commit != "" {
		if err := r.validateRef(commit); err != nil {
			return nil, err
		}
	}
	if path != "" {
		if err := r.validatePath(path); err != nil {
			return nil, err
		}
	}

	args := []string{"grep", "-n", "--no-color"}
	if fixed {
		args = append(args, "-F")
	} else {
		args = append(args, "-E")
	}
	if caseInsensitive {
		args = append(args, "-i")
	}
	args = append(args, "-e", pattern)
	if commit != "" {
		args = append(args, commit)
	}
	if path != "" {
		args = append(args, "--", path)
	}

	out, err := r.run(args...)
	if err != nil {
		// git grep exits 1 when no matches — not an error
		if exitErr, ok := err.(*exec.ExitError); ok && exitErr.ExitCode() == 1 {
			return nil, nil
		}
		return nil, err
	}

	var matches []model.GrepMatch
	for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
		if line == "" {
			continue
		}
		// With commit: "commit:file:line:text", without: "file:line:text"
		var file, text string
		var lineNum int
		remaining := line
		if commit != "" {
			// Skip "commit:" prefix
			idx := strings.Index(remaining, ":")
			if idx < 0 {
				continue
			}
			remaining = remaining[idx+1:]
		}
		// Parse "file:line:text"
		idx := strings.Index(remaining, ":")
		if idx < 0 {
			continue
		}
		file = remaining[:idx]
		remaining = remaining[idx+1:]
		idx = strings.Index(remaining, ":")
		if idx < 0 {
			continue
		}
		lineNum, err = strconv.Atoi(remaining[:idx])
		if err != nil {
			continue
		}
		text = remaining[idx+1:]

		matches = append(matches, model.GrepMatch{File: file, Line: lineNum, Text: text})
		if maxResults > 0 && len(matches) >= maxResults {
			break
		}
	}
	return matches, nil
}

// Blame returns git blame output for a file, optionally scoped to a line range.
func (r *Repo) Blame(commit, path string, lineStart, lineEnd int) ([]model.BlameLine, error) {
	if commit == "" {
		commit = "HEAD"
	}
	if err := r.validateRef(commit); err != nil {
		return nil, err
	}
	if err := r.validatePath(path); err != nil {
		return nil, err
	}

	args := []string{"blame", "--porcelain"}
	if lineStart > 0 && lineEnd > 0 {
		args = append(args, fmt.Sprintf("-L%d,%d", lineStart, lineEnd))
	}
	args = append(args, commit, "--", path)

	out, err := r.run(args...)
	if err != nil {
		return nil, err
	}

	// Parse porcelain format: blocks start with "<hash> <orig-line> <final-line> [<num-lines>]"
	// followed by header lines, terminated by a tab-prefixed content line.
	// Headers for the same commit are only emitted once.
	type commitInfo struct {
		author string
		date   string
	}
	cache := make(map[string]*commitInfo)
	var results []model.BlameLine

	lines := strings.Split(out, "\n")
	i := 0
	for i < len(lines) {
		line := lines[i]
		if line == "" {
			i++
			continue
		}
		// Parse "<hash> <orig> <final> [<count>]"
		parts := strings.Fields(line)
		if len(parts) < 3 || len(parts[0]) < 40 {
			i++
			continue
		}
		hash := parts[0]
		finalLine, _ := strconv.Atoi(parts[2])
		i++

		// Read header lines until we hit a tab-prefixed content line
		info, known := cache[hash]
		if !known {
			info = &commitInfo{}
			cache[hash] = info
		}
		var contentText string
		for i < len(lines) {
			if strings.HasPrefix(lines[i], "\t") {
				contentText = lines[i][1:] // strip leading tab
				i++
				break
			}
			if strings.HasPrefix(lines[i], "author ") {
				info.author = strings.TrimPrefix(lines[i], "author ")
			} else if strings.HasPrefix(lines[i], "author-time ") {
				info.date = strings.TrimPrefix(lines[i], "author-time ")
			}
			i++
		}

		results = append(results, model.BlameLine{
			CommitHash: hash[:7],
			Author:     info.author,
			AuthorDate: info.date,
			Line:       finalLine,
			Text:       contentText,
		})
	}
	return results, nil
}

// DiffFiles returns the list of file paths changed between two refs.
func (r *Repo) DiffFiles(from, to string) ([]string, error) {
	if err := r.validateRef(from); err != nil {
		return nil, err
	}
	if err := r.validateRef(to); err != nil {
		return nil, err
	}
	out, err := r.run("diff", "--name-only", from+".."+to)
	if err != nil {
		return nil, err
	}
	var files []string
	for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
		if line != "" {
			files = append(files, line)
		}
	}
	return files, nil
}

// DiffStat returns per-file line change stats between two refs.
func (r *Repo) DiffStat(from, to string) ([]model.FileStat, error) {
	if err := r.validateRef(from); err != nil {
		return nil, err
	}
	if err := r.validateRef(to); err != nil {
		return nil, err
	}
	out, err := r.run("diff", "--numstat", from+".."+to)
	if err != nil {
		return nil, err
	}
	var stats []model.FileStat
	for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
		if line == "" {
			continue
		}
		parts := strings.SplitN(line, "\t", 3)
		if len(parts) < 3 {
			continue
		}
		added, _ := strconv.Atoi(parts[0])   // "-" for binary → 0
		deleted, _ := strconv.Atoi(parts[1]) // "-" for binary → 0
		stats = append(stats, model.FileStat{
			Path:    parts[2],
			Added:   added,
			Deleted: deleted,
		})
	}
	return stats, nil
}
