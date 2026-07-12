package git

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"bench/internal/model"
)

// buildActivityRepo creates a repo with activity spread over two weeks with a
// quiet week between, three authors, one merge, and one stash:
//
//	week of 2025-01-06: alice ×2 (+3), bob ×1 (+1)
//	week of 2025-01-13: quiet
//	week of 2025-01-20: carol ×1 (+1/−1), bob ×1 (+1), bob merge, stash
func buildActivityRepo(t *testing.T) *Repo {
	t.Helper()
	dir := t.TempDir()

	run := func(author, date string, args ...string) {
		t.Helper()
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		cmd.Env = append(os.Environ(),
			"GIT_AUTHOR_NAME="+author, "GIT_AUTHOR_EMAIL="+author+"@example.com",
			"GIT_COMMITTER_NAME="+author, "GIT_COMMITTER_EMAIL="+author+"@example.com",
			"GIT_AUTHOR_DATE="+date, "GIT_COMMITTER_DATE="+date,
		)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	write := func(rel, content string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(dir, rel), []byte(content), 0644); err != nil {
			t.Fatal(err)
		}
	}

	run("alice", "2025-01-06T10:00:00Z", "init", "-b", "main")
	write("f.txt", "one\ntwo\n")
	run("alice", "2025-01-06T10:00:00Z", "add", ".")
	run("alice", "2025-01-06T10:00:00Z", "commit", "-m", "c1")
	write("f.txt", "one\ntwo\nthree\n")
	run("alice", "2025-01-07T10:00:00Z", "commit", "-am", "c2")
	write("g.txt", "g\n")
	run("bob", "2025-01-08T10:00:00Z", "add", ".")
	run("bob", "2025-01-08T10:00:00Z", "commit", "-m", "c3")

	write("f.txt", "ONE\ntwo\nthree\n")
	run("carol", "2025-01-20T10:00:00Z", "commit", "-am", "c4")

	run("bob", "2025-01-21T10:00:00Z", "checkout", "-b", "feat")
	write("h.txt", "h\n")
	run("bob", "2025-01-21T10:00:00Z", "add", ".")
	run("bob", "2025-01-21T10:00:00Z", "commit", "-m", "c5")
	run("bob", "2025-01-22T10:00:00Z", "checkout", "main")
	run("bob", "2025-01-22T10:00:00Z", "merge", "--no-ff", "-m", "merge feat", "feat")

	// A stash is a snapshot of working state, not activity.
	write("f.txt", "ONE\ntwo\nthree\nfour\n")
	run("bob", "2025-01-22T11:00:00Z", "stash")

	return NewRepo(dir)
}

func TestActivityWeeks(t *testing.T) {
	repo := buildActivityRepo(t)

	weeks, err := repo.Activity("week", 8)
	if err != nil {
		t.Fatalf("Activity: %v", err)
	}

	// Anchored to the newest commit's week and trimmed to the first active
	// week, the window spans exactly three buckets including the quiet one.
	if len(weeks) != 3 {
		t.Fatalf("got %d weeks, want 3: %+v", len(weeks), weeks)
	}

	want := []model.ActivityBucket{
		{Start: "2025-01-06", Commits: 3, Merges: 0, Additions: 4, Deletions: 0,
			Authors: []model.ActivityAuthor{{Name: "alice", Commits: 2}, {Name: "bob", Commits: 1}}},
		{Start: "2025-01-13", Authors: []model.ActivityAuthor{}},
		{Start: "2025-01-20", Commits: 3, Merges: 1, Additions: 2, Deletions: 1,
			Authors: []model.ActivityAuthor{{Name: "bob", Commits: 2}, {Name: "carol", Commits: 1}}},
	}
	for i, w := range want {
		got := weeks[i]
		if got.Start != w.Start || got.Commits != w.Commits || got.Merges != w.Merges ||
			got.Additions != w.Additions || got.Deletions != w.Deletions {
			t.Errorf("week %d: got %+v, want %+v", i, got, w)
		}
		if len(got.Authors) != len(w.Authors) {
			t.Errorf("week %d authors: got %+v, want %+v", i, got.Authors, w.Authors)
			continue
		}
		for j := range w.Authors {
			if got.Authors[j] != w.Authors[j] {
				t.Errorf("week %d author %q: got %+v, want %+v", i, w.Authors[j].Name, got.Authors[j], w.Authors[j])
			}
		}
	}
}

func TestActivityWindowNarrowerThanHistory(t *testing.T) {
	repo := buildActivityRepo(t)

	weeks, err := repo.Activity("week", 1)
	if err != nil {
		t.Fatalf("Activity: %v", err)
	}
	if len(weeks) != 1 {
		t.Fatalf("got %d weeks, want 1", len(weeks))
	}
	if weeks[0].Start != "2025-01-20" || weeks[0].Commits != 3 {
		t.Errorf("got %+v, want the newest week only", weeks[0])
	}
}

func TestActivityDays(t *testing.T) {
	repo := buildActivityRepo(t)

	days, err := repo.Activity("day", 30)
	if err != nil {
		t.Fatalf("Activity: %v", err)
	}
	// Anchor 2025-01-22 (merge day), trimmed to first activity 2025-01-06.
	if len(days) != 17 {
		t.Fatalf("got %d days, want 17: %+v", len(days), days)
	}
	first, last := days[0], days[len(days)-1]
	if first.Start != "2025-01-06" || first.Commits != 1 || first.Additions != 2 {
		t.Errorf("first day: got %+v", first)
	}
	if last.Start != "2025-01-22" || last.Commits != 1 || last.Merges != 1 || last.Additions != 0 {
		t.Errorf("last day: got %+v", last)
	}
}

func TestActivityYears(t *testing.T) {
	repo := buildActivityRepo(t)

	years, err := repo.Activity("year", 5)
	if err != nil {
		t.Fatalf("Activity: %v", err)
	}
	if len(years) != 1 {
		t.Fatalf("got %d years, want 1: %+v", len(years), years)
	}
	y := years[0]
	if y.Start != "2025-01-01" || y.Commits != 6 || y.Merges != 1 || y.Additions != 6 || y.Deletions != 1 {
		t.Errorf("got %+v", y)
	}
}

func TestActivityMonths(t *testing.T) {
	repo := buildActivityRepo(t)

	months, err := repo.Activity("month", 12)
	if err != nil {
		t.Fatalf("Activity: %v", err)
	}
	if len(months) != 1 {
		t.Fatalf("got %d months, want 1: %+v", len(months), months)
	}
	m := months[0]
	if m.Start != "2025-01-01" || m.Commits != 6 || m.Merges != 1 || m.Additions != 6 || m.Deletions != 1 {
		t.Errorf("got %+v", m)
	}
	wantAuthors := []model.ActivityAuthor{{Name: "bob", Commits: 3}, {Name: "alice", Commits: 2}, {Name: "carol", Commits: 1}}
	if len(m.Authors) != len(wantAuthors) {
		t.Fatalf("authors: got %+v, want %+v", m.Authors, wantAuthors)
	}
	for i := range wantAuthors {
		if m.Authors[i] != wantAuthors[i] {
			t.Errorf("author %d: got %+v, want %+v", i, m.Authors[i], wantAuthors[i])
		}
	}
}
