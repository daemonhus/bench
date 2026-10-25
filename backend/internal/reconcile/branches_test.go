package reconcile_test

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"bench/internal/db"
	"bench/internal/git"
	"bench/internal/model"
	"bench/internal/reconcile"
)

// Reconciling to one branch and then another, on a real repo:
//
//	base ── main   (inserts two lines at the top)
//	   └── feature (deletes lines 5-6)
func TestReconcile_SwitchingBranches(t *testing.T) {
	dir := t.TempDir()
	run := func(args ...string) string {
		t.Helper()
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
		return strings.TrimSpace(string(out))
	}
	lines := func(ls ...string) string { return strings.Join(ls, "\n") + "\n" }
	commit := func(content, msg string) string {
		t.Helper()
		if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte(content), 0644); err != nil {
			t.Fatal(err)
		}
		run("add", ".")
		run("commit", "-q", "-m", msg)
		return run("rev-parse", "HEAD")
	}
	run("init", "-q", "-b", "main")
	run("config", "user.email", "t@t")
	run("config", "user.name", "T")
	run("config", "commit.gpgsign", "false")
	base := commit(lines("l1", "l2", "l3", "l4", "l5", "l6", "l7", "l8", "l9", "l10"), "base")
	mainTip := commit(lines("new1", "new2", "l1", "l2", "l3", "l4", "l5", "l6", "l7", "l8", "l9", "l10"), "main")
	run("checkout", "-q", "-b", "feature", base)
	featTip := commit(lines("l1", "l2", "l3", "l4", "l7", "l8", "l9", "l10", "feat"), "feature")

	database, err := db.Open(filepath.Join(t.TempDir(), "t.db"), "t")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { database.Close() })
	finding := func(id, commit string, start, end int) {
		t.Helper()
		err := database.CreateFinding(&model.Finding{
			ID: id, Title: id, Severity: "high", Status: "open", Source: "manual",
			Anchor: model.Anchor{FileID: "a.txt", CommitID: commit, LineRange: &model.LineRange{Start: start, End: end}},
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	finding("shared", base, 8, 9)          // l8-l9: on both branches
	finding("gone-on-feature", base, 5, 6) // l5-l6: feature deletes them
	finding("feature-only", featTip, 9, 9) // "feat": made on feature

	r := reconcile.NewReconciler(git.NewRepo(dir), database, database, database, reconcile.WithResolver(database))
	reconcileTo := func(target string) {
		t.Helper()
		id := r.StartJob(target, nil)
		deadline := time.Now().Add(10 * time.Second)
		for time.Now().Before(deadline) {
			if s := r.GetJob(id); s != nil && (s.Status == "done" || s.Status == "failed") {
				if s.Status != "done" {
					t.Fatalf("reconcile to %.7s: %s", target, s.Error)
				}
				return
			}
			time.Sleep(5 * time.Millisecond)
		}
		t.Fatalf("reconcile to %.7s timed out", target)
	}
	at := func(id, commit string) string {
		t.Helper()
		ps, err := r.GetEffectivePositions("a.txt", commit)
		if err != nil {
			t.Fatal(err)
		}
		p, ok := ps[id]
		if !ok {
			return "none"
		}
		if p.LineStart == nil || *p.LineStart == 0 {
			return p.Confidence
		}
		return strings.Join([]string{p.Confidence, itoa(*p.LineStart), itoa(*p.LineEnd)}, " ")
	}
	status := func(id string) string {
		t.Helper()
		f, err := database.GetFinding(id)
		if err != nil {
			t.Fatal(err)
		}
		return f.Status
	}
	expect := func(what, got, want string) {
		t.Helper()
		if got != want {
			t.Errorf("%s = %q, want %q", what, got, want)
		}
	}

	reconcileTo(mainTip)
	expect("shared on main", at("shared", mainTip), "exact 10 11")
	expect("gone-on-feature on main", at("gone-on-feature", mainTip), "exact 7 8")
	expect("feature-only on main", at("feature-only", mainTip), "none")
	expect("feature-only status after main", status("feature-only"), "open")

	reconcileTo(featTip)
	expect("shared on feature", at("shared", featTip), "exact 6 7")
	expect("gone-on-feature on feature", at("gone-on-feature", featTip), "orphaned")
	// Closing follows the code going away on the reviewed branch.
	expect("gone-on-feature status", status("gone-on-feature"), "closed")
	// Main's positions survive the visit to feature.
	expect("shared on main after feature", at("shared", mainTip), "exact 10 11")

	reconcileTo(mainTip)
	expect("shared back on main", at("shared", mainTip), "exact 10 11")
	expect("feature-only status back on main", status("feature-only"), "open")
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b []byte
	for ; n > 0; n /= 10 {
		b = append([]byte{byte('0' + n%10)}, b...)
	}
	return string(b)
}
