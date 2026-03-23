package db

import (
	"testing"

	"bench/internal/model"
)

func TestBatchCreateFindings(t *testing.T) {
	d := openTestDB(t)

	findings := []model.Finding{
		{
			ID:       "bf-1",
			Anchor:   model.Anchor{FileID: "src/a.go", CommitID: "aaa"},
			Severity: "high",
			Title:    "SQL injection",
			Status:   "draft",
			Source:   "mcp",
		},
		{
			ID:       "bf-2",
			Anchor:   model.Anchor{FileID: "src/b.go", CommitID: "aaa"},
			Severity: "medium",
			Title:    "XSS",
			Status:   "draft",
			Source:   "mcp",
		},
	}

	ids, err := d.BatchCreateFindings(findings)
	if err != nil {
		t.Fatalf("BatchCreateFindings: %v", err)
	}
	if len(ids) != 2 {
		t.Fatalf("expected 2 IDs, got %d", len(ids))
	}

	// Verify they were actually inserted
	f, err := d.GetFinding("bf-1")
	if err != nil {
		t.Fatalf("GetFinding bf-1: %v", err)
	}
	if f.Title != "SQL injection" {
		t.Errorf("expected title 'SQL injection', got %q", f.Title)
	}
	if f.Source != "mcp" {
		t.Errorf("expected source 'mcp', got %q", f.Source)
	}
}

func TestBatchCreateFindings_Rollback(t *testing.T) {
	d := openTestDB(t)

	// First finding is valid, second has a duplicate ID
	_, _ = d.conn.Exec(
		`INSERT INTO findings (id, anchor_file_id, anchor_commit_id, severity, title, status, source)
		 VALUES ('dup', 'x', 'aaa', 'info', 'existing', 'open', 'mcp')`)

	findings := []model.Finding{
		{ID: "new-1", Anchor: model.Anchor{FileID: "a", CommitID: "aaa"}, Severity: "low", Title: "ok", Status: "draft", Source: "mcp"},
		{ID: "dup", Anchor: model.Anchor{FileID: "b", CommitID: "aaa"}, Severity: "low", Title: "dup", Status: "draft", Source: "mcp"},
	}

	_, err := d.BatchCreateFindings(findings)
	if err == nil {
		t.Fatal("expected error on duplicate ID, got nil")
	}

	// The first finding should NOT exist (rolled back)
	_, err = d.GetFinding("new-1")
	if err == nil {
		t.Fatal("expected new-1 to not exist after rollback")
	}
}

func TestFindingSummary(t *testing.T) {
	d := openTestDB(t)

	for _, f := range []struct{ id, sev, status string }{
		{"f1", "high", "open"},
		{"f2", "high", "open"},
		{"f3", "high", "closed"},
		{"f4", "medium", "draft"},
	} {
		_, err := d.conn.Exec(
			`INSERT INTO findings (id, anchor_file_id, anchor_commit_id, severity, title, status, source)
			 VALUES (?, 'x', 'aaa', ?, 't', ?, 'mcp')`, f.id, f.sev, f.status)
		if err != nil {
			t.Fatal(err)
		}
	}

	rows, err := d.FindingSummary()
	if err != nil {
		t.Fatalf("FindingSummary: %v", err)
	}

	// Should have 3 rows: high/open(2), high/closed(1), medium/draft(1)
	if len(rows) != 3 {
		t.Fatalf("expected 3 summary rows, got %d: %+v", len(rows), rows)
	}

	// high should come before medium in ordering
	if rows[0].Severity != "high" {
		t.Errorf("expected first row severity 'high', got %q", rows[0].Severity)
	}
}

func TestUnresolvedCommentCount(t *testing.T) {
	d := openTestDB(t)

	// 2 unresolved, 1 resolved
	_, _ = d.conn.Exec(
		`INSERT INTO comments (id, anchor_file_id, anchor_commit_id, author, text, timestamp, thread_id)
		 VALUES ('c1', 'x', 'aaa', 'u', 'a', '2024-01-01', 't1')`)
	_, _ = d.conn.Exec(
		`INSERT INTO comments (id, anchor_file_id, anchor_commit_id, author, text, timestamp, thread_id)
		 VALUES ('c2', 'x', 'aaa', 'u', 'b', '2024-01-02', 't2')`)
	_, _ = d.conn.Exec(
		`INSERT INTO comments (id, anchor_file_id, anchor_commit_id, author, text, timestamp, thread_id, resolved_commit)
		 VALUES ('c3', 'x', 'aaa', 'u', 'c', '2024-01-03', 't3', 'bbb')`)

	count, err := d.UnresolvedCommentCount()
	if err != nil {
		t.Fatalf("UnresolvedCommentCount: %v", err)
	}
	if count != 2 {
		t.Fatalf("expected 2 unresolved, got %d", count)
	}
}

func TestSearchFindings(t *testing.T) {
	d := openTestDB(t)

	for _, f := range []struct{ id, title, desc, sev, status string }{
		{"f1", "SQL injection in login", "user input concatenated", "high", "open"},
		{"f2", "XSS in profile", "innerHTML used", "medium", "open"},
		{"f3", "SQL injection in search", "parameterized query missing", "high", "closed"},
	} {
		_, err := d.conn.Exec(
			`INSERT INTO findings (id, anchor_file_id, anchor_commit_id, severity, title, description, status, source)
			 VALUES (?, 'x', 'aaa', ?, ?, ?, ?, 'mcp')`, f.id, f.sev, f.title, f.desc, f.status)
		if err != nil {
			t.Fatal(err)
		}
	}

	// Search by title
	results, err := d.SearchFindings("SQL injection", "", "", 50)
	if err != nil {
		t.Fatalf("SearchFindings: %v", err)
	}
	if len(results) != 2 {
		t.Fatalf("expected 2 SQL injection matches, got %d", len(results))
	}

	// Search with status filter
	results, err = d.SearchFindings("SQL injection", "open", "", 50)
	if err != nil {
		t.Fatalf("SearchFindings with status: %v", err)
	}
	if len(results) != 1 {
		t.Fatalf("expected 1 open SQL injection, got %d", len(results))
	}

	// Search by description
	results, err = d.SearchFindings("innerHTML", "", "", 50)
	if err != nil {
		t.Fatalf("SearchFindings by desc: %v", err)
	}
	if len(results) != 1 {
		t.Fatalf("expected 1 innerHTML match, got %d", len(results))
	}

	// No matches
	results, err = d.SearchFindings("buffer overflow", "", "", 50)
	if err != nil {
		t.Fatalf("SearchFindings no match: %v", err)
	}
	if len(results) != 0 {
		t.Fatalf("expected 0 matches, got %d", len(results))
	}
}

func TestMarkReviewed_And_GetReviewProgress(t *testing.T) {
	d := openTestDB(t)

	// Mark two files
	if err := d.MarkReviewed("src/a.go", "aaa", "reviewer1", "looks good"); err != nil {
		t.Fatalf("MarkReviewed: %v", err)
	}
	if err := d.MarkReviewed("src/b.go", "aaa", "reviewer1", ""); err != nil {
		t.Fatalf("MarkReviewed: %v", err)
	}

	// Get all
	progress, err := d.GetReviewProgress("")
	if err != nil {
		t.Fatalf("GetReviewProgress: %v", err)
	}
	if len(progress) != 2 {
		t.Fatalf("expected 2 entries, got %d", len(progress))
	}

	// Filter by prefix
	progress, err = d.GetReviewProgress("src/a")
	if err != nil {
		t.Fatalf("GetReviewProgress prefix: %v", err)
	}
	if len(progress) != 1 {
		t.Fatalf("expected 1 entry for prefix src/a, got %d", len(progress))
	}
	if progress[0].Note != "looks good" {
		t.Errorf("expected note 'looks good', got %q", progress[0].Note)
	}
}

func TestMarkReviewed_Upsert(t *testing.T) {
	d := openTestDB(t)

	if err := d.MarkReviewed("src/a.go", "aaa", "r1", "first pass"); err != nil {
		t.Fatal(err)
	}
	if err := d.MarkReviewed("src/a.go", "bbb", "r1", "second pass"); err != nil {
		t.Fatal(err)
	}

	progress, err := d.GetReviewProgress("src/a.go")
	if err != nil {
		t.Fatal(err)
	}
	if len(progress) != 1 {
		t.Fatalf("expected 1 entry after upsert, got %d", len(progress))
	}
	if progress[0].CommitID != "bbb" {
		t.Errorf("expected commit 'bbb' after upsert, got %q", progress[0].CommitID)
	}
	if progress[0].Note != "second pass" {
		t.Errorf("expected note 'second pass', got %q", progress[0].Note)
	}
}

func TestListComments_FindingFilter(t *testing.T) {
	d := openTestDB(t)

	// Create a finding
	_, _ = d.conn.Exec(
		`INSERT INTO findings (id, anchor_file_id, anchor_commit_id, severity, title, status, source)
		 VALUES ('f1', 'src/a.go', 'aaa', 'high', 'SQLi', 'open', 'mcp')`)

	// Two comments linked to the finding, one standalone
	_, _ = d.conn.Exec(
		`INSERT INTO comments (id, anchor_file_id, anchor_commit_id, author, text, timestamp, thread_id, finding_id)
		 VALUES ('c1', 'src/a.go', 'aaa', 'alice', 'looks bad', '2024-01-01', 't1', 'f1')`)
	_, _ = d.conn.Exec(
		`INSERT INTO comments (id, anchor_file_id, anchor_commit_id, author, text, timestamp, thread_id, finding_id)
		 VALUES ('c2', 'src/a.go', 'aaa', 'bob', 'agreed', '2024-01-02', 't1', 'f1')`)
	_, _ = d.conn.Exec(
		`INSERT INTO comments (id, anchor_file_id, anchor_commit_id, author, text, timestamp, thread_id)
		 VALUES ('c3', 'src/b.go', 'aaa', 'carol', 'unrelated', '2024-01-03', 't2')`)

	// Filter by findingID
	comments, total, err := d.ListComments("", "f1", 0, 0)
	if err != nil {
		t.Fatalf("ListComments findingID: %v", err)
	}
	if total != 2 {
		t.Fatalf("expected 2 finding-linked comments, got %d", total)
	}
	for _, c := range comments {
		if c.FindingID == nil || *c.FindingID != "f1" {
			t.Errorf("expected findingID 'f1', got %v", c.FindingID)
		}
	}

	// No filter returns all 3
	all, total, err := d.ListComments("", "", 0, 0)
	if err != nil {
		t.Fatalf("ListComments all: %v", err)
	}
	if total != 3 {
		t.Fatalf("expected 3 total comments, got %d", total)
	}
	_ = all

	// Both filters: fileID + findingID
	filtered, total, err := d.ListComments("src/a.go", "f1", 0, 0)
	if err != nil {
		t.Fatalf("ListComments fileID+findingID: %v", err)
	}
	if total != 2 {
		t.Fatalf("expected 2 for file+finding filter, got %d", total)
	}
	_ = filtered
}

func TestCommentCountsByFinding(t *testing.T) {
	d := openTestDB(t)

	// Two findings, one with 3 comments, one with 1
	_, _ = d.conn.Exec(
		`INSERT INTO findings (id, anchor_file_id, anchor_commit_id, severity, title, status, source)
		 VALUES ('f1', 'x', 'aaa', 'high', 'a', 'open', 'mcp')`)
	_, _ = d.conn.Exec(
		`INSERT INTO findings (id, anchor_file_id, anchor_commit_id, severity, title, status, source)
		 VALUES ('f2', 'x', 'aaa', 'low', 'b', 'open', 'mcp')`)
	_, _ = d.conn.Exec(
		`INSERT INTO findings (id, anchor_file_id, anchor_commit_id, severity, title, status, source)
		 VALUES ('f3', 'x', 'aaa', 'info', 'c', 'open', 'mcp')`)

	for i, fid := range []string{"f1", "f1", "f1", "f2"} {
		_, _ = d.conn.Exec(
			`INSERT INTO comments (id, anchor_file_id, anchor_commit_id, author, text, timestamp, thread_id, finding_id)
			 VALUES (?, 'x', 'aaa', 'u', 'text', '2024-01-01', 't', ?)`,
			"c"+string(rune('0'+i)), fid)
	}

	counts, err := d.CommentCountsByFinding([]string{"f1", "f2", "f3"})
	if err != nil {
		t.Fatalf("CommentCountsByFinding: %v", err)
	}
	if counts["f1"] != 3 {
		t.Errorf("expected f1 count 3, got %d", counts["f1"])
	}
	if counts["f2"] != 1 {
		t.Errorf("expected f2 count 1, got %d", counts["f2"])
	}
	if counts["f3"] != 0 {
		t.Errorf("expected f3 count 0, got %d", counts["f3"])
	}

	// Empty input returns empty map
	empty, err := d.CommentCountsByFinding(nil)
	if err != nil {
		t.Fatalf("CommentCountsByFinding empty: %v", err)
	}
	if len(empty) != 0 {
		t.Errorf("expected empty map, got %d entries", len(empty))
	}
}

func TestDeleteFinding_NullifiesLinkedComments(t *testing.T) {
	d := openTestDB(t)

	_, _ = d.conn.Exec(
		`INSERT INTO findings (id, anchor_file_id, anchor_commit_id, severity, title, status, source)
		 VALUES ('f1', 'src/a.go', 'aaa', 'high', 'SQLi', 'open', 'mcp')`)

	// Two comments linked to the finding
	_, _ = d.conn.Exec(
		`INSERT INTO comments (id, anchor_file_id, anchor_commit_id, author, text, timestamp, thread_id, finding_id)
		 VALUES ('c1', 'src/a.go', 'aaa', 'alice', 'note 1', '2024-01-01', 't1', 'f1')`)
	_, _ = d.conn.Exec(
		`INSERT INTO comments (id, anchor_file_id, anchor_commit_id, author, text, timestamp, thread_id, finding_id)
		 VALUES ('c2', 'src/a.go', 'aaa', 'bob', 'note 2', '2024-01-02', 't1', 'f1')`)

	// One unrelated comment
	_, _ = d.conn.Exec(
		`INSERT INTO comments (id, anchor_file_id, anchor_commit_id, author, text, timestamp, thread_id)
		 VALUES ('c3', 'src/b.go', 'aaa', 'carol', 'standalone', '2024-01-03', 't2')`)

	// Delete the finding
	if err := d.DeleteFinding("f1"); err != nil {
		t.Fatalf("DeleteFinding: %v", err)
	}

	// Finding should be gone
	_, err := d.GetFinding("f1")
	if err == nil {
		t.Fatal("expected finding to be deleted")
	}

	// Linked comments should survive with findingID nullified
	c1, err := d.GetComment("c1")
	if err != nil {
		t.Fatalf("GetComment c1 after delete: %v", err)
	}
	if c1.FindingID != nil {
		t.Errorf("expected c1 findingID to be nil, got %v", *c1.FindingID)
	}
	if c1.Text != "note 1" {
		t.Errorf("expected c1 text preserved, got %q", c1.Text)
	}

	c2, err := d.GetComment("c2")
	if err != nil {
		t.Fatalf("GetComment c2 after delete: %v", err)
	}
	if c2.FindingID != nil {
		t.Errorf("expected c2 findingID to be nil, got %v", *c2.FindingID)
	}

	// Unrelated comment should be untouched
	c3, err := d.GetComment("c3")
	if err != nil {
		t.Fatalf("GetComment c3: %v", err)
	}
	if c3.FindingID != nil {
		t.Errorf("expected c3 findingID to remain nil")
	}
}

func TestUpdateFinding_LineRange(t *testing.T) {
	d := openTestDB(t)

	_, err := d.conn.Exec(
		`INSERT INTO findings (id, anchor_file_id, anchor_commit_id, anchor_line_start, anchor_line_end, severity, title, status, source)
		 VALUES ('f1', 'src/a.go', 'aaa', 10, 20, 'high', 'SQLi', 'open', 'mcp')`)
	if err != nil {
		t.Fatal(err)
	}

	// Update line range and hash
	updated, err := d.UpdateFinding("f1", map[string]any{
		"line_start": 42,
		"line_end":   55,
		"line_hash":  "deadbeef",
	})
	if err != nil {
		t.Fatalf("UpdateFinding line range: %v", err)
	}
	if updated.Anchor.LineRange == nil {
		t.Fatal("expected line range to be set after update")
	}
	if updated.Anchor.LineRange.Start != 42 {
		t.Errorf("expected line_start 42, got %d", updated.Anchor.LineRange.Start)
	}
	if updated.Anchor.LineRange.End != 55 {
		t.Errorf("expected line_end 55, got %d", updated.Anchor.LineRange.End)
	}
	if updated.LineHash != "deadbeef" {
		t.Errorf("expected line_hash 'deadbeef', got %q", updated.LineHash)
	}

	// Other fields should be unchanged
	if updated.Severity != "high" {
		t.Errorf("expected severity 'high' unchanged, got %q", updated.Severity)
	}

	// Verify persisted correctly via a fresh read
	f, err := d.GetFinding("f1")
	if err != nil {
		t.Fatalf("GetFinding after update: %v", err)
	}
	if f.Anchor.LineRange.Start != 42 || f.Anchor.LineRange.End != 55 {
		t.Errorf("persisted range = %d-%d, want 42-55", f.Anchor.LineRange.Start, f.Anchor.LineRange.End)
	}
}

func TestDeleteFinding_NotFound(t *testing.T) {
	d := openTestDB(t)

	err := d.DeleteFinding("nonexistent")
	if err == nil {
		t.Fatal("expected error for nonexistent finding")
	}
}

func TestDeleteComment(t *testing.T) {
	d := openTestDB(t)

	_, _ = d.conn.Exec(
		`INSERT INTO comments (id, anchor_file_id, anchor_commit_id, author, text, timestamp, thread_id)
		 VALUES ('c1', 'src/a.go', 'aaa', 'alice', 'hello', '2024-01-01', 't1')`)

	if err := d.DeleteComment("c1"); err != nil {
		t.Fatalf("DeleteComment: %v", err)
	}

	// Should be gone
	_, err := d.GetComment("c1")
	if err == nil {
		t.Fatal("expected comment to be deleted")
	}

	// Deleting again should fail
	err = d.DeleteComment("c1")
	if err == nil {
		t.Fatal("expected error for already-deleted comment")
	}
}

func TestDeleteComment_NotFound(t *testing.T) {
	d := openTestDB(t)

	err := d.DeleteComment("nonexistent")
	if err == nil {
		t.Fatal("expected error for nonexistent comment")
	}
}

func TestGetComment(t *testing.T) {
	d := openTestDB(t)

	_, err := d.conn.Exec(
		`INSERT INTO comments (id, anchor_file_id, anchor_commit_id, author, text, timestamp, thread_id)
		 VALUES ('c1', 'src/a.go', 'aaa', 'alice', 'hello', '2024-01-01T00:00:00Z', 'thread-1')`)
	if err != nil {
		t.Fatal(err)
	}

	c, err := d.GetComment("c1")
	if err != nil {
		t.Fatalf("GetComment: %v", err)
	}
	if c.Author != "alice" {
		t.Errorf("expected author 'alice', got %q", c.Author)
	}
	if c.ThreadID != "thread-1" {
		t.Errorf("expected threadID 'thread-1', got %q", c.ThreadID)
	}

	// Not found
	_, err = d.GetComment("nonexistent")
	if err == nil {
		t.Fatal("expected error for nonexistent comment")
	}
}
