package git

import (
	"errors"
	"strings"
	"testing"
)

// These tests pin down the current CLI-backed behavior so we can swap in the
// go-git backend without silent regressions. Each test exercises at least one
// of: happy path, unknown ref, unknown path, empty result, rename case.
//
// Anywhere a backend could plausibly diverge in output shape (commit
// timestamps, blame short-hash width, etc.) the assertion is against a
// stable property - "has 3 commits", "line 2 changed to BETA" - rather than
// exact byte equality.

// The unknown-object sha is a valid 40-hex string that does not exist in any
// of our fixtures. Tests use it to force the "unknown ref" classification.
const unknownSha = "9c1acab62ae8f102e65900294a923c8baf214815"

func TestHead(t *testing.T) {
	f := newFixture(t)
	got, err := f.Repo.Head()
	if err != nil {
		t.Fatalf("Head: %v", err)
	}
	if got != f.C3 {
		t.Fatalf("Head = %s, want C3 %s", got, f.C3)
	}
}

func TestDefaultBranch(t *testing.T) {
	f := newFixture(t)
	if got := f.Repo.DefaultBranch(); got != "main" {
		t.Fatalf("DefaultBranch = %q, want main", got)
	}
}

func TestBranchTip(t *testing.T) {
	f := newFixture(t)

	got, err := f.Repo.BranchTip("feature")
	if err != nil {
		t.Fatalf("BranchTip(feature): %v", err)
	}
	if got != f.C2 {
		t.Fatalf("BranchTip(feature) = %s, want %s", got, f.C2)
	}

	if _, err := f.Repo.BranchTip("does-not-exist"); err == nil {
		t.Fatal("BranchTip(missing) expected error, got nil")
	}
}

func TestResolveRef(t *testing.T) {
	f := newFixture(t)

	got, err := f.Repo.ResolveRef("HEAD")
	if err != nil {
		t.Fatalf("ResolveRef(HEAD): %v", err)
	}
	if got != f.C3 {
		t.Fatalf("ResolveRef(HEAD) = %s, want %s", got, f.C3)
	}

	// Note: `git rev-parse <40-hex>` echoes the input without verifying the
	// object exists - so we probe with a bogus ref *name* to get a failure.
	if _, err := f.Repo.ResolveRef("no-such-branch"); err == nil {
		t.Fatal("ResolveRef(missing branch) expected error, got nil")
	}
}

func TestLog(t *testing.T) {
	f := newFixture(t)

	commits, err := f.Repo.Log(10)
	if err != nil {
		t.Fatalf("Log: %v", err)
	}
	if len(commits) != 3 {
		t.Fatalf("Log: got %d commits, want 3", len(commits))
	}
	// log is newest-first; hashes must be full 40-char sha.
	if commits[0].Hash != f.C3 || commits[1].Hash != f.C2 || commits[2].Hash != f.C1 {
		t.Fatalf("Log order = [%s %s %s], want [C3 C2 C1]", commits[0].Hash, commits[1].Hash, commits[2].Hash)
	}

	limited, err := f.Repo.Log(2)
	if err != nil {
		t.Fatalf("Log(2): %v", err)
	}
	if len(limited) != 2 {
		t.Fatalf("Log(2): got %d, want 2", len(limited))
	}
}

func TestLogRange(t *testing.T) {
	f := newFixture(t)

	// Full ancestors of HEAD - three commits.
	all, err := f.Repo.LogRange("", "HEAD", "", 0)
	if err != nil {
		t.Fatalf("LogRange all: %v", err)
	}
	if len(all) != 3 {
		t.Fatalf("LogRange all: got %d, want 3", len(all))
	}

	// C1..C3 is exclusive of C1, so two commits.
	between, err := f.Repo.LogRange(f.C1, f.C3, "", 0)
	if err != nil {
		t.Fatalf("LogRange between: %v", err)
	}
	if len(between) != 2 {
		t.Fatalf("LogRange C1..C3: got %d, want 2", len(between))
	}

	// Empty range: HEAD..HEAD has no commits.
	empty, err := f.Repo.LogRange(f.C3, f.C3, "", 0)
	if err != nil {
		t.Fatalf("LogRange empty: %v", err)
	}
	if len(empty) != 0 {
		t.Fatalf("LogRange HEAD..HEAD: got %d, want 0", len(empty))
	}

	// Path filter: c.txt was introduced in C2 only.
	pathOnly, err := f.Repo.LogRange("", "HEAD", "c.txt", 0)
	if err != nil {
		t.Fatalf("LogRange path: %v", err)
	}
	if len(pathOnly) != 1 || pathOnly[0].Hash != f.C2 {
		t.Fatalf("LogRange c.txt: got %+v, want [C2]", pathOnly)
	}
}

func TestGraph(t *testing.T) {
	f := newFixture(t)

	commits, err := f.Repo.Graph(10)
	if err != nil {
		t.Fatalf("Graph: %v", err)
	}
	if len(commits) != 3 {
		t.Fatalf("Graph: got %d commits, want 3", len(commits))
	}
	// First commit (C1) must have no parents; C2 has one parent (C1); C3 has one parent (C2).
	byHash := map[string]int{}
	for i, c := range commits {
		byHash[c.Hash] = i
	}
	if got := commits[byHash[f.C1]].Parents; len(got) != 0 {
		t.Fatalf("C1 parents: got %v, want none", got)
	}
	if got := commits[byHash[f.C2]].Parents; len(got) != 1 || got[0] != f.C1 {
		t.Fatalf("C2 parents: got %v, want [C1]", got)
	}
	// main ref should appear on C3.
	refs := commits[byHash[f.C3]].Refs
	found := false
	for _, r := range refs {
		if r == "main" {
			found = true
		}
	}
	if !found {
		t.Fatalf("C3 refs = %v, want to contain main", refs)
	}
}

func TestTree(t *testing.T) {
	f := newFixture(t)

	entries, err := f.Repo.Tree(f.C2)
	if err != nil {
		t.Fatalf("Tree(C2): %v", err)
	}
	wantPaths := map[string]bool{"a.txt": true, "dir/b.txt": true, "c.txt": true}
	got := map[string]bool{}
	for _, e := range entries {
		got[e.Path] = true
	}
	for p := range wantPaths {
		if !got[p] {
			t.Errorf("Tree(C2) missing %q (got %v)", p, entries)
		}
	}
	if len(entries) != len(wantPaths) {
		t.Errorf("Tree(C2): got %d entries, want %d", len(entries), len(wantPaths))
	}

	if _, err := f.Repo.Tree(unknownSha); !errors.Is(err, ErrUnknownRef) {
		t.Fatalf("Tree(unknown): want ErrUnknownRef, got %v", err)
	}
}

func TestShow(t *testing.T) {
	f := newFixture(t)

	got, err := f.Repo.Show(f.C2, "a.txt")
	if err != nil {
		t.Fatalf("Show: %v", err)
	}
	if got != "alpha\nBETA\n" {
		t.Fatalf("Show a.txt@C2 = %q, want %q", got, "alpha\nBETA\n")
	}

	if _, err := f.Repo.Show(unknownSha, "a.txt"); !errors.Is(err, ErrUnknownRef) {
		t.Fatalf("Show(unknown sha): want ErrUnknownRef, got %v", err)
	}

	// Unknown path at a real commit: git also returns "exists on disk, but
	// not in" or "does not exist" → classified as ErrUnknownRef.
	if _, err := f.Repo.Show(f.C2, "no-such-file.txt"); !errors.Is(err, ErrUnknownRef) {
		t.Fatalf("Show(missing path): want ErrUnknownRef, got %v", err)
	}
}

func TestDiff(t *testing.T) {
	f := newFixture(t)

	res, err := f.Repo.Diff(f.C1, f.C2, "a.txt")
	if err != nil {
		t.Fatalf("Diff: %v", err)
	}
	if !strings.Contains(res.Raw, "-beta") || !strings.Contains(res.Raw, "+BETA") {
		t.Fatalf("Diff raw missing beta→BETA transition:\n%s", res.Raw)
	}
	if res.FullContent != "alpha\nBETA\n" {
		t.Fatalf("Diff fullContent = %q, want alpha\\nBETA\\n", res.FullContent)
	}

	// Same-commit diff: empty patch, full content still present.
	same, err := f.Repo.Diff(f.C2, f.C2, "a.txt")
	if err != nil {
		t.Fatalf("Diff same: %v", err)
	}
	if same.Raw != "" {
		t.Fatalf("Diff same-commit raw = %q, want empty", same.Raw)
	}
}

func TestDiffRaw(t *testing.T) {
	f := newFixture(t)
	raw, err := f.Repo.DiffRaw(f.C1, f.C2, "a.txt")
	if err != nil {
		t.Fatalf("DiffRaw: %v", err)
	}
	if !strings.Contains(raw, "+BETA") {
		t.Fatalf("DiffRaw missing +BETA:\n%s", raw)
	}
}

func TestDiffFiles(t *testing.T) {
	f := newFixture(t)

	files, err := f.Repo.DiffFiles(f.C1, f.C2)
	if err != nil {
		t.Fatalf("DiffFiles: %v", err)
	}
	want := map[string]bool{"a.txt": true, "c.txt": true}
	for _, p := range files {
		delete(want, p)
	}
	if len(want) != 0 {
		t.Fatalf("DiffFiles C1..C2 missing %v, got %v", want, files)
	}
}

func TestDiffStat(t *testing.T) {
	f := newFixture(t)

	stats, err := f.Repo.DiffStat(f.C1, f.C2)
	if err != nil {
		t.Fatalf("DiffStat: %v", err)
	}
	byPath := map[string]struct{ a, d int }{}
	for _, s := range stats {
		byPath[s.Path] = struct{ a, d int }{s.Added, s.Deleted}
	}
	// a.txt: one line changed → 1 added, 1 deleted.
	if got := byPath["a.txt"]; got.a != 1 || got.d != 1 {
		t.Errorf("DiffStat a.txt = +%d/-%d, want +1/-1", got.a, got.d)
	}
	// c.txt: new file, 1 line.
	if got := byPath["c.txt"]; got.a != 1 || got.d != 0 {
		t.Errorf("DiffStat c.txt = +%d/-%d, want +1/-0", got.a, got.d)
	}
}

func TestDetectRename(t *testing.T) {
	f := newFixture(t)

	newPath, err := f.Repo.DetectRename(f.C2, f.C3, "a.txt")
	if err != nil {
		t.Fatalf("DetectRename: %v", err)
	}
	if newPath != "renamed.txt" {
		t.Fatalf("DetectRename a.txt: got %q, want renamed.txt", newPath)
	}

	// No rename across C1..C2 for a.txt (just a content tweak).
	noRename, err := f.Repo.DetectRename(f.C1, f.C2, "a.txt")
	if err != nil {
		t.Fatalf("DetectRename C1..C2: %v", err)
	}
	if noRename != "" {
		t.Fatalf("DetectRename C1..C2 a.txt: got %q, want empty", noRename)
	}
}

func TestIsAncestor(t *testing.T) {
	f := newFixture(t)

	yes, err := f.Repo.IsAncestor(f.C1, f.C3)
	if err != nil {
		t.Fatalf("IsAncestor: %v", err)
	}
	if !yes {
		t.Fatalf("IsAncestor(C1, C3) = false, want true")
	}

	no, err := f.Repo.IsAncestor(f.C3, f.C1)
	if err != nil {
		t.Fatalf("IsAncestor(C3, C1): %v", err)
	}
	if no {
		t.Fatalf("IsAncestor(C3, C1) = true, want false")
	}

	if _, err := f.Repo.IsAncestor(unknownSha, f.C3); !errors.Is(err, ErrUnknownRef) {
		t.Fatalf("IsAncestor(unknown): want ErrUnknownRef, got %v", err)
	}
}

func TestMergeBase(t *testing.T) {
	f := newFixture(t)

	// main (C3) and feature (C2): feature is an ancestor → base = C2.
	base, err := f.Repo.MergeBase("main", "feature")
	if err != nil {
		t.Fatalf("MergeBase: %v", err)
	}
	if base != f.C2 {
		t.Fatalf("MergeBase(main, feature) = %s, want C2 %s", base, f.C2)
	}
}

func TestRevList(t *testing.T) {
	f := newFixture(t)

	got, err := f.Repo.RevList(f.C1, f.C3)
	if err != nil {
		t.Fatalf("RevList: %v", err)
	}
	if len(got) != 2 || got[0] != f.C2 || got[1] != f.C3 {
		t.Fatalf("RevList C1..C3 = %v, want [C2 C3]", got)
	}

	empty, err := f.Repo.RevList(f.C3, f.C3)
	if err != nil {
		t.Fatalf("RevList empty: %v", err)
	}
	if len(empty) != 0 {
		t.Fatalf("RevList HEAD..HEAD: got %v, want empty", empty)
	}
}

func TestBranches(t *testing.T) {
	f := newFixture(t)

	branches, err := f.Repo.Branches()
	if err != nil {
		t.Fatalf("Branches: %v", err)
	}
	names := map[string]model_branch{}
	for _, b := range branches {
		names[b.Name] = model_branch{head: b.Head, current: b.IsCurrent, remote: b.IsRemote}
	}
	if _, ok := names["main"]; !ok {
		t.Errorf("Branches missing main: %+v", branches)
	}
	if _, ok := names["feature"]; !ok {
		t.Errorf("Branches missing feature: %+v", branches)
	}
	if !names["main"].current {
		t.Errorf("main should be current: %+v", names["main"])
	}
}

type model_branch struct {
	head    string
	current bool
	remote  bool
}

func TestRemoteURL_Empty(t *testing.T) {
	f := newFixture(t)
	// Fixture has no remote configured.
	if got := f.Repo.RemoteURL(); got != "" {
		t.Fatalf("RemoteURL = %q, want empty", got)
	}
}

func TestGrep_AtCommit(t *testing.T) {
	f := newFixture(t)

	// BETA was introduced in C2 - grep at C2 should find it, at C1 should not.
	atC2, err := f.Repo.Grep("BETA", f.C2, "", false, false, 100)
	if err != nil {
		t.Fatalf("Grep C2: %v", err)
	}
	if len(atC2) == 0 {
		t.Fatal("Grep BETA at C2: expected a match")
	}

	atC1, err := f.Repo.Grep("BETA", f.C1, "", false, false, 100)
	if err != nil {
		t.Fatalf("Grep C1: %v", err)
	}
	if len(atC1) != 0 {
		t.Fatalf("Grep BETA at C1: got %d matches, want 0", len(atC1))
	}
}

func TestBlame_SmallFile(t *testing.T) {
	f := newFixture(t)

	// a.txt at C2: line 1 ("alpha") was introduced in C1, line 2 ("BETA") in C2.
	lines, err := f.Repo.Blame(f.C2, "a.txt", 0, 0)
	if err != nil {
		t.Fatalf("Blame: %v", err)
	}
	if len(lines) != 2 {
		t.Fatalf("Blame a.txt@C2: got %d lines, want 2", len(lines))
	}
	if lines[0].Text != "alpha" || lines[1].Text != "BETA" {
		t.Fatalf("Blame text: got %q/%q, want alpha/BETA", lines[0].Text, lines[1].Text)
	}
	// Line 1 should trace back to C1's short hash; line 2 to C2's.
	if !strings.HasPrefix(f.C1, lines[0].CommitHash) {
		t.Errorf("Blame line 1 hash %q not a prefix of C1 %s", lines[0].CommitHash, f.C1)
	}
	if !strings.HasPrefix(f.C2, lines[1].CommitHash) {
		t.Errorf("Blame line 2 hash %q not a prefix of C2 %s", lines[1].CommitHash, f.C2)
	}
}
