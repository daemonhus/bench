//go:build parity

package git

import (
	"errors"
	"reflect"
	"sort"
	"testing"

	"bench/internal/model"
)

// The parity harness runs the same fixture through both backends and asserts
// they return equivalent results for every public Backend method. It's the
// contract the go-git implementation is built against.
//
// Build-tagged (`//go:build parity`) so the default `go test ./...` run
// stays green while GoGitBackend methods are still stubs. Run it with:
//
//     go test -tags=parity ./internal/git/...
//
// Expected status during M3: every subtest fails with errTODO. As methods
// are implemented in subsequent PRs, subtests flip green one at a time.

type backendPair struct {
	cli   Backend
	gogit Backend
	f     *fixture
}

func newBackendPair(t *testing.T) backendPair {
	t.Helper()
	f := newFixture(t)
	return backendPair{
		cli:   NewCLIBackend(f.Dir),
		gogit: NewGoGitBackend(f.Dir),
		f:     f,
	}
}

// eqErr reports whether two errors are equivalent for parity purposes:
// either both nil, or both non-nil. We don't require identical error
// messages — classification (e.g. errors.Is(err, ErrUnknownRef)) is asserted
// separately where it matters.
func eqErr(a, b error) bool {
	return (a == nil) == (b == nil)
}

// normalizeCommits strips fields that legitimately differ between
// backends (author timestamps below second precision, e.g.) so we can
// compare the rest.
func normalizeCommits(cs []model.CommitInfo) []model.CommitInfo {
	out := make([]model.CommitInfo, len(cs))
	for i, c := range cs {
		// Dates can differ in timezone representation ("+00:00" vs "Z") and
		// sub-second precision. Zero them — other fields are stable.
		c.Date = ""
		out[i] = c
	}
	return out
}

func TestParity_Head(t *testing.T) {
	p := newBackendPair(t)
	a, aErr := p.cli.Head()
	b, bErr := p.gogit.Head()
	if !eqErr(aErr, bErr) {
		t.Fatalf("Head errors differ: cli=%v gogit=%v", aErr, bErr)
	}
	if a != b {
		t.Fatalf("Head differs: cli=%q gogit=%q", a, b)
	}
}

func TestParity_DefaultBranch(t *testing.T) {
	p := newBackendPair(t)
	a := p.cli.DefaultBranch()
	b := p.gogit.DefaultBranch()
	if a != b {
		t.Fatalf("DefaultBranch differs: cli=%q gogit=%q", a, b)
	}
}

func TestParity_BranchTip(t *testing.T) {
	p := newBackendPair(t)
	for _, branch := range []string{"main", "feature", "does-not-exist"} {
		a, aErr := p.cli.BranchTip(branch)
		b, bErr := p.gogit.BranchTip(branch)
		if !eqErr(aErr, bErr) {
			t.Errorf("BranchTip(%q) errors differ: cli=%v gogit=%v", branch, aErr, bErr)
		}
		if a != b {
			t.Errorf("BranchTip(%q) differs: cli=%q gogit=%q", branch, a, b)
		}
	}
}

func TestParity_ResolveRef(t *testing.T) {
	p := newBackendPair(t)
	for _, ref := range []string{"HEAD", "main", "feature"} {
		a, aErr := p.cli.ResolveRef(ref)
		b, bErr := p.gogit.ResolveRef(ref)
		if !eqErr(aErr, bErr) {
			t.Errorf("ResolveRef(%q) errors differ: cli=%v gogit=%v", ref, aErr, bErr)
		}
		if a != b {
			t.Errorf("ResolveRef(%q) differs: cli=%q gogit=%q", ref, a, b)
		}
	}
}

func TestParity_Log(t *testing.T) {
	p := newBackendPair(t)
	a, aErr := p.cli.Log(10)
	b, bErr := p.gogit.Log(10)
	if !eqErr(aErr, bErr) {
		t.Fatalf("Log errors differ: cli=%v gogit=%v", aErr, bErr)
	}
	if !reflect.DeepEqual(normalizeCommits(a), normalizeCommits(b)) {
		t.Fatalf("Log differs:\ncli=%+v\ngogit=%+v", a, b)
	}
}

func TestParity_LogRange(t *testing.T) {
	p := newBackendPair(t)
	cases := []struct {
		from, to, path string
	}{
		{"", "HEAD", ""},
		{p.f.C1, p.f.C3, ""},
		{p.f.C3, p.f.C3, ""}, // empty
		{"", "HEAD", "c.txt"},
	}
	for _, c := range cases {
		a, aErr := p.cli.LogRange(c.from, c.to, c.path, 0)
		b, bErr := p.gogit.LogRange(c.from, c.to, c.path, 0)
		if !eqErr(aErr, bErr) {
			t.Errorf("LogRange(%q..%q %q) errors differ: cli=%v gogit=%v", c.from, c.to, c.path, aErr, bErr)
			continue
		}
		if !reflect.DeepEqual(normalizeCommits(a), normalizeCommits(b)) {
			t.Errorf("LogRange(%q..%q %q) differs:\ncli=%+v\ngogit=%+v", c.from, c.to, c.path, a, b)
		}
	}
}

func TestParity_Graph(t *testing.T) {
	p := newBackendPair(t)
	a, aErr := p.cli.Graph(100)
	b, bErr := p.gogit.Graph(100)
	if !eqErr(aErr, bErr) {
		t.Fatalf("Graph errors differ: cli=%v gogit=%v", aErr, bErr)
	}
	// Graph iteration order (topo/BSF/date) is allowed to differ between
	// backends. Compare as sorted sets keyed by hash, with parent order
	// preserved (git guarantees parent order by convention).
	normalize := func(cs []model.GraphCommit) []model.GraphCommit {
		out := make([]model.GraphCommit, len(cs))
		for i, c := range cs {
			c.Date = "" // RFC3339 vs %aI tz-offset differences
			sort.Strings(c.Refs)
			out[i] = c
		}
		sort.Slice(out, func(i, j int) bool { return out[i].Hash < out[j].Hash })
		return out
	}
	if !reflect.DeepEqual(normalize(a), normalize(b)) {
		t.Fatalf("Graph differs:\ncli=%+v\ngogit=%+v", a, b)
	}
}

func TestParity_Tree(t *testing.T) {
	p := newBackendPair(t)
	for _, commitish := range []string{p.f.C1, p.f.C2, p.f.C3} {
		a, aErr := p.cli.Tree(commitish)
		b, bErr := p.gogit.Tree(commitish)
		if !eqErr(aErr, bErr) {
			t.Errorf("Tree(%s) errors differ: cli=%v gogit=%v", commitish, aErr, bErr)
			continue
		}
		// Entry order isn't contractually guaranteed; compare as sets.
		normalize := func(es []model.FileEntry) []string {
			out := make([]string, len(es))
			for i, e := range es {
				out[i] = e.Path + "|" + e.Type
			}
			sort.Strings(out)
			return out
		}
		if !reflect.DeepEqual(normalize(a), normalize(b)) {
			t.Errorf("Tree(%s) differs:\ncli=%+v\ngogit=%+v", commitish, a, b)
		}
	}

	// Unknown-ref classification must match.
	_, aErr := p.cli.Tree(unknownSha)
	_, bErr := p.gogit.Tree(unknownSha)
	if errors.Is(aErr, ErrUnknownRef) != errors.Is(bErr, ErrUnknownRef) {
		t.Errorf("Tree(unknown) ErrUnknownRef classification differs: cli=%v gogit=%v", aErr, bErr)
	}
}

func TestParity_Show(t *testing.T) {
	p := newBackendPair(t)
	cases := []struct {
		commit, path string
	}{
		{p.f.C1, "a.txt"},
		{p.f.C2, "a.txt"},
		{p.f.C3, "renamed.txt"},
	}
	for _, c := range cases {
		a, aErr := p.cli.Show(c.commit, c.path)
		b, bErr := p.gogit.Show(c.commit, c.path)
		if !eqErr(aErr, bErr) {
			t.Errorf("Show(%s %s) errors differ: cli=%v gogit=%v", c.commit, c.path, aErr, bErr)
			continue
		}
		if a != b {
			t.Errorf("Show(%s %s) content differs:\ncli=%q\ngogit=%q", c.commit, c.path, a, b)
		}
	}
}

func TestParity_Diff(t *testing.T) {
	p := newBackendPair(t)
	a, aErr := p.cli.Diff(p.f.C1, p.f.C2, "a.txt")
	b, bErr := p.gogit.Diff(p.f.C1, p.f.C2, "a.txt")
	if !eqErr(aErr, bErr) {
		t.Fatalf("Diff errors differ: cli=%v gogit=%v", aErr, bErr)
	}
	// Raw diff format differs slightly between git-CLI and go-git (header
	// lines, hash width). Compare FullContent exactly; for Raw only assert
	// both are non-empty when the other is.
	if a.FullContent != b.FullContent {
		t.Errorf("Diff FullContent differs:\ncli=%q\ngogit=%q", a.FullContent, b.FullContent)
	}
	if (a.Raw == "") != (b.Raw == "") {
		t.Errorf("Diff Raw emptiness differs: cli-empty=%v gogit-empty=%v", a.Raw == "", b.Raw == "")
	}
}

func TestParity_DiffFiles(t *testing.T) {
	p := newBackendPair(t)
	a, aErr := p.cli.DiffFiles(p.f.C1, p.f.C3)
	b, bErr := p.gogit.DiffFiles(p.f.C1, p.f.C3)
	if !eqErr(aErr, bErr) {
		t.Fatalf("DiffFiles errors differ: cli=%v gogit=%v", aErr, bErr)
	}
	sort.Strings(a)
	sort.Strings(b)
	if !reflect.DeepEqual(a, b) {
		t.Fatalf("DiffFiles differs:\ncli=%v\ngogit=%v", a, b)
	}
}

func TestParity_DiffStat(t *testing.T) {
	p := newBackendPair(t)
	a, aErr := p.cli.DiffStat(p.f.C1, p.f.C2)
	b, bErr := p.gogit.DiffStat(p.f.C1, p.f.C2)
	if !eqErr(aErr, bErr) {
		t.Fatalf("DiffStat errors differ: cli=%v gogit=%v", aErr, bErr)
	}
	normalize := func(ss []model.FileStat) []model.FileStat {
		out := append([]model.FileStat(nil), ss...)
		sort.Slice(out, func(i, j int) bool { return out[i].Path < out[j].Path })
		return out
	}
	if !reflect.DeepEqual(normalize(a), normalize(b)) {
		t.Fatalf("DiffStat differs:\ncli=%+v\ngogit=%+v", a, b)
	}
}

func TestParity_DetectRename(t *testing.T) {
	p := newBackendPair(t)
	a, aErr := p.cli.DetectRename(p.f.C2, p.f.C3, "a.txt")
	b, bErr := p.gogit.DetectRename(p.f.C2, p.f.C3, "a.txt")
	if !eqErr(aErr, bErr) {
		t.Fatalf("DetectRename errors differ: cli=%v gogit=%v", aErr, bErr)
	}
	if a != b {
		t.Fatalf("DetectRename differs: cli=%q gogit=%q", a, b)
	}
}

func TestParity_IsAncestor(t *testing.T) {
	p := newBackendPair(t)
	cases := []struct {
		a, b string
	}{
		{p.f.C1, p.f.C3},
		{p.f.C3, p.f.C1},
		{p.f.C2, p.f.C2},
	}
	for _, c := range cases {
		aRes, aErr := p.cli.IsAncestor(c.a, c.b)
		bRes, bErr := p.gogit.IsAncestor(c.a, c.b)
		if !eqErr(aErr, bErr) {
			t.Errorf("IsAncestor(%s,%s) errors differ: cli=%v gogit=%v", c.a, c.b, aErr, bErr)
			continue
		}
		if aRes != bRes {
			t.Errorf("IsAncestor(%s,%s) differs: cli=%v gogit=%v", c.a, c.b, aRes, bRes)
		}
	}
}

func TestParity_MergeBase(t *testing.T) {
	p := newBackendPair(t)
	a, aErr := p.cli.MergeBase("main", "feature")
	b, bErr := p.gogit.MergeBase("main", "feature")
	if !eqErr(aErr, bErr) {
		t.Fatalf("MergeBase errors differ: cli=%v gogit=%v", aErr, bErr)
	}
	if a != b {
		t.Fatalf("MergeBase differs: cli=%q gogit=%q", a, b)
	}
}

func TestParity_RevList(t *testing.T) {
	p := newBackendPair(t)
	a, aErr := p.cli.RevList(p.f.C1, p.f.C3)
	b, bErr := p.gogit.RevList(p.f.C1, p.f.C3)
	if !eqErr(aErr, bErr) {
		t.Fatalf("RevList errors differ: cli=%v gogit=%v", aErr, bErr)
	}
	if !reflect.DeepEqual(a, b) {
		t.Fatalf("RevList differs:\ncli=%v\ngogit=%v", a, b)
	}
}

func TestParity_Branches(t *testing.T) {
	p := newBackendPair(t)
	a, aErr := p.cli.Branches()
	b, bErr := p.gogit.Branches()
	if !eqErr(aErr, bErr) {
		t.Fatalf("Branches errors differ: cli=%v gogit=%v", aErr, bErr)
	}
	normalize := func(bs []model.BranchInfo) []model.BranchInfo {
		out := append([]model.BranchInfo(nil), bs...)
		sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
		return out
	}
	if !reflect.DeepEqual(normalize(a), normalize(b)) {
		t.Fatalf("Branches differs:\ncli=%+v\ngogit=%+v", a, b)
	}
}

func TestParity_RemoteURL(t *testing.T) {
	p := newBackendPair(t)
	if a, b := p.cli.RemoteURL(), p.gogit.RemoteURL(); a != b {
		t.Fatalf("RemoteURL differs: cli=%q gogit=%q", a, b)
	}
}

func TestParity_Grep(t *testing.T) {
	p := newBackendPair(t)
	a, aErr := p.cli.Grep("BETA", p.f.C2, "", false, false, 100)
	b, bErr := p.gogit.Grep("BETA", p.f.C2, "", false, false, 100)
	if !eqErr(aErr, bErr) {
		t.Fatalf("Grep errors differ: cli=%v gogit=%v", aErr, bErr)
	}
	normalize := func(ms []model.GrepMatch) []model.GrepMatch {
		out := append([]model.GrepMatch(nil), ms...)
		sort.Slice(out, func(i, j int) bool {
			if out[i].File != out[j].File {
				return out[i].File < out[j].File
			}
			return out[i].Line < out[j].Line
		})
		return out
	}
	if !reflect.DeepEqual(normalize(a), normalize(b)) {
		t.Fatalf("Grep differs:\ncli=%+v\ngogit=%+v", a, b)
	}
}

func TestParity_Blame(t *testing.T) {
	p := newBackendPair(t)
	a, aErr := p.cli.Blame(p.f.C2, "a.txt", 0, 0)
	b, bErr := p.gogit.Blame(p.f.C2, "a.txt", 0, 0)
	if !eqErr(aErr, bErr) {
		t.Fatalf("Blame errors differ: cli=%v gogit=%v", aErr, bErr)
	}
	// Blame date representation differs (CLI uses author-time epoch as
	// string; go-git exposes a time.Time). Compare the stable fields only.
	stable := func(ls []model.BlameLine) []struct {
		Line int
		Text string
	} {
		out := make([]struct {
			Line int
			Text string
		}, len(ls))
		for i, l := range ls {
			out[i] = struct {
				Line int
				Text string
			}{l.Line, l.Text}
		}
		return out
	}
	if !reflect.DeepEqual(stable(a), stable(b)) {
		t.Fatalf("Blame stable fields differ:\ncli=%+v\ngogit=%+v", a, b)
	}
}

func TestParity_Pinning(t *testing.T) {
	p := newBackendPair(t)

	// CLI pins C1 first so there's an existing keep-ref for gogit to see.
	if err := p.cli.PinCommit(p.f.C1); err != nil {
		t.Fatalf("cli PinCommit: %v", err)
	}
	gotCLI, aErr := p.cli.ListPinnedCommits()
	gotGo, bErr := p.gogit.ListPinnedCommits()
	if !eqErr(aErr, bErr) {
		t.Fatalf("ListPinnedCommits errors differ: cli=%v gogit=%v", aErr, bErr)
	}
	sort.Strings(gotCLI)
	sort.Strings(gotGo)
	if !reflect.DeepEqual(gotCLI, gotGo) {
		t.Fatalf("ListPinnedCommits differs: cli=%v gogit=%v", gotCLI, gotGo)
	}

	// Unpin via gogit, verify CLI sees it gone.
	if err := p.gogit.UnpinCommit(p.f.C1); err != nil {
		t.Fatalf("gogit UnpinCommit: %v", err)
	}
	remaining, err := p.cli.ListPinnedCommits()
	if err != nil {
		t.Fatalf("cli ListPinnedCommits after unpin: %v", err)
	}
	if len(remaining) != 0 {
		t.Fatalf("expected 0 pinned after gogit unpin, got %v", remaining)
	}
}
