package db

import (
	"testing"

	"bench/internal/model"
)

func TestCreateAndGetBaseline(t *testing.T) {
	d := openTestDB(t)

	b := &model.Baseline{
		ID:            "bl-1",
		CommitID:      "abc123",
		Reviewer:      "alice",
		Summary:       "initial baseline",
		FindingsTotal: 3,
		FindingsOpen:  2,
		BySeverity:    map[string]int{"high": 1, "medium": 2},
		ByStatus:      map[string]int{"open": 2, "closed": 1},
		CommentsTotal: 5,
		CommentsOpen:  3,
		FindingIDs:    []string{"f1", "f2", "f3"},
	}
	if err := d.CreateBaseline(b); err != nil {
		t.Fatalf("CreateBaseline: %v", err)
	}

	got, err := d.GetBaselineByID("bl-1")
	if err != nil {
		t.Fatalf("GetBaselineByID: %v", err)
	}
	if got == nil {
		t.Fatal("expected baseline, got nil")
	}
	if got.CommitID != "abc123" {
		t.Errorf("commitId = %q, want %q", got.CommitID, "abc123")
	}
	if got.Reviewer != "alice" {
		t.Errorf("reviewer = %q, want %q", got.Reviewer, "alice")
	}
	if got.FindingsTotal != 3 {
		t.Errorf("findingsTotal = %d, want 3", got.FindingsTotal)
	}
	if got.FindingsOpen != 2 {
		t.Errorf("findingsOpen = %d, want 2", got.FindingsOpen)
	}
	if got.BySeverity["high"] != 1 {
		t.Errorf("bySeverity[high] = %d, want 1", got.BySeverity["high"])
	}
	if len(got.FindingIDs) != 3 {
		t.Errorf("findingIDs len = %d, want 3", len(got.FindingIDs))
	}
	if got.CreatedAt == "" {
		t.Error("createdAt should be set by DB default")
	}
	if got.Seq != 1 {
		t.Errorf("seq = %d, want 1 (first baseline)", got.Seq)
	}
}

func TestBaselineSeqAutoIncrement(t *testing.T) {
	d := openTestDB(t)

	for i, id := range []string{"bl-s1", "bl-s2", "bl-s3"} {
		b := &model.Baseline{
			ID:         id,
			CommitID:   "abc",
			BySeverity: map[string]int{},
			ByStatus:   map[string]int{},
			FindingIDs: []string{},
		}
		if err := d.CreateBaseline(b); err != nil {
			t.Fatalf("CreateBaseline %s: %v", id, err)
		}
		got, _ := d.GetBaselineByID(id)
		if got.Seq != i+1 {
			t.Errorf("baseline %s: seq = %d, want %d", id, got.Seq, i+1)
		}
	}

	// Delete middle baseline — next one should still be max+1
	d.DeleteBaseline("bl-s2")
	b4 := &model.Baseline{
		ID:         "bl-s4",
		CommitID:   "def",
		BySeverity: map[string]int{},
		ByStatus:   map[string]int{},
		FindingIDs: []string{},
	}
	d.CreateBaseline(b4)
	got, _ := d.GetBaselineByID("bl-s4")
	if got.Seq != 4 {
		t.Errorf("after delete, new baseline seq = %d, want 4", got.Seq)
	}
}

func TestGetLatestBaseline(t *testing.T) {
	d := openTestDB(t)

	// No baselines yet
	got, err := d.GetLatestBaseline()
	if err != nil {
		t.Fatalf("GetLatestBaseline empty: %v", err)
	}
	if got != nil {
		t.Fatal("expected nil when no baselines exist")
	}

	// Create two baselines — force ordering via direct SQL
	d.conn.Exec(`INSERT INTO baselines (id, project_id, commit_id, reviewer, summary, created_at,
		findings_total, findings_open, by_severity, by_status, comments_total, comments_open, finding_ids)
		VALUES ('bl-old', '_standalone', 'aaa', '', '', '2024-01-01 00:00:00', 0, 0, '{}', '{}', 0, 0, '[]')`)
	d.conn.Exec(`INSERT INTO baselines (id, project_id, commit_id, reviewer, summary, created_at,
		findings_total, findings_open, by_severity, by_status, comments_total, comments_open, finding_ids)
		VALUES ('bl-new', '_standalone', 'bbb', '', '', '2024-06-01 00:00:00', 0, 0, '{}', '{}', 0, 0, '[]')`)

	got, err = d.GetLatestBaseline()
	if err != nil {
		t.Fatalf("GetLatestBaseline: %v", err)
	}
	if got == nil {
		t.Fatal("expected baseline, got nil")
	}
	if got.ID != "bl-new" {
		t.Errorf("latest baseline ID = %q, want bl-new", got.ID)
	}
}

func TestGetPreviousBaseline(t *testing.T) {
	d := openTestDB(t)

	d.conn.Exec(`INSERT INTO baselines (id, project_id, commit_id, reviewer, summary, created_at,
		findings_total, findings_open, by_severity, by_status, comments_total, comments_open, finding_ids)
		VALUES ('bl-1', '_standalone', 'aaa', '', '', '2024-01-01 00:00:00', 0, 0, '{}', '{}', 0, 0, '[]')`)
	d.conn.Exec(`INSERT INTO baselines (id, project_id, commit_id, reviewer, summary, created_at,
		findings_total, findings_open, by_severity, by_status, comments_total, comments_open, finding_ids)
		VALUES ('bl-2', '_standalone', 'bbb', '', '', '2024-06-01 00:00:00', 1, 1, '{}', '{}', 0, 0, '[]')`)

	// Previous to bl-2 should be bl-1
	prev, err := d.GetPreviousBaseline("bl-2")
	if err != nil {
		t.Fatalf("GetPreviousBaseline: %v", err)
	}
	if prev == nil {
		t.Fatal("expected previous baseline, got nil")
	}
	if prev.ID != "bl-1" {
		t.Errorf("previous ID = %q, want bl-1", prev.ID)
	}

	// No baseline before bl-1
	prev, err = d.GetPreviousBaseline("bl-1")
	if err != nil {
		t.Fatalf("GetPreviousBaseline (none): %v", err)
	}
	if prev != nil {
		t.Errorf("expected nil before first baseline, got %+v", prev)
	}
}

func TestListBaselines(t *testing.T) {
	d := openTestDB(t)

	// Empty list
	list, err := d.ListBaselines(10)
	if err != nil {
		t.Fatalf("ListBaselines empty: %v", err)
	}
	if len(list) != 0 {
		t.Fatalf("expected 0 baselines, got %d", len(list))
	}

	// Insert 3
	for i, id := range []string{"bl-1", "bl-2", "bl-3"} {
		d.conn.Exec(`INSERT INTO baselines (id, project_id, commit_id, reviewer, summary, created_at,
			findings_total, findings_open, by_severity, by_status, comments_total, comments_open, finding_ids)
			VALUES (?, '_standalone', 'aaa', '', '', ?, 0, 0, '{}', '{}', 0, 0, '[]')`,
			id, "2024-01-0"+string(rune('1'+i))+" 00:00:00")
	}

	list, err = d.ListBaselines(10)
	if err != nil {
		t.Fatalf("ListBaselines: %v", err)
	}
	if len(list) != 3 {
		t.Fatalf("expected 3, got %d", len(list))
	}
	// Most recent first
	if list[0].ID != "bl-3" {
		t.Errorf("first = %q, want bl-3 (most recent)", list[0].ID)
	}

	// Limit
	list, err = d.ListBaselines(2)
	if err != nil {
		t.Fatalf("ListBaselines limit: %v", err)
	}
	if len(list) != 2 {
		t.Fatalf("expected 2 with limit, got %d", len(list))
	}

	// Default limit (0 → 50)
	list, err = d.ListBaselines(0)
	if err != nil {
		t.Fatalf("ListBaselines default: %v", err)
	}
	if len(list) != 3 {
		t.Fatalf("expected 3 with default limit, got %d", len(list))
	}
}

func TestDeleteBaseline(t *testing.T) {
	d := openTestDB(t)

	b := &model.Baseline{
		ID:         "bl-del",
		CommitID:   "abc",
		BySeverity: map[string]int{},
		ByStatus:   map[string]int{},
		FindingIDs: []string{},
	}
	if err := d.CreateBaseline(b); err != nil {
		t.Fatalf("CreateBaseline: %v", err)
	}

	if err := d.DeleteBaseline("bl-del"); err != nil {
		t.Fatalf("DeleteBaseline: %v", err)
	}

	got, err := d.GetBaselineByID("bl-del")
	if err != nil {
		t.Fatalf("GetBaselineByID after delete: %v", err)
	}
	if got != nil {
		t.Error("baseline should be nil after delete")
	}

	// Deleting non-existent returns error
	if err := d.DeleteBaseline("nope"); err == nil {
		t.Error("expected error deleting non-existent baseline")
	}
}

func TestBaselineProjectIsolation(t *testing.T) {
	d := openTestDB(t)

	// Insert baselines for two projects directly
	d.conn.Exec(`INSERT INTO baselines (id, project_id, commit_id, reviewer, summary, created_at,
		findings_total, findings_open, by_severity, by_status, comments_total, comments_open, finding_ids)
		VALUES ('bl-a', 'proj_a', 'aaa', '', '', '2024-01-01 00:00:00', 0, 0, '{}', '{}', 0, 0, '[]')`)
	d.conn.Exec(`INSERT INTO baselines (id, project_id, commit_id, reviewer, summary, created_at,
		findings_total, findings_open, by_severity, by_status, comments_total, comments_open, finding_ids)
		VALUES ('bl-b', 'proj_b', 'bbb', '', '', '2024-01-01 00:00:00', 0, 0, '{}', '{}', 0, 0, '[]')`)

	// _standalone project should see neither
	list, err := d.ListBaselines(10)
	if err != nil {
		t.Fatalf("ListBaselines: %v", err)
	}
	if len(list) != 0 {
		t.Fatalf("standalone should see 0 baselines, got %d", len(list))
	}

	// _standalone can't get proj_a's baseline
	got, err := d.GetBaselineByID("bl-a")
	if err != nil {
		t.Fatalf("GetBaselineByID: %v", err)
	}
	if got != nil {
		t.Error("standalone should not see proj_a's baseline")
	}

	// _standalone can't delete proj_a's baseline
	if err := d.DeleteBaseline("bl-a"); err == nil {
		t.Error("standalone should not be able to delete proj_a's baseline")
	}
}

func TestAllFindingIDs(t *testing.T) {
	d := openTestDB(t)

	// Empty
	ids, err := d.AllFindingIDs()
	if err != nil {
		t.Fatalf("AllFindingIDs empty: %v", err)
	}
	if len(ids) != 0 {
		t.Fatalf("expected 0 IDs, got %d", len(ids))
	}

	// Insert findings
	for _, id := range []string{"f1", "f2", "f3"} {
		d.conn.Exec(`INSERT INTO findings (id, project_id, anchor_file_id, anchor_commit_id, severity, title, status, source)
			VALUES (?, '_standalone', 'src/a.go', 'aaa', 'high', 'test', 'open', 'mcp')`, id)
	}

	ids, err = d.AllFindingIDs()
	if err != nil {
		t.Fatalf("AllFindingIDs: %v", err)
	}
	if len(ids) != 3 {
		t.Fatalf("expected 3 IDs, got %d", len(ids))
	}
}

func TestBaselineJSONFields(t *testing.T) {
	d := openTestDB(t)

	b := &model.Baseline{
		ID:         "bl-json",
		CommitID:   "abc",
		BySeverity: map[string]int{"critical": 2, "low": 5},
		ByStatus:   map[string]int{"open": 3, "closed": 4},
		FindingIDs: []string{"f-a", "f-b"},
	}
	if err := d.CreateBaseline(b); err != nil {
		t.Fatalf("CreateBaseline: %v", err)
	}

	got, err := d.GetBaselineByID("bl-json")
	if err != nil {
		t.Fatalf("GetBaselineByID: %v", err)
	}
	if got.BySeverity["critical"] != 2 || got.BySeverity["low"] != 5 {
		t.Errorf("bySeverity mismatch: %v", got.BySeverity)
	}
	if got.ByStatus["open"] != 3 || got.ByStatus["closed"] != 4 {
		t.Errorf("byStatus mismatch: %v", got.ByStatus)
	}
	if len(got.FindingIDs) != 2 || got.FindingIDs[0] != "f-a" || got.FindingIDs[1] != "f-b" {
		t.Errorf("findingIDs mismatch: %v", got.FindingIDs)
	}
}
