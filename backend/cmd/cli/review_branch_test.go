package main

import (
	"bytes"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// A command that names no commit works on the review branch's head, not on
// whatever is checked out: main is checked out, and feature is the review branch.
func TestCLI_DefaultsCommitToReviewBranchHead(t *testing.T) {
	dir := t.TempDir()
	git := func(args ...string) string {
		t.Helper()
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
		return strings.TrimSpace(string(out))
	}
	git("init", "-q", "-b", "main")
	git("config", "user.email", "t@t")
	git("config", "user.name", "T")
	git("config", "commit.gpgsign", "false")
	os.WriteFile(filepath.Join(dir, "main.go"), []byte("package main\n"), 0644)
	git("add", ".")
	git("commit", "-q", "-m", "base")
	git("checkout", "-q", "-b", "feature")
	os.WriteFile(filepath.Join(dir, "feature.go"), []byte("package main\n"), 0644)
	git("add", ".")
	git("commit", "-q", "-m", "feature work")
	featTip := git("rev-parse", "HEAD")
	git("checkout", "-q", "main")

	srv := startServer(t, dir, false)
	if code, out := serverCall(t, srv, "PUT", "/api/projects/"+testProject+"/review-branch", []byte(`{"branch":"feature"}`)); code != 200 {
		t.Fatalf("set the review branch: %d %s", code, out)
	}
	getenv := func(k string) string {
		switch k {
		case "BENCH_URL":
			return srv.URL
		case "BENCH_PROJECT":
			return testProject
		}
		return ""
	}
	cli := func(args ...string) string {
		t.Helper()
		var stdout, stderr bytes.Buffer
		if code := run(args, getenv, &stdout, &stderr); code != 0 {
			t.Fatalf("bench %v: exit %d\n%s", args, code, stderr.String())
		}
		return stdout.String()
	}

	// The file tree is the review branch's.
	if out := cli("git", "list-files"); !strings.Contains(out, "feature.go") {
		t.Errorf("list-files shows the checked-out branch, want feature's files:\n%s", out)
	}

	// A finding without --commit is anchored at the review branch's head.
	var created struct {
		Anchor struct {
			CommitID string `json:"commitId"`
		} `json:"anchor"`
	}
	out := cli("findings", "create", "--title", "t", "--severity", "low", "--file", "feature.go")
	if err := json.Unmarshal([]byte(out), &created); err != nil {
		t.Fatalf("create output: %v\n%s", err, out)
	}
	if created.Anchor.CommitID != featTip {
		t.Errorf("anchored at %.7s, want the review branch's head %.7s", created.Anchor.CommitID, featTip)
	}
}
