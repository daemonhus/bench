package model

import "testing"

func TestBranchFromMergeSubject(t *testing.T) {
	cases := []struct {
		subject string
		want    string
	}{
		{"Merge branch 'feature/api'", "feature/api"},
		{"Merge branch 'fix-auth' into develop", "fix-auth"},
		{"Merge remote-tracking branch 'origin/hotfix/csrf'", "hotfix/csrf"},
		{"Merge pull request #42 from acme/feature/webhooks", "feature/webhooks"},
		{"Merged in feature/payments (pull request #7)", "feature/payments"},
		{"feat: unrelated subject", ""},
		{"merge feat", ""}, // ad-hoc merge message: no reliable branch
	}
	for _, c := range cases {
		if got := BranchFromMergeSubject(c.subject); got != c.want {
			t.Errorf("BranchFromMergeSubject(%q) = %q, want %q", c.subject, got, c.want)
		}
	}
}

func TestMergeTargetAndBranchFlow(t *testing.T) {
	if got := MergeTargetFromSubject("Merge branch 'fix-auth' into develop"); got != "develop" {
		t.Errorf("target = %q, want develop", got)
	}
	if got := MergeTargetFromSubject("Merge branch 'feature/api'"); got != "" {
		t.Errorf("target = %q, want empty", got)
	}
	if got := BranchFlow("feature/x", "main"); got != "feature/x -> main" {
		t.Errorf("flow = %q", got)
	}
	if got := BranchFlow("feature/x", ""); got != "feature/x" {
		t.Errorf("flow without target = %q", got)
	}
	if got := BranchFlow("main", "main"); got != "main" {
		t.Errorf("flow same source and target = %q", got)
	}
}

func TestOriginCandidateFromBlame(t *testing.T) {
	lines := []BlameLine{
		{CommitHash: "aaa1111", Author: "alice", AuthorDate: "1738576800"}, // 2025-02-03
		{CommitHash: "bbb2222", Author: "bob", AuthorDate: "1739181600"},   // 2025-02-10 (newest)
		{CommitHash: "aaa1111", Author: "alice", AuthorDate: "1738576800"},
	}
	got := OriginCandidateFromBlame(lines)
	if got.IntroducedCommit != "bbb2222" || got.Actor != "bob" {
		t.Errorf("candidate = %+v, want the newest blamed commit", got)
	}
	if got.IntroducedDate != "2025-02-10T10:00:00Z" {
		t.Errorf("date = %q, want epoch normalised to RFC3339", got.IntroducedDate)
	}
}
