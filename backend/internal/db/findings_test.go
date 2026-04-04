package db

import (
	"testing"

	"bench/internal/model"
)

func TestCreateFinding(t *testing.T) {
	d := openTestDB(t)

	f := &model.Finding{
		ID:          "f1",
		Anchor:      model.Anchor{FileID: "src/a.go", CommitID: "abc123"},
		Severity:    "high",
		Title:       "SQL injection",
		Description: "user input concatenated",
		Status:      "open",
		Source:      "mcp",
		Category:    "injection",
	}
	if err := d.CreateFinding(f); err != nil {
		t.Fatalf("CreateFinding: %v", err)
	}

	got, err := d.GetFinding("f1")
	if err != nil {
		t.Fatalf("GetFinding: %v", err)
	}
	if got.Title != "SQL injection" {
		t.Errorf("title = %q, want 'SQL injection'", got.Title)
	}
	if got.Severity != "high" {
		t.Errorf("severity = %q, want 'high'", got.Severity)
	}
	if got.Category != "injection" {
		t.Errorf("category = %q, want 'injection'", got.Category)
	}
	if got.Anchor.FileID != "src/a.go" {
		t.Errorf("fileId = %q, want 'src/a.go'", got.Anchor.FileID)
	}
}

func TestCreateFinding_WithLineRange(t *testing.T) {
	d := openTestDB(t)

	f := &model.Finding{
		ID:       "f1",
		Anchor:   model.Anchor{FileID: "src/a.go", CommitID: "abc", LineRange: &model.LineRange{Start: 10, End: 20}},
		Severity: "low",
		Title:    "info leak",
		Status:   "draft",
		Source:   "mcp",
	}
	if err := d.CreateFinding(f); err != nil {
		t.Fatalf("CreateFinding with line range: %v", err)
	}

	got, err := d.GetFinding("f1")
	if err != nil {
		t.Fatalf("GetFinding: %v", err)
	}
	if got.Anchor.LineRange == nil {
		t.Fatal("expected line range, got nil")
	}
	if got.Anchor.LineRange.Start != 10 || got.Anchor.LineRange.End != 20 {
		t.Errorf("line range = %d-%d, want 10-20", got.Anchor.LineRange.Start, got.Anchor.LineRange.End)
	}
}

func TestListFindings(t *testing.T) {
	d := openTestDB(t)

	for _, f := range []model.Finding{
		{ID: "f1", Anchor: model.Anchor{FileID: "src/a.go", CommitID: "abc"}, Severity: "high", Title: "A", Status: "open", Source: "mcp"},
		{ID: "f2", Anchor: model.Anchor{FileID: "src/a.go", CommitID: "abc"}, Severity: "medium", Title: "B", Status: "open", Source: "mcp"},
		{ID: "f3", Anchor: model.Anchor{FileID: "src/b.go", CommitID: "abc"}, Severity: "low", Title: "C", Status: "open", Source: "mcp"},
	} {
		if err := d.CreateFinding(&f); err != nil {
			t.Fatalf("CreateFinding %s: %v", f.ID, err)
		}
	}

	// No filter
	all, total, err := d.ListFindings("", 0, 0)
	if err != nil {
		t.Fatalf("ListFindings all: %v", err)
	}
	if len(all) != 3 || total != 3 {
		t.Fatalf("got %d/%d, want 3/3", len(all), total)
	}

	// Filter by fileID
	filtered, _, err := d.ListFindings("src/a.go", 0, 0)
	if err != nil {
		t.Fatalf("ListFindings fileID: %v", err)
	}
	if len(filtered) != 2 {
		t.Fatalf("got %d, want 2 for src/a.go", len(filtered))
	}

	// Pagination
	page, total, err := d.ListFindings("", 2, 0)
	if err != nil {
		t.Fatalf("ListFindings paginated: %v", err)
	}
	if len(page) != 2 {
		t.Fatalf("page len = %d, want 2", len(page))
	}
	if total != 3 {
		t.Fatalf("total = %d, want 3", total)
	}
}

func TestCreateFinding_WithFeatureIDs(t *testing.T) {
	d := openTestDB(t)

	// Create two features to associate
	for _, feat := range []model.Feature{
		{ID: "feat1", Anchor: model.Anchor{FileID: "src/a.go", CommitID: "abc"}, Kind: "interface", Title: "Login", Status: "active", Tags: []string{}},
		{ID: "feat2", Anchor: model.Anchor{FileID: "src/b.go", CommitID: "abc"}, Kind: "sink", Title: "DB write", Status: "active", Tags: []string{}},
	} {
		if err := d.CreateFeature(&feat); err != nil {
			t.Fatalf("CreateFeature: %v", err)
		}
	}

	f := &model.Finding{
		ID:         "f1",
		Anchor:     model.Anchor{FileID: "src/a.go", CommitID: "abc"},
		Severity:   "high",
		Title:      "Injection",
		Status:     "open",
		Source:     "mcp",
		FeatureIDs: []string{"feat1", "feat2"},
	}
	if err := d.CreateFinding(f); err != nil {
		t.Fatalf("CreateFinding: %v", err)
	}

	got, err := d.GetFinding("f1")
	if err != nil {
		t.Fatalf("GetFinding: %v", err)
	}
	if len(got.FeatureIDs) != 2 {
		t.Fatalf("featureIds len = %d, want 2", len(got.FeatureIDs))
	}

	list, _, err := d.ListFindings("", 0, 0)
	if err != nil {
		t.Fatalf("ListFindings: %v", err)
	}
	if len(list[0].FeatureIDs) != 2 {
		t.Errorf("list[0].featureIds len = %d, want 2", len(list[0].FeatureIDs))
	}
}

func TestUpdateFinding_FeatureIDs_Replace(t *testing.T) {
	d := openTestDB(t)

	for _, feat := range []model.Feature{
		{ID: "feat1", Anchor: model.Anchor{FileID: "src/a.go", CommitID: "abc"}, Kind: "interface", Title: "A", Status: "active", Tags: []string{}},
		{ID: "feat2", Anchor: model.Anchor{FileID: "src/b.go", CommitID: "abc"}, Kind: "sink", Title: "B", Status: "active", Tags: []string{}},
	} {
		d.CreateFeature(&feat)
	}

	f := &model.Finding{
		ID: "f1", Anchor: model.Anchor{FileID: "src/a.go", CommitID: "abc"},
		Severity: "low", Title: "x", Status: "open", Source: "mcp",
		FeatureIDs: []string{"feat1"},
	}
	d.CreateFinding(f)

	// Replace with feat2 only
	updated, err := d.UpdateFinding("f1", map[string]any{"featureIds": []string{"feat2"}})
	if err != nil {
		t.Fatalf("UpdateFinding: %v", err)
	}
	if len(updated.FeatureIDs) != 1 || updated.FeatureIDs[0] != "feat2" {
		t.Errorf("featureIds = %v, want [feat2]", updated.FeatureIDs)
	}

	// Clear all
	cleared, err := d.UpdateFinding("f1", map[string]any{"featureIds": []string{}})
	if err != nil {
		t.Fatalf("UpdateFinding clear: %v", err)
	}
	if len(cleared.FeatureIDs) != 0 {
		t.Errorf("featureIds after clear = %v, want []", cleared.FeatureIDs)
	}
}

func TestDeleteFinding_CleansUpFeatureAssociations(t *testing.T) {
	d := openTestDB(t)

	d.CreateFeature(&model.Feature{ID: "feat1", Anchor: model.Anchor{FileID: "src/a.go", CommitID: "abc"}, Kind: "interface", Title: "A", Status: "active", Tags: []string{}})
	f := &model.Finding{
		ID: "f1", Anchor: model.Anchor{FileID: "src/a.go", CommitID: "abc"},
		Severity: "low", Title: "x", Status: "open", Source: "mcp",
		FeatureIDs: []string{"feat1"},
	}
	d.CreateFinding(f)

	if err := d.DeleteFinding("f1"); err != nil {
		t.Fatalf("DeleteFinding: %v", err)
	}

	// Verify finding_features rows are gone by re-creating the finding without feature IDs
	// and checking it has none
	f2 := &model.Finding{ID: "f1", Anchor: model.Anchor{FileID: "src/a.go", CommitID: "abc"}, Severity: "low", Title: "x", Status: "open", Source: "mcp"}
	d.CreateFinding(f2)
	got, _ := d.GetFinding("f1")
	if len(got.FeatureIDs) != 0 {
		t.Errorf("featureIds after delete+recreate = %v, want []", got.FeatureIDs)
	}
}

func TestDeleteFeature_CleansUpFindingAssociations(t *testing.T) {
	d := openTestDB(t)

	d.CreateFeature(&model.Feature{ID: "feat1", Anchor: model.Anchor{FileID: "src/a.go", CommitID: "abc"}, Kind: "interface", Title: "A", Status: "active", Tags: []string{}})
	f := &model.Finding{
		ID: "f1", Anchor: model.Anchor{FileID: "src/a.go", CommitID: "abc"},
		Severity: "low", Title: "x", Status: "open", Source: "mcp",
		FeatureIDs: []string{"feat1"},
	}
	d.CreateFinding(f)

	// Verify association exists
	got, _ := d.GetFinding("f1")
	if len(got.FeatureIDs) != 1 {
		t.Fatalf("precondition: featureIds = %v, want [feat1]", got.FeatureIDs)
	}

	if err := d.DeleteFeature("feat1"); err != nil {
		t.Fatalf("DeleteFeature: %v", err)
	}

	// Finding should still exist but with no feature associations
	got, err := d.GetFinding("f1")
	if err != nil {
		t.Fatalf("GetFinding after feature delete: %v", err)
	}
	if len(got.FeatureIDs) != 0 {
		t.Errorf("featureIds after feature delete = %v, want []", got.FeatureIDs)
	}
}

func TestBatchCreateFindings_WithFeatureIDs(t *testing.T) {
	d := openTestDB(t)

	d.CreateFeature(&model.Feature{ID: "feat1", Anchor: model.Anchor{FileID: "src/a.go", CommitID: "abc"}, Kind: "interface", Title: "A", Status: "active", Tags: []string{}})

	findings := []model.Finding{
		{
			ID: "f1", Anchor: model.Anchor{FileID: "src/a.go", CommitID: "abc"},
			Severity: "high", Title: "A", Status: "open", Source: "mcp",
			FeatureIDs: []string{"feat1"},
		},
		{
			ID: "f2", Anchor: model.Anchor{FileID: "src/b.go", CommitID: "abc"},
			Severity: "low", Title: "B", Status: "open", Source: "mcp",
		},
	}
	ids, err := d.BatchCreateFindings(findings)
	if err != nil {
		t.Fatalf("BatchCreateFindings: %v", err)
	}
	if len(ids) != 2 {
		t.Fatalf("ids len = %d, want 2", len(ids))
	}

	got, _ := d.GetFinding("f1")
	if len(got.FeatureIDs) != 1 || got.FeatureIDs[0] != "feat1" {
		t.Errorf("f1 featureIds = %v, want [feat1]", got.FeatureIDs)
	}
	got2, _ := d.GetFinding("f2")
	if len(got2.FeatureIDs) != 0 {
		t.Errorf("f2 featureIds = %v, want []", got2.FeatureIDs)
	}
}

func TestBatchResolveFindings(t *testing.T) {
	d := openTestDB(t)

	for _, f := range []model.Finding{
		{ID: "f1", Anchor: model.Anchor{FileID: "a", CommitID: "abc"}, Severity: "high", Title: "A", Status: "open", Source: "mcp"},
		{ID: "f2", Anchor: model.Anchor{FileID: "b", CommitID: "abc"}, Severity: "low", Title: "B", Status: "open", Source: "mcp"},
	} {
		d.CreateFinding(&f)
	}

	n, err := d.BatchResolveFindings([]struct{ ID, Commit string }{
		{"f1", "def"},
		{"f2", "def"},
	})
	if err != nil {
		t.Fatalf("BatchResolveFindings: %v", err)
	}
	if n != 2 {
		t.Errorf("resolved count = %d, want 2", n)
	}

	got, _ := d.GetFinding("f1")
	if got.Status != "closed" {
		t.Errorf("f1 status = %q, want 'closed'", got.Status)
	}
	if got.ResolvedCommit == nil || *got.ResolvedCommit != "def" {
		t.Errorf("f1 resolvedCommit = %v, want 'def'", got.ResolvedCommit)
	}
}
