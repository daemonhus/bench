package git

import (
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"testing"

	"bench/internal/model"
)

func TestParsePullRequest(t *testing.T) {
	const web = "https://github.com/acme/app"
	cases := []struct {
		name, msg string
		want      *model.PullRequest
	}{
		{"github merge", "Merge pull request #12 from acme/fix-login\n\nFix the login redirect\n",
			&model.PullRequest{Kind: "pull", Number: 12, Branch: "fix-login", Title: "Fix the login redirect", URL: web + "/pull/12"}},
		{"github merge, branch with slashes", "Merge pull request #3 from someone/feat/a-b",
			&model.PullRequest{Kind: "pull", Number: 3, Branch: "feat/a-b", URL: web + "/pull/3"}},
		{"gitlab merge", "Merge branch 'rate-limit' into 'main'\n\nAdd rate limiting\n\nSee merge request acme/app!7",
			&model.PullRequest{Kind: "merge", Number: 7, Branch: "rate-limit", Title: "Add rate limiting", URL: web + "/-/merge_requests/7"}},
		{"gitlab merge, no title", "Merge branch 'x' into 'main'\n\nSee merge request acme/app!8",
			&model.PullRequest{Kind: "merge", Number: 8, Branch: "x", URL: web + "/-/merge_requests/8"}},
		{"squash", "Add audit log (#41)\n\n* one\n* two",
			&model.PullRequest{Kind: "pull", Number: 41, Title: "Add audit log", Squashed: true, URL: web + "/pull/41"}},
		{"local merge", "Merge branch 'topic'", nil},
		{"local gitlab-style merge without a request", "Merge branch 'a' into 'main'", nil},
		{"plain commit", "fix: a typo", nil},
		{"issue reference mid-subject", "fix (#12) in the parser", nil},
	}
	for _, c := range cases {
		if got := parsePullRequest(c.msg, web); !reflect.DeepEqual(got, c.want) {
			t.Errorf("%s: got %+v, want %+v", c.name, got, c.want)
		}
	}
	if pr := parsePullRequest("Add x (#5)", ""); pr == nil || pr.URL != "" {
		t.Errorf("no remote: want no URL, got %+v", pr)
	}
}

func TestWebURL(t *testing.T) {
	for remote, want := range map[string]string{
		"git@github.com:acme/app.git":         "https://github.com/acme/app",
		"https://github.com/acme/app.git":     "https://github.com/acme/app",
		"https://user@gitlab.com/g/sub/p":     "https://gitlab.com/g/sub/p",
		"ssh://git@gitlab.example.com:22/g/p": "https://gitlab.example.com/g/p",
		"git@github-work:acme/app.git":        "https://github.com/acme/app",
		"git@myalias:acme/app.git":            "",
		"/srv/git/app.git":                    "",
		"":                                    "",
	} {
		if got := webURL(remote); got != want {
			t.Errorf("webURL(%q) = %q, want %q", remote, got, want)
		}
	}
}

// A merged pull request reaches the graph on its merge commit, linked through the origin remote.
func TestGraph_MergeCommitCarriesItsPullRequest(t *testing.T) {
	f := newFixture(t)
	git := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", args...)
		cmd.Dir = f.Dir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	git("remote", "add", "origin", "git@github.com:acme/app.git")
	git("checkout", "-q", "-b", "topic")
	if err := os.WriteFile(filepath.Join(f.Dir, "d.txt"), []byte("d\n"), 0644); err != nil {
		t.Fatal(err)
	}
	git("add", ".")
	git("commit", "-q", "-m", "add d")
	git("checkout", "-q", "main")
	git("merge", "-q", "--no-ff", "topic", "-m", "Merge pull request #5 from acme/topic\n\nAdd d")

	commits, err := NewRepo(f.Dir).Graph(10)
	if err != nil {
		t.Fatal(err)
	}
	want := &model.PullRequest{Kind: "pull", Number: 5, Branch: "topic", Title: "Add d", URL: "https://github.com/acme/app/pull/5"}
	var found int
	for _, c := range commits {
		if c.PullRequest != nil {
			found++
			if !reflect.DeepEqual(c.PullRequest, want) || len(c.Parents) != 2 {
				t.Errorf("%s (%d parents): %+v", c.Subject, len(c.Parents), c.PullRequest)
			}
		}
	}
	if found != 1 {
		t.Errorf("%d commits carry a pull request, want 1 (the merge)", found)
	}
}
