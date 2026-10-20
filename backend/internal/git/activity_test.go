package git

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

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

func TestActivityCachesLineStats(t *testing.T) {
	repo := buildActivityRepo(t)

	first, err := repo.Activity("week", 8)
	if err != nil {
		t.Fatalf("Activity: %v", err)
	}
	b := repo.backend.(*GoGitBackend)
	// Five non-merge commits carry a diffstat; the merge and stash do not.
	if got := len(b.lineStats); got != 5 {
		t.Fatalf("cached %d commits, want 5", got)
	}

	second, err := repo.Activity("week", 8)
	if err != nil {
		t.Fatalf("Activity: %v", err)
	}
	if len(second) != len(first) {
		t.Fatalf("second call: got %d weeks, want %d", len(second), len(first))
	}
	for i := range first {
		if second[i].Additions != first[i].Additions || second[i].Deletions != first[i].Deletions {
			t.Errorf("week %d: cached %+v, fresh %+v", i, second[i], first[i])
		}
	}
}

func TestOpenRepoBare(t *testing.T) {
	f := newFixture(t)
	bare := filepath.Join(t.TempDir(), "bare.git")
	cmd := exec.Command("git", "clone", "--bare", f.Dir, bare)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git clone --bare: %v\n%s", err, out)
	}

	// A bare repo has no .git directory, so openKeepDescriptors falls back to PlainOpen.
	r, err := openKeepDescriptors(bare)
	if err != nil {
		t.Fatalf("open bare repo: %v", err)
	}
	head, err := r.Head()
	if err != nil {
		t.Fatalf("Head on bare repo: %v", err)
	}
	if got := head.Hash().String(); got != f.C3 {
		t.Errorf("Head = %s, want %s", got, f.C3)
	}
	// The history walks go through it too.
	if _, err := NewRepo(bare).Graph(10); err != nil {
		t.Fatalf("Graph on bare repo: %v", err)
	}
}

// buildRecentRepo makes a main branch with commits a few days, ~40 and ~70 days old, a merge,
// and an origin/main that is one commit ahead (fetched, not yet pulled).
func buildRecentRepo(t *testing.T) (*Repo, time.Time) {
	t.Helper()
	dir := t.TempDir()
	now := time.Now().UTC().Truncate(time.Second)
	at := func(days int) string { return now.AddDate(0, 0, -days).Format(time.RFC3339) }
	run := func(date string, args ...string) {
		t.Helper()
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=a", "GIT_AUTHOR_EMAIL=a@example.com",
			"GIT_COMMITTER_NAME=a", "GIT_COMMITTER_EMAIL=a@example.com",
			"GIT_AUTHOR_DATE="+date, "GIT_COMMITTER_DATE="+date)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	commit := func(days int, file string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(dir, file), []byte(file+at(days)), 0644); err != nil {
			t.Fatal(err)
		}
		run(at(days), "add", ".")
		run(at(days), "commit", "-m", file)
	}
	run(at(70), "init", "-b", "main")
	commit(70, "a")
	commit(40, "b")
	run(at(5), "checkout", "-b", "side")
	commit(5, "c")
	run(at(3), "checkout", "main")
	run(at(3), "merge", "--no-ff", "-m", "merge side", "side")
	// origin/main: one more commit, a day old, fetched but not merged locally.
	run(at(1), "checkout", "-b", "upstream")
	commit(1, "d")
	run(at(1), "update-ref", "refs/remotes/origin/main", "HEAD")
	run(at(1), "checkout", "main")
	return NewRepo(dir), now
}

func TestBranchActivity(t *testing.T) {
	repo, now := buildRecentRepo(t)
	got, err := repo.BranchActivity("main", 12)
	if err != nil {
		t.Fatalf("BranchActivity: %v", err)
	}
	// The newest commit is origin/main's, a day old: the last push.
	if want := now.AddDate(0, 0, -1).Format(time.RFC3339); got.LastCommitAt != want {
		t.Errorf("LastCommitAt = %s, want %s (origin/main's tip)", got.LastCommitAt, want)
	}
	// a, b, c and d; the merge isn't counted.
	if got.Commits != 4 {
		t.Errorf("Commits = %d, want 4", got.Commits)
	}
	// The branch is ~70 days old, so it's averaged over 3 months, not 12.
	if got.Months != 3 {
		t.Errorf("Months = %d, want 3", got.Months)
	}
	// Weekly history for the graph: a year of weeks, newest last, adding up to the count.
	if len(got.Weekly) != 53 {
		t.Fatalf("Weekly has %d weeks, want 53", len(got.Weekly))
	}
	sum := 0
	for _, n := range got.Weekly {
		sum += n
	}
	last := len(got.Weekly) - 1
	if sum != got.Commits || got.Weekly[last] != 2 || got.Weekly[last-5] != 1 || got.Weekly[last-10] != 1 {
		t.Errorf("Weekly = %v (sum %d): want c and d this week, b 5 weeks ago, a 10 weeks ago", got.Weekly, sum)
	}
	again, _ := repo.BranchActivity("main", 12)
	if again.LastCommitAt != got.LastCommitAt || again.Commits != got.Commits || len(again.Weekly) != len(got.Weekly) {
		t.Errorf("cached result %+v differs from %+v", again, got)
	}

	// A window shorter than the history stops at its start.
	short, err := repo.BranchActivity("main", 1)
	if err != nil {
		t.Fatalf("BranchActivity(1 month): %v", err)
	}
	if short.Commits != 2 || short.Months != 1 {
		t.Errorf("1-month window = %d commits over %d months, want 2 over 1", short.Commits, short.Months)
	}

	if _, err := repo.BranchActivity("nope", 12); err == nil {
		t.Error("unknown branch: want an error")
	}
}
