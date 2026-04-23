package git

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"time"

	"bench/internal/model"
)

const gitTimeout = 10 * time.Second

// CLIBackend shells out to the `git` binary. This is the original backend and
// stays in-tree as a fallback for at least one release after go-git is
// default.
type CLIBackend struct {
	path string
}

// NewCLIBackend returns a CLI-backed Backend rooted at path.
func NewCLIBackend(path string) *CLIBackend {
	return &CLIBackend{path: path}
}

// gitExitError carries the exit code alongside the command output so callers
// can distinguish "no matches" (exit 1) from real failures without re-parsing
// the error string.
type gitExitError struct {
	cmd    string
	stderr string
	code   int
}

func (e *gitExitError) Error() string {
	if e.stderr != "" {
		return fmt.Sprintf("git %s: %s", e.cmd, e.stderr)
	}
	return fmt.Sprintf("git %s: exit %d", e.cmd, e.code)
}

// looksLikeUnknownRef inspects git's stderr for the well-known phrasings it
// uses when a revision doesn't resolve.
func looksLikeUnknownRef(stderr string) bool {
	s := strings.ToLower(stderr)
	return strings.Contains(s, "unknown revision") ||
		strings.Contains(s, "bad revision") ||
		strings.Contains(s, "not a valid object") ||
		strings.Contains(s, "not a valid commit name") ||
		strings.Contains(s, "not a tree object") ||
		strings.Contains(s, "does not exist") ||
		strings.Contains(s, "ambiguous argument") ||
		strings.Contains(s, "exists on disk, but not in")
}

// classifyRefErr wraps ErrUnknownRef when the underlying exit error indicates
// the ref couldn't be resolved, leaving other failures untouched.
func classifyRefErr(err error) error {
	var exitErr *gitExitError
	if errors.As(err, &exitErr) && looksLikeUnknownRef(exitErr.stderr) {
		return fmt.Errorf("%w: %s", ErrUnknownRef, exitErr.stderr)
	}
	return err
}

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

func (b *CLIBackend) run(args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), gitTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", append([]string{"-C", b.path}, args...)...)
	out, err := cmd.Output()
	if err != nil {
		if ctx.Err() != nil {
			return "", fmt.Errorf("git %s: timed out after %s", args[0], gitTimeout)
		}
		if exitErr, ok := err.(*exec.ExitError); ok {
			return "", &gitExitError{cmd: args[0], stderr: strings.TrimSpace(string(exitErr.Stderr)), code: exitErr.ExitCode()}
		}
		return "", fmt.Errorf("git %s: %w", args[0], err)
	}
	return string(out), nil
}

func (b *CLIBackend) Log(limit int) ([]model.CommitInfo, error) {
	if limit <= 0 {
		limit = 50
	}
	out, err := b.run("log", "--format=%H%n%h%n%an%n%aI%n%s", "-n", strconv.Itoa(limit))
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

func (b *CLIBackend) LogRange(from, to, path string, limit int) ([]model.CommitInfo, error) {
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

	args := []string{"log", "--format=%H%n%h%n%an%n%aI%n%s", "-n", strconv.Itoa(limit)}
	if from != "" {
		args = append(args, from+".."+to)
	} else {
		args = append(args, to)
	}
	if path != "" {
		args = append(args, "--", path)
	}

	out, err := b.run(args...)
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

func (b *CLIBackend) Branches() ([]model.BranchInfo, error) {
	// Use full %(refname) so we can reliably distinguish local (refs/heads/*)
	// from remote tracking refs (refs/remotes/*) — short names alone are ambiguous
	// when local branches contain '/'.
	out, err := b.run("branch", "-a", "--format=%(refname)\t%(objectname:short)\t%(HEAD)")
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

func (b *CLIBackend) Graph(limit int) ([]model.GraphCommit, error) {
	if limit <= 0 {
		limit = 100
	}
	out, err := b.run("log", "--all", "--topo-order",
		"--format=%H%x00%h%x00%an%x00%aI%x00%s%x00%P%x00%D",
		"-n", strconv.Itoa(limit))
	if err != nil {
		return nil, err
	}
	remoteSet := map[string]bool{}
	if remotesOut, err := b.run("remote"); err == nil {
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

func (b *CLIBackend) RemoteURL() string {
	out, err := b.run("remote", "get-url", "origin")
	if err != nil {
		return ""
	}
	return strings.TrimSpace(out)
}

func (b *CLIBackend) Tree(commitish string) ([]model.FileEntry, error) {
	if err := validateRef(commitish); err != nil {
		return nil, err
	}
	out, err := b.run("ls-tree", "-r", "--name-only", commitish)
	if err != nil {
		return nil, classifyRefErr(err)
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

func (b *CLIBackend) Show(commitish, path string) (string, error) {
	if err := validateRef(commitish); err != nil {
		return "", err
	}
	if err := validatePath(path); err != nil {
		return "", err
	}
	out, err := b.run("show", commitish+":"+path)
	if err != nil {
		return "", classifyRefErr(err)
	}
	return out, nil
}

func (b *CLIBackend) Diff(from, to, path string) (*model.DiffResult, error) {
	if err := validateRef(from); err != nil {
		return nil, err
	}
	if err := validateRef(to); err != nil {
		return nil, err
	}
	if err := validatePath(path); err != nil {
		return nil, err
	}
	raw, err := b.run("diff", from+".."+to, "--", path)
	if err != nil {
		return nil, classifyRefErr(err)
	}
	fullContent, err := b.Show(to, path)
	if err != nil {
		return nil, err
	}
	return &model.DiffResult{Raw: raw, FullContent: fullContent}, nil
}

func (b *CLIBackend) Head() (string, error) {
	out, err := b.run("rev-parse", "HEAD")
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(out), nil
}

func (b *CLIBackend) DefaultBranch() string {
	if out, err := b.run("symbolic-ref", "--short", "refs/remotes/origin/HEAD"); err == nil {
		name := strings.TrimSpace(out)
		if strings.HasPrefix(name, "origin/") {
			name = name[len("origin/"):]
		}
		if name != "" {
			return name
		}
	}
	if _, err := b.run("rev-parse", "--verify", "refs/heads/main"); err == nil {
		return "main"
	}
	if _, err := b.run("rev-parse", "--verify", "refs/heads/master"); err == nil {
		return "master"
	}
	if out, err := b.run("rev-parse", "--abbrev-ref", "HEAD"); err == nil {
		if name := strings.TrimSpace(out); name != "" && name != "HEAD" {
			return name
		}
	}
	return "main"
}

func (b *CLIBackend) BranchTip(branch string) (string, error) {
	if err := validateRef(branch); err != nil {
		return "", err
	}
	out, err := b.run("rev-parse", "refs/heads/"+branch)
	if err != nil {
		return "", fmt.Errorf("branch %q not found", branch)
	}
	return strings.TrimSpace(out), nil
}

func (b *CLIBackend) ResolveRef(ref string) (string, error) {
	if err := validateRef(ref); err != nil {
		return "", err
	}
	out, err := b.run("rev-parse", ref)
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(out), nil
}

func (b *CLIBackend) RevList(from, to string) ([]string, error) {
	if err := validateRef(from); err != nil {
		return nil, err
	}
	if err := validateRef(to); err != nil {
		return nil, err
	}
	out, err := b.run("rev-list", "--reverse", from+".."+to)
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

func (b *CLIBackend) IsAncestor(ancestor, descendant string) (bool, error) {
	if err := validateRef(ancestor); err != nil {
		return false, err
	}
	if err := validateRef(descendant); err != nil {
		return false, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), gitTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", "-C", b.path, "merge-base", "--is-ancestor", ancestor, descendant)
	// cmd.Run() doesn't populate ExitError.Stderr — we have to capture it
	// explicitly. Without this, unknown-ref fatals surface as a bare
	// "git merge-base --is-ancestor: " with no classification.
	var stderrBuf strings.Builder
	cmd.Stderr = &stderrBuf
	err := cmd.Run()
	if ctx.Err() != nil {
		return false, fmt.Errorf("git merge-base --is-ancestor: timed out after %s", gitTimeout)
	}
	if err == nil {
		return true, nil
	}
	stderr := strings.TrimSpace(stderrBuf.String())
	if exitErr, ok := err.(*exec.ExitError); ok {
		if exitErr.ExitCode() == 1 {
			return false, nil
		}
		if looksLikeUnknownRef(stderr) {
			return false, fmt.Errorf("%w: %s", ErrUnknownRef, stderr)
		}
		return false, fmt.Errorf("git merge-base --is-ancestor: %s", stderr)
	}
	return false, fmt.Errorf("git merge-base --is-ancestor: %w", err)
}

func (b *CLIBackend) MergeBase(a, c string) (string, error) {
	if err := validateRef(a); err != nil {
		return "", err
	}
	if err := validateRef(c); err != nil {
		return "", err
	}
	out, err := b.run("merge-base", a, c)
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(out), nil
}

func (b *CLIBackend) DiffRaw(from, to, path string) (string, error) {
	if err := validateRef(from); err != nil {
		return "", err
	}
	if err := validateRef(to); err != nil {
		return "", err
	}
	if err := validatePath(path); err != nil {
		return "", err
	}
	return b.run("diff", from+".."+to, "--", path)
}

func (b *CLIBackend) DetectRename(from, to, path string) (string, error) {
	if err := validateRef(from); err != nil {
		return "", err
	}
	if err := validateRef(to); err != nil {
		return "", err
	}
	if err := validatePath(path); err != nil {
		return "", err
	}
	out, err := b.run("diff", "--diff-filter=R", "--name-status", "-M", from+".."+to)
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

func (b *CLIBackend) Grep(pattern, commit, path string, caseInsensitive, fixed bool, maxResults int) ([]model.GrepMatch, error) {
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

	out, err := b.run(args...)
	if err != nil {
		var exitErr *gitExitError
		if errors.As(err, &exitErr) && exitErr.code == 1 {
			return nil, nil
		}
		return nil, err
	}

	var matches []model.GrepMatch
	for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
		if line == "" {
			continue
		}
		var file, text string
		var lineNum int
		remaining := line
		if commit != "" {
			idx := strings.Index(remaining, ":")
			if idx < 0 {
				continue
			}
			remaining = remaining[idx+1:]
		}
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

func (b *CLIBackend) Blame(commit, path string, lineStart, lineEnd int) ([]model.BlameLine, error) {
	if commit == "" {
		commit = "HEAD"
	}
	if err := validateRef(commit); err != nil {
		return nil, err
	}
	if err := validatePath(path); err != nil {
		return nil, err
	}

	args := []string{"blame", "--porcelain"}
	if lineStart > 0 && lineEnd > 0 {
		args = append(args, fmt.Sprintf("-L%d,%d", lineStart, lineEnd))
	}
	args = append(args, commit, "--", path)

	out, err := b.run(args...)
	if err != nil {
		return nil, err
	}

	// Parse porcelain format: blocks start with "<hash> <orig> <final> [<count>]"
	// followed by headers, terminated by a tab-prefixed content line. Headers
	// for the same commit are only emitted once, hence the cache.
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
		parts := strings.Fields(line)
		if len(parts) < 3 || len(parts[0]) < 40 {
			i++
			continue
		}
		hash := parts[0]
		finalLine, _ := strconv.Atoi(parts[2])
		i++

		info, known := cache[hash]
		if !known {
			info = &commitInfo{}
			cache[hash] = info
		}
		var contentText string
		for i < len(lines) {
			if strings.HasPrefix(lines[i], "\t") {
				contentText = lines[i][1:]
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

func (b *CLIBackend) PinCommit(sha string) error {
	sha = strings.ToLower(strings.TrimSpace(sha))
	if !shaRe.MatchString(sha) {
		return fmt.Errorf("PinCommit: expected 40-hex sha, got %q", sha)
	}
	// cat-file -e verifies the object exists; otherwise update-ref would
	// happily create a dangling keep ref.
	if _, err := b.run("cat-file", "-e", sha); err != nil {
		return fmt.Errorf("%w: %s", ErrUnknownRef, sha)
	}
	if _, err := b.run("update-ref", KeepRefPrefix+sha, sha); err != nil {
		return fmt.Errorf("pin %s: %w", sha, err)
	}
	return nil
}

func (b *CLIBackend) UnpinCommit(sha string) error {
	sha = strings.ToLower(strings.TrimSpace(sha))
	if !shaRe.MatchString(sha) {
		return fmt.Errorf("UnpinCommit: expected 40-hex sha, got %q", sha)
	}
	_, err := b.run("update-ref", "-d", KeepRefPrefix+sha)
	if err != nil {
		var exitErr *gitExitError
		if errors.As(err, &exitErr) && strings.Contains(strings.ToLower(exitErr.stderr), "no such ref") {
			return nil
		}
		return fmt.Errorf("unpin %s: %w", sha, err)
	}
	return nil
}

func (b *CLIBackend) ListPinnedCommits() ([]string, error) {
	out, err := b.run("for-each-ref", "--format=%(refname)", KeepRefPrefix)
	if err != nil {
		return nil, err
	}
	var shas []string
	for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, KeepRefPrefix) {
			continue
		}
		shas = append(shas, strings.TrimPrefix(line, KeepRefPrefix))
	}
	return shas, nil
}

func (b *CLIBackend) DiffFiles(from, to string) ([]string, error) {
	if err := validateRef(from); err != nil {
		return nil, err
	}
	if err := validateRef(to); err != nil {
		return nil, err
	}
	out, err := b.run("diff", "--name-only", from+".."+to)
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

func (b *CLIBackend) DiffStat(from, to string) ([]model.FileStat, error) {
	if err := validateRef(from); err != nil {
		return nil, err
	}
	if err := validateRef(to); err != nil {
		return nil, err
	}
	out, err := b.run("diff", "--numstat", from+".."+to)
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
