package reconcile

import (
	"fmt"
	"strings"
	"testing"
	"time"

	"bench/internal/model"
)

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

type mockGit struct {
	headCommit string
	revLists   map[string][]string // "from..to" → commits
	ancestors  map[string]bool     // "ancestor:descendant" → bool
	mergeBases map[string]string   // "a:b" → commit
	diffs      map[string]string   // "from:to:path" → raw diff
	shows      map[string]string   // "commit:path" → content
	renames    map[string]string   // "from:to:path" → new path
}

func (m *mockGit) Head() (string, error) {
	return m.headCommit, nil
}

func (m *mockGit) ResolveRef(ref string) (string, error) {
	return ref, nil // mock: return as-is
}

func (m *mockGit) RevList(from, to string) ([]string, error) {
	key := from + ".." + to
	if commits, ok := m.revLists[key]; ok {
		return commits, nil
	}
	return nil, nil
}

func (m *mockGit) IsAncestor(ancestor, descendant string) (bool, error) {
	key := ancestor + ":" + descendant
	if v, ok := m.ancestors[key]; ok {
		return v, nil
	}
	return false, nil
}

func (m *mockGit) MergeBase(a, b string) (string, error) {
	key := a + ":" + b
	if v, ok := m.mergeBases[key]; ok {
		return v, nil
	}
	key2 := b + ":" + a
	if v, ok := m.mergeBases[key2]; ok {
		return v, nil
	}
	return "", fmt.Errorf("no merge base for %s and %s", a, b)
}

func (m *mockGit) DiffRaw(from, to, path string) (string, error) {
	key := from + ":" + to + ":" + path
	if v, ok := m.diffs[key]; ok {
		return v, nil
	}
	return "", nil // empty diff = no changes
}

func (m *mockGit) Show(commitish, path string) (string, error) {
	key := commitish + ":" + path
	if v, ok := m.shows[key]; ok {
		return v, nil
	}
	return "", fmt.Errorf("not found: %s:%s", commitish, path)
}

func (m *mockGit) DetectRename(from, to, path string) (string, error) {
	key := from + ":" + to + ":" + path
	if v, ok := m.renames[key]; ok {
		return v, nil
	}
	return "", nil
}

type mockPositionStore struct {
	positions []model.AnnotationPosition // all stored positions
}

func (m *mockPositionStore) InsertPosition(p *model.AnnotationPosition) error {
	// Replace if same PK exists
	for i, existing := range m.positions {
		if existing.AnnotationID == p.AnnotationID &&
			existing.AnnotationType == p.AnnotationType &&
			existing.CommitID == p.CommitID {
			m.positions[i] = *p
			return nil
		}
	}
	m.positions = append(m.positions, *p)
	return nil
}

func (m *mockPositionStore) GetPositions(annotationID, annotationType string) ([]model.AnnotationPosition, error) {
	var result []model.AnnotationPosition
	for _, p := range m.positions {
		if p.AnnotationID == annotationID && p.AnnotationType == annotationType {
			result = append(result, p)
		}
	}
	return result, nil
}

func (m *mockPositionStore) DeletePositions(annotationID, annotationType string, commitIDs []string) error {
	idSet := make(map[string]bool, len(commitIDs))
	for _, c := range commitIDs {
		idSet[c] = true
	}
	var kept []model.AnnotationPosition
	for _, p := range m.positions {
		if p.AnnotationID == annotationID && p.AnnotationType == annotationType && idSet[p.CommitID] {
			continue // delete
		}
		kept = append(kept, p)
	}
	m.positions = kept
	return nil
}

type mockAnnotationResolver struct {
	resolved []struct{ ID, Commit string }
	comments []model.Comment
}

func (m *mockAnnotationResolver) BatchResolveFindings(items []struct{ ID, Commit string }) (int, error) {
	m.resolved = append(m.resolved, items...)
	return len(items), nil
}

func (m *mockAnnotationResolver) CreateComment(c *model.Comment) error {
	m.comments = append(m.comments, *c)
	return nil
}

func (m *mockAnnotationResolver) BatchOrphanFeatures(ids []string, orphanCommit string) error {
	return nil
}

type mockReconcileStore struct {
	states map[string]string // fileID → lastCommitID
	files  []string          // annotated files
}

func (m *mockReconcileStore) GetReconciliationState(fileID string) (string, error) {
	return m.states[fileID], nil
}

func (m *mockReconcileStore) SetReconciliationState(fileID, commitID string) error {
	if m.states == nil {
		m.states = make(map[string]string)
	}
	m.states[fileID] = commitID
	return nil
}

func (m *mockReconcileStore) ListAnnotatedFiles() ([]string, error) {
	return m.files, nil
}

type mockAnnotationReader struct {
	findings map[string][]model.Finding // fileID → findings
	comments map[string][]model.Comment // fileID → comments
	features map[string][]model.Feature // fileID → features
}

func (m *mockAnnotationReader) ListFindings(fileID string, limit, offset int) ([]model.Finding, int, error) {
	f := m.findings[fileID]
	return f, len(f), nil
}

func (m *mockAnnotationReader) ListComments(fileID, findingID string, limit, offset int, featureID ...string) ([]model.Comment, int, error) {
	c := m.comments[fileID]
	return c, len(c), nil
}

func (m *mockAnnotationReader) ListFeatures(fileID string, limit, offset int) ([]model.Feature, int, error) {
	f := m.features[fileID]
	return f, len(f), nil
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

func waitForJob(r *Reconciler, jobID string) *JobSnapshot {
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		s := r.GetJob(jobID)
		if s != nil && (s.Status == "done" || s.Status == "failed") {
			return s
		}
		time.Sleep(10 * time.Millisecond)
	}
	return r.GetJob(jobID)
}

func strPtr(s string) *string { return &s }
func intP(n int) *int         { return &n }

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

func TestReconcile_ExactMapping(t *testing.T) {
	// Scenario: finding at lines 10-12 in commit A.
	// Commit B adds a line at line 5 (before the finding), shifting it down.
	git := &mockGit{
		headCommit: "B",
		revLists:   map[string][]string{"A..B": {"B"}},
		ancestors:  map[string]bool{"A:B": true},
		diffs: map[string]string{
			"A:B:src/auth.py": strings.Join([]string{
				"@@ -5,3 +5,4 @@",
				" line 5",
				"+inserted line",
				" line 6",
				" line 7",
			}, "\n"),
		},
		shows: map[string]string{
			"B:src/auth.py": "file exists",
		},
	}
	pos := &mockPositionStore{}
	rec := &mockReconcileStore{
		states: map[string]string{},
		files:  []string{"src/auth.py"},
	}
	ann := &mockAnnotationReader{
		findings: map[string][]model.Finding{
			"src/auth.py": {
				{
					ID:     "FIND-1",
					Anchor: model.Anchor{FileID: "src/auth.py", CommitID: "A", LineRange: &model.LineRange{Start: 10, End: 12}},
				},
			},
		},
	}

	r := NewReconciler(git, pos, rec, ann)
	jobID := r.StartJob("B", nil)
	s := waitForJob(r, jobID)

	if s.Status != "done" {
		t.Fatalf("expected done, got %s: %s", s.Status, s.Error)
	}
	if s.Result.Annotations.Exact != 1 {
		t.Fatalf("expected 1 exact, got %d", s.Result.Annotations.Exact)
	}

	// Verify position: lines 10-12 shifted to 11-13 (net +1 from insertion)
	positions, _ := pos.GetPositions("FIND-1", "finding")
	if len(positions) != 1 {
		t.Fatalf("expected 1 position, got %d", len(positions))
	}
	p := positions[0]
	if p.Confidence != "exact" {
		t.Fatalf("expected exact, got %s", p.Confidence)
	}
	if *p.LineStart != 11 || *p.LineEnd != 13 {
		t.Fatalf("expected lines 11-13, got %d-%d", *p.LineStart, *p.LineEnd)
	}
}

func TestReconcile_ContentHashFallback(t *testing.T) {
	// Scenario: finding at lines 5-6 with a known line hash.
	// Commit B modifies those lines but the same content appears at lines 10-11.
	targetContent := "vulnerable_call(user_input)\nno_sanitization(data)"
	hash := LineHash(strings.Split(targetContent, "\n"))

	git := &mockGit{
		headCommit: "B",
		revLists:   map[string][]string{"A..B": {"B"}},
		ancestors:  map[string]bool{"A:B": true},
		diffs: map[string]string{
			"A:B:src/auth.py": strings.Join([]string{
				"@@ -4,4 +4,3 @@",
				" line 4",
				"-vulnerable_call(user_input)",
				"-no_sanitization(data)",
				" line 7",
			}, "\n"),
		},
		shows: map[string]string{
			// In commit B, the same content appears at lines 10-11
			"B:src/auth.py": "line 1\nline 2\nline 3\nline 4\nline 7\nline 8\nline 9\nline 10\nline 11\nvulnerable_call(user_input)\nno_sanitization(data)\nline 12",
		},
	}
	pos := &mockPositionStore{}
	rec := &mockReconcileStore{states: map[string]string{}, files: []string{"src/auth.py"}}
	ann := &mockAnnotationReader{
		findings: map[string][]model.Finding{
			"src/auth.py": {
				{
					ID:       "FIND-1",
					Anchor:   model.Anchor{FileID: "src/auth.py", CommitID: "A", LineRange: &model.LineRange{Start: 5, End: 6}},
					LineHash: hash,
				},
			},
		},
	}

	r := NewReconciler(git, pos, rec, ann)
	jobID := r.StartJob("B", nil)
	s := waitForJob(r, jobID)

	if s.Status != "done" {
		t.Fatalf("expected done, got %s: %s", s.Status, s.Error)
	}
	if s.Result.Annotations.Moved != 1 {
		t.Fatalf("expected 1 moved, got %d (exact=%d, orphaned=%d)",
			s.Result.Annotations.Moved, s.Result.Annotations.Exact, s.Result.Annotations.Orphaned)
	}

	positions, _ := pos.GetPositions("FIND-1", "finding")
	if len(positions) != 1 {
		t.Fatalf("expected 1 position, got %d", len(positions))
	}
	p := positions[0]
	if p.Confidence != "moved" {
		t.Fatalf("expected moved, got %s", p.Confidence)
	}
	if *p.LineStart != 10 || *p.LineEnd != 11 {
		t.Fatalf("expected lines 10-11, got %d-%d", *p.LineStart, *p.LineEnd)
	}
}

func TestReconcile_Orphaned(t *testing.T) {
	// Scenario: finding at lines 5-6, those lines are deleted, no hash match.
	git := &mockGit{
		headCommit: "B",
		revLists:   map[string][]string{"A..B": {"B"}},
		ancestors:  map[string]bool{"A:B": true},
		diffs: map[string]string{
			"A:B:src/auth.py": strings.Join([]string{
				"@@ -4,4 +4,2 @@",
				" line 4",
				"-line 5",
				"-line 6",
				" line 7",
			}, "\n"),
		},
		shows: map[string]string{
			"B:src/auth.py": "line 1\nline 2\nline 3\nline 4\nline 7\nline 8",
		},
	}
	pos := &mockPositionStore{}
	rec := &mockReconcileStore{states: map[string]string{}, files: []string{"src/auth.py"}}
	ann := &mockAnnotationReader{
		findings: map[string][]model.Finding{
			"src/auth.py": {
				{
					ID:     "FIND-1",
					Anchor: model.Anchor{FileID: "src/auth.py", CommitID: "A", LineRange: &model.LineRange{Start: 5, End: 6}},
					// No LineHash → content match will fail
				},
			},
		},
	}

	r := NewReconciler(git, pos, rec, ann)
	jobID := r.StartJob("B", nil)
	s := waitForJob(r, jobID)

	if s.Status != "done" {
		t.Fatalf("expected done, got %s: %s", s.Status, s.Error)
	}
	if s.Result.Annotations.Orphaned != 1 {
		t.Fatalf("expected 1 orphaned, got %d", s.Result.Annotations.Orphaned)
	}

	positions, _ := pos.GetPositions("FIND-1", "finding")
	if len(positions) != 1 {
		t.Fatalf("expected 1 position, got %d", len(positions))
	}
	if positions[0].Confidence != "orphaned" {
		t.Fatalf("expected orphaned, got %s", positions[0].Confidence)
	}
}

func TestReconcile_EmptyDiff(t *testing.T) {
	// File not touched between commits — positions should stay the same.
	git := &mockGit{
		headCommit: "C",
		revLists:   map[string][]string{"A..C": {"B", "C"}},
		ancestors:  map[string]bool{"A:C": true},
		// No diffs registered → empty diffs
		shows: map[string]string{
			"C:src/auth.py": "file exists",
		},
	}
	pos := &mockPositionStore{}
	rec := &mockReconcileStore{states: map[string]string{}, files: []string{"src/auth.py"}}
	ann := &mockAnnotationReader{
		findings: map[string][]model.Finding{
			"src/auth.py": {
				{
					ID:     "FIND-1",
					Anchor: model.Anchor{FileID: "src/auth.py", CommitID: "A", LineRange: &model.LineRange{Start: 10, End: 12}},
				},
			},
		},
	}

	r := NewReconciler(git, pos, rec, ann)
	jobID := r.StartJob("C", nil)
	s := waitForJob(r, jobID)

	if s.Status != "done" {
		t.Fatalf("expected done, got %s: %s", s.Status, s.Error)
	}
	// Annotation unchanged → still exact at same position
	positions, _ := pos.GetPositions("FIND-1", "finding")
	if len(positions) != 1 {
		t.Fatalf("expected 1 position, got %d", len(positions))
	}
	if *positions[0].LineStart != 10 || *positions[0].LineEnd != 12 {
		t.Fatalf("expected lines 10-12, got %d-%d", *positions[0].LineStart, *positions[0].LineEnd)
	}
}

func TestReconcile_MultiCommitWalk(t *testing.T) {
	// Finding at lines 10-11. Commit B inserts at line 5 (+1), commit C inserts at line 8 (+1).
	// Net effect: lines 10-11 → 12-13.
	git := &mockGit{
		headCommit: "C",
		revLists:   map[string][]string{"A..C": {"B", "C"}},
		ancestors:  map[string]bool{"A:C": true},
		diffs: map[string]string{
			"A:B:src/auth.py": "@@ -5,2 +5,3 @@\n line 5\n+inserted at B\n line 6",
			"B:C:src/auth.py": "@@ -8,2 +8,3 @@\n line 8\n+inserted at C\n line 9",
		},
		shows: map[string]string{"C:src/auth.py": "file exists"},
	}
	pos := &mockPositionStore{}
	rec := &mockReconcileStore{states: map[string]string{}, files: []string{"src/auth.py"}}
	ann := &mockAnnotationReader{
		findings: map[string][]model.Finding{
			"src/auth.py": {
				{
					ID:     "FIND-1",
					Anchor: model.Anchor{FileID: "src/auth.py", CommitID: "A", LineRange: &model.LineRange{Start: 10, End: 11}},
				},
			},
		},
	}

	r := NewReconciler(git, pos, rec, ann)
	jobID := r.StartJob("C", nil)
	s := waitForJob(r, jobID)

	if s.Status != "done" {
		t.Fatalf("expected done, got %s: %s", s.Status, s.Error)
	}

	positions, _ := pos.GetPositions("FIND-1", "finding")
	if len(positions) != 1 {
		t.Fatalf("expected 1 position, got %d", len(positions))
	}
	// +1 from commit B, +1 from commit C = lines 12-13
	if *positions[0].LineStart != 12 || *positions[0].LineEnd != 13 {
		t.Fatalf("expected lines 12-13, got %d-%d", *positions[0].LineStart, *positions[0].LineEnd)
	}
}

func TestReconcile_IncrementalFromLastReconciled(t *testing.T) {
	// File was reconciled to B already. Now reconcile to C.
	// Should only walk B→C, not A→C.
	git := &mockGit{
		headCommit: "C",
		revLists:   map[string][]string{"B..C": {"C"}},
		ancestors:  map[string]bool{"B:C": true},
		diffs: map[string]string{
			"B:C:src/auth.py": "@@ -5,2 +5,3 @@\n line 5\n+new line\n line 6",
		},
		shows: map[string]string{"C:src/auth.py": "file exists"},
	}

	// Pre-existing position from previous reconciliation
	pos := &mockPositionStore{
		positions: []model.AnnotationPosition{
			{
				AnnotationID: "FIND-1", AnnotationType: "finding",
				CommitID: "B", FileID: strPtr("src/auth.py"),
				LineStart: intP(10), LineEnd: intP(12),
				Confidence: "exact",
			},
		},
	}
	rec := &mockReconcileStore{
		states: map[string]string{"src/auth.py": "B"},
		files:  []string{"src/auth.py"},
	}
	ann := &mockAnnotationReader{
		findings: map[string][]model.Finding{
			"src/auth.py": {
				{
					ID:     "FIND-1",
					Anchor: model.Anchor{FileID: "src/auth.py", CommitID: "A", LineRange: &model.LineRange{Start: 10, End: 12}},
				},
			},
		},
	}

	r := NewReconciler(git, pos, rec, ann)
	jobID := r.StartJob("C", nil)
	s := waitForJob(r, jobID)

	if s.Status != "done" {
		t.Fatalf("expected done, got %s: %s", s.Status, s.Error)
	}
	if s.Result.CommitsWalked != 1 {
		t.Fatalf("expected 1 commit walked, got %d", s.Result.CommitsWalked)
	}

	positions, _ := pos.GetPositions("FIND-1", "finding")
	// Should have the original B position + new C position
	if len(positions) != 2 {
		t.Fatalf("expected 2 positions (B + C), got %d", len(positions))
	}
	latest := positions[len(positions)-1]
	// Line 10-12 shifted to 11-13 (net +1)
	if *latest.LineStart != 11 || *latest.LineEnd != 13 {
		t.Fatalf("expected lines 11-13, got %d-%d", *latest.LineStart, *latest.LineEnd)
	}
}

func TestReconcile_MultipleAnnotations(t *testing.T) {
	// Two findings and one comment on the same file.
	git := &mockGit{
		headCommit: "B",
		revLists:   map[string][]string{"A..B": {"B"}},
		ancestors:  map[string]bool{"A:B": true},
		diffs: map[string]string{
			"A:B:src/auth.py": strings.Join([]string{
				"@@ -3,3 +3,4 @@",
				" line 3",
				"+inserted",
				" line 4",
				" line 5",
			}, "\n"),
		},
		shows: map[string]string{"B:src/auth.py": "file exists"},
	}
	pos := &mockPositionStore{}
	rec := &mockReconcileStore{states: map[string]string{}, files: []string{"src/auth.py"}}
	ann := &mockAnnotationReader{
		findings: map[string][]model.Finding{
			"src/auth.py": {
				{
					ID:     "FIND-1",
					Anchor: model.Anchor{FileID: "src/auth.py", CommitID: "A", LineRange: &model.LineRange{Start: 1, End: 2}},
				},
				{
					ID:     "FIND-2",
					Anchor: model.Anchor{FileID: "src/auth.py", CommitID: "A", LineRange: &model.LineRange{Start: 10, End: 12}},
				},
			},
		},
		comments: map[string][]model.Comment{
			"src/auth.py": {
				{
					ID:     "COM-1",
					Anchor: model.Anchor{FileID: "src/auth.py", CommitID: "A", LineRange: &model.LineRange{Start: 20, End: 20}},
				},
			},
		},
	}

	r := NewReconciler(git, pos, rec, ann)
	jobID := r.StartJob("B", nil)
	s := waitForJob(r, jobID)

	if s.Status != "done" {
		t.Fatalf("expected done, got %s: %s", s.Status, s.Error)
	}
	if s.Result.Annotations.Total != 3 {
		t.Fatalf("expected 3 annotations, got %d", s.Result.Annotations.Total)
	}

	// FIND-1 at lines 1-2: before hunk (starts at 3), no shift
	p1, _ := pos.GetPositions("FIND-1", "finding")
	if *p1[0].LineStart != 1 || *p1[0].LineEnd != 2 {
		t.Fatalf("FIND-1: expected 1-2, got %d-%d", *p1[0].LineStart, *p1[0].LineEnd)
	}

	// FIND-2 at lines 10-12: after hunk (ends at 5+1=6), shift +1
	p2, _ := pos.GetPositions("FIND-2", "finding")
	if *p2[0].LineStart != 11 || *p2[0].LineEnd != 13 {
		t.Fatalf("FIND-2: expected 11-13, got %d-%d", *p2[0].LineStart, *p2[0].LineEnd)
	}

	// COM-1 at line 20: after hunk, shift +1
	p3, _ := pos.GetPositions("COM-1", "comment")
	if *p3[0].LineStart != 21 || *p3[0].LineEnd != 21 {
		t.Fatalf("COM-1: expected 21-21, got %d-%d", *p3[0].LineStart, *p3[0].LineEnd)
	}
}

func TestReconcile_GetFileStatus(t *testing.T) {
	git := &mockGit{
		headCommit: "C",
		revLists:   map[string][]string{"A..C": {"B", "C"}},
		ancestors:  map[string]bool{"A:C": true},
	}
	pos := &mockPositionStore{}
	rec := &mockReconcileStore{
		states: map[string]string{"src/auth.py": "A"},
		files:  []string{"src/auth.py"},
	}
	ann := &mockAnnotationReader{}

	r := NewReconciler(git, pos, rec, ann)

	status, err := r.GetFileStatus("src/auth.py", "C")
	if err != nil {
		t.Fatal(err)
	}
	if status.IsReconciled {
		t.Fatal("expected not reconciled")
	}
	if status.CommitsAhead != 2 {
		t.Fatalf("expected 2 commits ahead, got %d", status.CommitsAhead)
	}
}

func TestReconcile_GetFileStatus_Current(t *testing.T) {
	git := &mockGit{headCommit: "C"}
	pos := &mockPositionStore{}
	rec := &mockReconcileStore{
		states: map[string]string{"src/auth.py": "C"},
		files:  []string{"src/auth.py"},
	}
	ann := &mockAnnotationReader{}

	r := NewReconciler(git, pos, rec, ann)

	status, err := r.GetFileStatus("src/auth.py", "C")
	if err != nil {
		t.Fatal(err)
	}
	if !status.IsReconciled {
		t.Fatal("expected reconciled")
	}
}

func TestReconcile_GetReconciledHead_FullyReconciled(t *testing.T) {
	git := &mockGit{
		headCommit: "C",
		ancestors:  map[string]bool{"C:C": true},
	}
	pos := &mockPositionStore{}
	rec := &mockReconcileStore{
		states: map[string]string{
			"src/auth.py": "C",
			"src/db.py":   "C",
		},
		files: []string{"src/auth.py", "src/db.py"},
	}
	ann := &mockAnnotationReader{}

	r := NewReconciler(git, pos, rec, ann)
	head, err := r.GetReconciledHead()
	if err != nil {
		t.Fatal(err)
	}
	if !head.IsFullyReconciled {
		t.Fatal("expected fully reconciled")
	}
	if *head.ReconciledHead != "C" {
		t.Fatalf("expected reconciled head C, got %s", *head.ReconciledHead)
	}
}

func TestReconcile_GetReconciledHead_NoAnnotations(t *testing.T) {
	git := &mockGit{headCommit: "C"}
	pos := &mockPositionStore{}
	rec := &mockReconcileStore{files: []string{}}
	ann := &mockAnnotationReader{}

	r := NewReconciler(git, pos, rec, ann)
	head, err := r.GetReconciledHead()
	if err != nil {
		t.Fatal(err)
	}
	if !head.IsFullyReconciled {
		t.Fatal("expected fully reconciled when no annotations")
	}
	if head.ReconciledHead != nil {
		t.Fatal("expected nil reconciled head when no annotations")
	}
}

func TestReconcile_GetReconciledHead_Partial(t *testing.T) {
	git := &mockGit{
		headCommit: "D",
		revLists: map[string][]string{
			"B..D": {"C", "D"},
			"C..D": {"D"},
		},
		ancestors: map[string]bool{
			"B:D": true,
			"C:D": true,
		},
	}
	pos := &mockPositionStore{}
	rec := &mockReconcileStore{
		states: map[string]string{
			"src/auth.py": "B",
			"src/db.py":   "C",
		},
		files: []string{"src/auth.py", "src/db.py"},
	}
	ann := &mockAnnotationReader{}

	r := NewReconciler(git, pos, rec, ann)
	head, err := r.GetReconciledHead()
	if err != nil {
		t.Fatal(err)
	}
	if head.IsFullyReconciled {
		t.Fatal("expected not fully reconciled")
	}
	if *head.ReconciledHead != "B" {
		t.Fatalf("expected reconciled head B (minimum), got %s", *head.ReconciledHead)
	}
	if len(head.Unreconciled) != 2 {
		t.Fatalf("expected 2 unreconciled files, got %d", len(head.Unreconciled))
	}
}

// ---------------------------------------------------------------------------
// File rename / move scenarios
// ---------------------------------------------------------------------------

func TestReconcile_FileRenamed_ContentHashFollowsRename(t *testing.T) {
	// File renamed from src/auth.py → src/authentication.py.
	// Reconciler detects the rename, retries content hash on the new path,
	// and finds the code at lines 3-4 of the new file.
	targetContent := "def authenticate(user):\n    return check_password(user)"
	hash := LineHash(strings.Split(targetContent, "\n"))

	git := &mockGit{
		headCommit: "B",
		revLists:   map[string][]string{"A..B": {"B"}},
		ancestors:  map[string]bool{"A:B": true},
		diffs: map[string]string{
			// Old path shows full deletion (git diff with no -M flag)
			"A:B:src/auth.py": strings.Join([]string{
				"@@ -1,5 +0,0 @@",
				"-import os",
				"-",
				"-def authenticate(user):",
				"-    return check_password(user)",
				"-",
			}, "\n"),
		},
		renames: map[string]string{
			"A:B:src/auth.py": "src/authentication.py",
		},
		shows: map[string]string{
			// File exists at new path in commit B
			"B:src/authentication.py": "import os\n\ndef authenticate(user):\n    return check_password(user)\n",
		},
	}
	pos := &mockPositionStore{}
	rec := &mockReconcileStore{states: map[string]string{}, files: []string{"src/auth.py"}}
	ann := &mockAnnotationReader{
		findings: map[string][]model.Finding{
			"src/auth.py": {
				{
					ID:       "FIND-1",
					Anchor:   model.Anchor{FileID: "src/auth.py", CommitID: "A", LineRange: &model.LineRange{Start: 3, End: 4}},
					LineHash: hash,
				},
			},
		},
	}

	r := NewReconciler(git, pos, rec, ann)
	jobID := r.StartJob("B", nil)
	s := waitForJob(r, jobID)

	if s.Status != "done" {
		t.Fatalf("expected done, got %s: %s", s.Status, s.Error)
	}

	// Annotation should be "moved" — found via content hash on the renamed file.
	if s.Result.Annotations.Moved != 1 {
		t.Fatalf("expected 1 moved, got orphaned=%d exact=%d moved=%d",
			s.Result.Annotations.Orphaned, s.Result.Annotations.Exact, s.Result.Annotations.Moved)
	}

	positions, _ := pos.GetPositions("FIND-1", "finding")
	if len(positions) != 1 {
		t.Fatalf("expected 1 position, got %d", len(positions))
	}
	p := positions[0]
	if p.Confidence != "moved" {
		t.Fatalf("expected moved, got %s", p.Confidence)
	}
	if p.FileID == nil || *p.FileID != "src/authentication.py" {
		t.Fatalf("expected fileID src/authentication.py, got %v", p.FileID)
	}
	if *p.LineStart != 3 || *p.LineEnd != 4 {
		t.Fatalf("expected lines 3-4, got %d-%d", *p.LineStart, *p.LineEnd)
	}

	// Both old and new paths should be marked as reconciled
	if rec.states["src/authentication.py"] != "B" {
		t.Fatalf("expected new path reconciled to B, got %q", rec.states["src/authentication.py"])
	}
	if rec.states["src/auth.py"] != "B" {
		t.Fatalf("expected old path reconciled to B, got %q", rec.states["src/auth.py"])
	}
}

func TestReconcile_FileDeleted_OrphansAnnotation(t *testing.T) {
	// File genuinely deleted (not renamed). All lines removed, no content match.
	// Annotation should be orphaned — this is correct behaviour.
	git := &mockGit{
		headCommit: "B",
		revLists:   map[string][]string{"A..B": {"B"}},
		ancestors:  map[string]bool{"A:B": true},
		diffs: map[string]string{
			"A:B:src/legacy.py": strings.Join([]string{
				"@@ -1,4 +0,0 @@",
				"-import old_lib",
				"-def old_func():",
				"-    pass",
				"-",
			}, "\n"),
		},
		// File doesn't exist anywhere in commit B
	}
	pos := &mockPositionStore{}
	rec := &mockReconcileStore{states: map[string]string{}, files: []string{"src/legacy.py"}}
	ann := &mockAnnotationReader{
		findings: map[string][]model.Finding{
			"src/legacy.py": {
				{
					ID:     "FIND-1",
					Anchor: model.Anchor{FileID: "src/legacy.py", CommitID: "A", LineRange: &model.LineRange{Start: 2, End: 3}},
				},
			},
		},
	}

	r := NewReconciler(git, pos, rec, ann)
	jobID := r.StartJob("B", nil)
	s := waitForJob(r, jobID)

	if s.Status != "done" {
		t.Fatalf("expected done, got %s: %s", s.Status, s.Error)
	}
	if s.Result.Annotations.Orphaned != 1 {
		t.Fatalf("expected 1 orphaned, got orphaned=%d", s.Result.Annotations.Orphaned)
	}
}

func TestReconcile_FileRenamed_EmptyDiff_DetectedByExistenceCheck(t *testing.T) {
	// Scenario: DiffRaw returns empty (git doesn't see a change to the old
	// path), and DetectRename also returns nothing (e.g., git -M threshold
	// not met). But the file no longer exists at the old path. The
	// post-walk file existence check catches this and orphans the annotation.
	git := &mockGit{
		headCommit: "B",
		revLists:   map[string][]string{"A..B": {"B"}},
		ancestors:  map[string]bool{"A:B": true},
		// No diff registered → DiffRaw returns ""
		// No rename registered → DetectRename returns ""
		// No show registered for old path → Show returns error (file gone)
	}
	pos := &mockPositionStore{}
	rec := &mockReconcileStore{states: map[string]string{}, files: []string{"src/auth.py"}}
	ann := &mockAnnotationReader{
		findings: map[string][]model.Finding{
			"src/auth.py": {
				{
					ID:     "FIND-1",
					Anchor: model.Anchor{FileID: "src/auth.py", CommitID: "A", LineRange: &model.LineRange{Start: 10, End: 12}},
				},
			},
		},
	}

	r := NewReconciler(git, pos, rec, ann)
	jobID := r.StartJob("B", nil)
	s := waitForJob(r, jobID)

	if s.Status != "done" {
		t.Fatalf("expected done, got %s: %s", s.Status, s.Error)
	}

	// File doesn't exist at target commit — existence check catches the phantom
	if s.Result.Annotations.Orphaned != 1 {
		t.Fatalf("expected 1 orphaned, got orphaned=%d exact=%d moved=%d",
			s.Result.Annotations.Orphaned, s.Result.Annotations.Exact, s.Result.Annotations.Moved)
	}

	positions, _ := pos.GetPositions("FIND-1", "finding")
	if len(positions) != 1 {
		t.Fatalf("expected 1 position, got %d", len(positions))
	}
	if positions[0].Confidence != "orphaned" {
		t.Fatalf("expected orphaned, got %s", positions[0].Confidence)
	}
	if positions[0].FileID != nil {
		t.Fatalf("expected nil fileID, got %v", positions[0].FileID)
	}
}

func TestReconcile_ContentMatch_FileStillExists_DifferentLines(t *testing.T) {
	// Code block moved within the same file (not a rename).
	// Lines 5-6 deleted from their original position, same content at lines 20-21.
	// Content hash should find the match. This is the happy path for contentMatch.
	targetContent := "validate_token(jwt)\ncheck_expiry(jwt)"
	hash := LineHash(strings.Split(targetContent, "\n"))

	var fileContent strings.Builder
	for i := 1; i <= 25; i++ {
		if i == 20 {
			fileContent.WriteString("validate_token(jwt)\n")
		} else if i == 21 {
			fileContent.WriteString("check_expiry(jwt)\n")
		} else {
			fileContent.WriteString(fmt.Sprintf("line %d\n", i))
		}
	}

	git := &mockGit{
		headCommit: "B",
		revLists:   map[string][]string{"A..B": {"B"}},
		ancestors:  map[string]bool{"A:B": true},
		diffs: map[string]string{
			"A:B:src/auth.py": strings.Join([]string{
				"@@ -4,4 +4,2 @@",
				" line 4",
				"-validate_token(jwt)",
				"-check_expiry(jwt)",
				" line 7",
			}, "\n"),
		},
		shows: map[string]string{
			"B:src/auth.py": fileContent.String(),
		},
	}
	pos := &mockPositionStore{}
	rec := &mockReconcileStore{states: map[string]string{}, files: []string{"src/auth.py"}}
	ann := &mockAnnotationReader{
		findings: map[string][]model.Finding{
			"src/auth.py": {
				{
					ID:       "FIND-1",
					Anchor:   model.Anchor{FileID: "src/auth.py", CommitID: "A", LineRange: &model.LineRange{Start: 5, End: 6}},
					LineHash: hash,
				},
			},
		},
	}

	r := NewReconciler(git, pos, rec, ann)
	jobID := r.StartJob("B", nil)
	s := waitForJob(r, jobID)

	if s.Status != "done" {
		t.Fatalf("expected done, got %s: %s", s.Status, s.Error)
	}
	if s.Result.Annotations.Moved != 1 {
		t.Fatalf("expected 1 moved, got moved=%d exact=%d orphaned=%d",
			s.Result.Annotations.Moved, s.Result.Annotations.Exact, s.Result.Annotations.Orphaned)
	}

	positions, _ := pos.GetPositions("FIND-1", "finding")
	p := positions[0]
	if p.Confidence != "moved" {
		t.Fatalf("expected moved, got %s", p.Confidence)
	}
	if *p.LineStart != 20 || *p.LineEnd != 21 {
		t.Fatalf("expected lines 20-21, got %d-%d", *p.LineStart, *p.LineEnd)
	}
}

func TestReconcile_OrphanedStaysOrphaned(t *testing.T) {
	// Once an annotation is orphaned, it should stay orphaned even if later
	// commits re-introduce similar code. Verify the "once orphaned, stays
	// orphaned" invariant across multi-commit walks.
	git := &mockGit{
		headCommit: "C",
		revLists:   map[string][]string{"A..C": {"B", "C"}},
		ancestors:  map[string]bool{"A:C": true},
		diffs: map[string]string{
			// Commit B: delete the annotated lines
			"A:B:src/auth.py": strings.Join([]string{
				"@@ -4,4 +4,2 @@",
				" line 4",
				"-vuln_code()",
				"-no_sanitize()",
				" line 7",
			}, "\n"),
			// Commit C: re-add similar code (but annotation should stay orphaned)
			"B:C:src/auth.py": strings.Join([]string{
				"@@ -4,2 +4,4 @@",
				" line 4",
				"+vuln_code()",
				"+no_sanitize()",
				" line 5",
			}, "\n"),
		},
	}
	pos := &mockPositionStore{}
	rec := &mockReconcileStore{states: map[string]string{}, files: []string{"src/auth.py"}}
	ann := &mockAnnotationReader{
		findings: map[string][]model.Finding{
			"src/auth.py": {
				{
					ID:     "FIND-1",
					Anchor: model.Anchor{FileID: "src/auth.py", CommitID: "A", LineRange: &model.LineRange{Start: 5, End: 6}},
					// No LineHash — so content match also fails
				},
			},
		},
	}

	r := NewReconciler(git, pos, rec, ann)
	jobID := r.StartJob("C", nil)
	s := waitForJob(r, jobID)

	if s.Status != "done" {
		t.Fatalf("expected done, got %s: %s", s.Status, s.Error)
	}
	// Orphaned in commit B, should stay orphaned in commit C
	if s.Result.Annotations.Orphaned != 1 {
		t.Fatalf("expected 1 orphaned, got orphaned=%d exact=%d moved=%d",
			s.Result.Annotations.Orphaned, s.Result.Annotations.Exact, s.Result.Annotations.Moved)
	}
}

func TestReconcile_ContentMatch_NoLineHash_CannotRecover(t *testing.T) {
	// Annotation without a stored line hash can't use content hash fallback.
	// If diff mapping fails, it goes straight to orphaned.
	git := &mockGit{
		headCommit: "B",
		revLists:   map[string][]string{"A..B": {"B"}},
		ancestors:  map[string]bool{"A:B": true},
		diffs: map[string]string{
			"A:B:src/auth.py": strings.Join([]string{
				"@@ -4,4 +4,3 @@",
				" line 4",
				"-old_code()",
				" line 6",
				" line 7",
			}, "\n"),
		},
		shows: map[string]string{
			// The code IS present elsewhere in the file, but no hash to find it
			"B:src/auth.py": "line 1\nline 2\nold_code()\nline 4\nline 6\nline 7",
		},
	}
	pos := &mockPositionStore{}
	rec := &mockReconcileStore{states: map[string]string{}, files: []string{"src/auth.py"}}
	ann := &mockAnnotationReader{
		findings: map[string][]model.Finding{
			"src/auth.py": {
				{
					ID:     "FIND-1",
					Anchor: model.Anchor{FileID: "src/auth.py", CommitID: "A", LineRange: &model.LineRange{Start: 5, End: 5}},
					// LineHash intentionally empty
				},
			},
		},
	}

	r := NewReconciler(git, pos, rec, ann)
	jobID := r.StartJob("B", nil)
	s := waitForJob(r, jobID)

	if s.Status != "done" {
		t.Fatalf("expected done, got %s: %s", s.Status, s.Error)
	}
	if s.Result.Annotations.Orphaned != 1 {
		t.Fatalf("expected 1 orphaned (no hash), got orphaned=%d exact=%d moved=%d",
			s.Result.Annotations.Orphaned, s.Result.Annotations.Exact, s.Result.Annotations.Moved)
	}
}

func TestReconcile_IntPtrLine1(t *testing.T) {
	// Edge case: annotation at line 1. intPtr(1) should return &1, not nil.
	// intPtr(0) returns nil (used for orphaned annotations).
	// Verify annotations at line 1 don't get nil pointers.
	git := &mockGit{
		headCommit: "B",
		revLists:   map[string][]string{"A..B": {"B"}},
		ancestors:  map[string]bool{"A:B": true},
		diffs: map[string]string{
			// Insert at line 5 — annotation at line 1 should stay at line 1
			"A:B:src/auth.py": "@@ -5,2 +5,3 @@\n line 5\n+new\n line 6",
		},
		shows: map[string]string{"B:src/auth.py": "file exists"},
	}
	pos := &mockPositionStore{}
	rec := &mockReconcileStore{states: map[string]string{}, files: []string{"src/auth.py"}}
	ann := &mockAnnotationReader{
		findings: map[string][]model.Finding{
			"src/auth.py": {
				{
					ID:     "FIND-1",
					Anchor: model.Anchor{FileID: "src/auth.py", CommitID: "A", LineRange: &model.LineRange{Start: 1, End: 1}},
				},
			},
		},
	}

	r := NewReconciler(git, pos, rec, ann)
	jobID := r.StartJob("B", nil)
	s := waitForJob(r, jobID)

	if s.Status != "done" {
		t.Fatalf("expected done, got %s: %s", s.Status, s.Error)
	}

	positions, _ := pos.GetPositions("FIND-1", "finding")
	if len(positions) != 1 {
		t.Fatalf("expected 1 position, got %d", len(positions))
	}
	p := positions[0]
	if p.LineStart == nil {
		t.Fatal("LineStart is nil — intPtr(1) returned nil (bug)")
	}
	if *p.LineStart != 1 || *p.LineEnd != 1 {
		t.Fatalf("expected lines 1-1, got %d-%d", *p.LineStart, *p.LineEnd)
	}
	if p.Confidence != "exact" {
		t.Fatalf("expected exact, got %s", p.Confidence)
	}
}

// ---------------------------------------------------------------------------
// Auto-resolution of orphaned findings
// ---------------------------------------------------------------------------

func TestReconcile_AutoResolve_OrphanedFinding(t *testing.T) {
	// When a finding is orphaned and a resolver is configured, the reconciler
	// should set status=closed + resolvedCommit, and add a system comment.
	git := &mockGit{
		headCommit: "B",
		revLists:   map[string][]string{"A..B": {"B"}},
		ancestors:  map[string]bool{"A:B": true},
		diffs: map[string]string{
			"A:B:src/auth.py": strings.Join([]string{
				"@@ -4,4 +4,2 @@",
				" line 4",
				"-vuln_call()",
				"-no_sanitize()",
				" line 7",
			}, "\n"),
		},
	}
	pos := &mockPositionStore{}
	rec := &mockReconcileStore{states: map[string]string{}, files: []string{"src/auth.py"}}
	resolver := &mockAnnotationResolver{}
	ann := &mockAnnotationReader{
		findings: map[string][]model.Finding{
			"src/auth.py": {
				{
					ID:     "FIND-1",
					Anchor: model.Anchor{FileID: "src/auth.py", CommitID: "A", LineRange: &model.LineRange{Start: 5, End: 6}},
					Status: "open",
				},
			},
		},
	}

	r := NewReconciler(git, pos, rec, ann, WithResolver(resolver))
	jobID := r.StartJob("B", nil)
	s := waitForJob(r, jobID)

	if s.Status != "done" {
		t.Fatalf("expected done, got %s: %s", s.Status, s.Error)
	}
	if s.Result.Annotations.Orphaned != 1 {
		t.Fatalf("expected 1 orphaned, got %d", s.Result.Annotations.Orphaned)
	}
	if s.Result.Annotations.Resolved != 1 {
		t.Fatalf("expected 1 resolved, got %d", s.Result.Annotations.Resolved)
	}

	// Finding should be resolved
	if len(resolver.resolved) != 1 {
		t.Fatalf("expected 1 resolved finding, got %d", len(resolver.resolved))
	}
	if resolver.resolved[0].ID != "FIND-1" {
		t.Fatalf("expected FIND-1, got %s", resolver.resolved[0].ID)
	}
	if resolver.resolved[0].Commit != "B" {
		t.Fatalf("expected commit B, got %s", resolver.resolved[0].Commit)
	}

	// System comment should be created
	if len(resolver.comments) != 1 {
		t.Fatalf("expected 1 comment, got %d", len(resolver.comments))
	}
	c := resolver.comments[0]
	if c.Author != "system" {
		t.Fatalf("expected author system, got %s", c.Author)
	}
	if c.FindingID == nil || *c.FindingID != "FIND-1" {
		t.Fatalf("expected comment linked to FIND-1, got %v", c.FindingID)
	}
	if c.CommentType != "system" {
		t.Fatalf("expected commentType system, got %s", c.CommentType)
	}
	if !strings.Contains(c.Text, "Automatically closed") {
		t.Fatalf("expected auto-close message, got %q", c.Text)
	}
}

func TestReconcile_AutoResolve_SkipsAlreadyResolved(t *testing.T) {
	// Finding already has resolvedCommit set — should not be resolved again.
	git := &mockGit{
		headCommit: "B",
		revLists:   map[string][]string{"A..B": {"B"}},
		ancestors:  map[string]bool{"A:B": true},
		diffs: map[string]string{
			"A:B:src/auth.py": strings.Join([]string{
				"@@ -4,4 +4,2 @@",
				" line 4",
				"-old()",
				"-code()",
				" line 7",
			}, "\n"),
		},
	}
	pos := &mockPositionStore{}
	rec := &mockReconcileStore{states: map[string]string{}, files: []string{"src/auth.py"}}
	resolver := &mockAnnotationResolver{}
	prevCommit := "prev-commit"
	ann := &mockAnnotationReader{
		findings: map[string][]model.Finding{
			"src/auth.py": {
				{
					ID:             "FIND-1",
					Anchor:         model.Anchor{FileID: "src/auth.py", CommitID: "A", LineRange: &model.LineRange{Start: 5, End: 6}},
					Status:         "closed",
					ResolvedCommit: &prevCommit,
				},
			},
		},
	}

	r := NewReconciler(git, pos, rec, ann, WithResolver(resolver))
	jobID := r.StartJob("B", nil)
	s := waitForJob(r, jobID)

	if s.Status != "done" {
		t.Fatalf("expected done, got %s: %s", s.Status, s.Error)
	}

	// Should NOT have been resolved again
	if len(resolver.resolved) != 0 {
		t.Fatalf("expected 0 resolutions (already resolved), got %d", len(resolver.resolved))
	}
	if len(resolver.comments) != 0 {
		t.Fatalf("expected 0 comments (already resolved), got %d", len(resolver.comments))
	}
}

func TestReconcile_AutoResolve_CommentsNotResolved(t *testing.T) {
	// Comments are orphaned but should NOT be auto-resolved — only findings.
	git := &mockGit{
		headCommit: "B",
		revLists:   map[string][]string{"A..B": {"B"}},
		ancestors:  map[string]bool{"A:B": true},
		diffs: map[string]string{
			"A:B:src/auth.py": strings.Join([]string{
				"@@ -4,4 +4,2 @@",
				" line 4",
				"-old()",
				"-code()",
				" line 7",
			}, "\n"),
		},
	}
	pos := &mockPositionStore{}
	rec := &mockReconcileStore{states: map[string]string{}, files: []string{"src/auth.py"}}
	resolver := &mockAnnotationResolver{}
	ann := &mockAnnotationReader{
		comments: map[string][]model.Comment{
			"src/auth.py": {
				{
					ID:     "COM-1",
					Anchor: model.Anchor{FileID: "src/auth.py", CommitID: "A", LineRange: &model.LineRange{Start: 5, End: 6}},
				},
			},
		},
	}

	r := NewReconciler(git, pos, rec, ann, WithResolver(resolver))
	jobID := r.StartJob("B", nil)
	s := waitForJob(r, jobID)

	if s.Status != "done" {
		t.Fatalf("expected done, got %s: %s", s.Status, s.Error)
	}
	if s.Result.Annotations.Orphaned != 1 {
		t.Fatalf("expected 1 orphaned comment, got %d", s.Result.Annotations.Orphaned)
	}

	// No resolution — only findings are auto-resolved
	if len(resolver.resolved) != 0 {
		t.Fatalf("expected 0 resolutions for comments, got %d", len(resolver.resolved))
	}
	if len(resolver.comments) != 0 {
		t.Fatalf("expected 0 system comments, got %d", len(resolver.comments))
	}
}

func TestReconcile_AutoResolve_NoResolverConfigured(t *testing.T) {
	// Without WithResolver, orphaned findings should NOT be auto-resolved.
	git := &mockGit{
		headCommit: "B",
		revLists:   map[string][]string{"A..B": {"B"}},
		ancestors:  map[string]bool{"A:B": true},
		diffs: map[string]string{
			"A:B:src/auth.py": strings.Join([]string{
				"@@ -4,4 +4,2 @@",
				" line 4",
				"-vuln()",
				"-code()",
				" line 7",
			}, "\n"),
		},
	}
	pos := &mockPositionStore{}
	rec := &mockReconcileStore{states: map[string]string{}, files: []string{"src/auth.py"}}
	ann := &mockAnnotationReader{
		findings: map[string][]model.Finding{
			"src/auth.py": {
				{
					ID:     "FIND-1",
					Anchor: model.Anchor{FileID: "src/auth.py", CommitID: "A", LineRange: &model.LineRange{Start: 5, End: 6}},
					Status: "open",
				},
			},
		},
	}

	// No WithResolver option
	r := NewReconciler(git, pos, rec, ann)
	jobID := r.StartJob("B", nil)
	s := waitForJob(r, jobID)

	if s.Status != "done" {
		t.Fatalf("expected done, got %s: %s", s.Status, s.Error)
	}
	if s.Result.Annotations.Orphaned != 1 {
		t.Fatalf("expected 1 orphaned, got %d", s.Result.Annotations.Orphaned)
	}
	// Resolved should be 0 since no resolver is configured
	if s.Result.Annotations.Resolved != 0 {
		t.Fatalf("expected 0 resolved (no resolver), got %d", s.Result.Annotations.Resolved)
	}
}

func TestReconcile_OrphanedThenReAnchored(t *testing.T) {
	// Scenario: finding is orphaned at commit B (lines deleted).
	// User manually re-anchors it (setting anchor_updated_at).
	// Next reconcile to commit C should respect the manual fix, not stay orphaned.
	anchorUpdated := time.Now().UTC().Format(time.RFC3339)

	git := &mockGit{
		headCommit: "C",
		revLists: map[string][]string{
			"A..B": {"B"},
			"B..C": {"C"},
		},
		ancestors: map[string]bool{
			"A:B": true,
			"B:C": true,
			"A:C": true,
		},
		diffs: map[string]string{},
		shows: map[string]string{
			"C:src/auth.py": "line 1\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\nline 8\nline 9\nline 10\nline 11\nline 12\nline 13\nline 14\nline 15\nnew_vuln_call()\nno_check()\nline 18",
		},
	}

	// Pre-populate an orphaned position at commit B
	pos := &mockPositionStore{
		positions: []model.AnnotationPosition{
			{
				AnnotationID:   "FIND-1",
				AnnotationType: "finding",
				CommitID:       "B",
				FileID:         nil, // orphaned → nil file
				LineStart:      nil,
				LineEnd:        nil,
				Confidence:     "orphaned",
				CreatedAt:      time.Now().Add(-10 * time.Minute).UTC().Format(time.RFC3339),
			},
		},
	}

	rec := &mockReconcileStore{
		states: map[string]string{"src/auth.py": "B"}, // already reconciled to B
		files:  []string{"src/auth.py"},
	}

	// The finding's anchor has been updated (lines 16-17 in the current code)
	ann := &mockAnnotationReader{
		findings: map[string][]model.Finding{
			"src/auth.py": {
				{
					ID:              "FIND-1",
					Anchor:          model.Anchor{FileID: "src/auth.py", CommitID: "A", LineRange: &model.LineRange{Start: 16, End: 17}},
					LineHash:        LineHash([]string{"new_vuln_call()", "no_check()"}),
					AnchorUpdatedAt: &anchorUpdated,
				},
			},
		},
	}

	r := NewReconciler(git, pos, rec, ann)
	jobID := r.StartJob("C", nil)
	s := waitForJob(r, jobID)

	if s.Status != "done" {
		t.Fatalf("expected done, got %s: %s", s.Status, s.Error)
	}

	// The finding should NOT be orphaned — the manual anchor fix should be respected
	if s.Result.Annotations.Orphaned != 0 {
		t.Fatalf("expected 0 orphaned (anchor was re-set), got %d", s.Result.Annotations.Orphaned)
	}

	positions, _ := pos.GetPositions("FIND-1", "finding")
	// Should have the original orphaned position + the new one at C
	if len(positions) < 1 {
		t.Fatalf("expected at least 1 position, got %d", len(positions))
	}
	latest := positions[len(positions)-1]
	if latest.Confidence == "orphaned" {
		t.Fatalf("expected non-orphaned confidence, got orphaned")
	}
	if latest.LineStart == nil || *latest.LineStart != 16 {
		t.Fatalf("expected lineStart=16, got %v", latest.LineStart)
	}
	if latest.LineEnd == nil || *latest.LineEnd != 17 {
		t.Fatalf("expected lineEnd=17, got %v", latest.LineEnd)
	}
}

func TestReconcile_OrphanedWithoutReAnchor_StaysOrphaned(t *testing.T) {
	// Scenario: finding is orphaned at commit B. No manual re-anchor.
	// Next reconcile to commit C should keep it orphaned.
	git := &mockGit{
		headCommit: "C",
		revLists: map[string][]string{
			"B..C": {"C"},
		},
		ancestors: map[string]bool{
			"B:C": true,
		},
		diffs: map[string]string{},
		shows: map[string]string{
			"C:src/auth.py": "line 1\nline 2\nline 3",
		},
	}

	pos := &mockPositionStore{
		positions: []model.AnnotationPosition{
			{
				AnnotationID:   "FIND-1",
				AnnotationType: "finding",
				CommitID:       "B",
				FileID:         nil,
				LineStart:      nil,
				LineEnd:        nil,
				Confidence:     "orphaned",
				CreatedAt:      time.Now().Add(-10 * time.Minute).UTC().Format(time.RFC3339),
			},
		},
	}

	rec := &mockReconcileStore{
		states: map[string]string{"src/auth.py": "B"},
		files:  []string{"src/auth.py"},
	}

	// Finding still has its original anchor lines but NO anchorUpdatedAt
	ann := &mockAnnotationReader{
		findings: map[string][]model.Finding{
			"src/auth.py": {
				{
					ID:     "FIND-1",
					Anchor: model.Anchor{FileID: "src/auth.py", CommitID: "A", LineRange: &model.LineRange{Start: 5, End: 6}},
					// No AnchorUpdatedAt → should stay orphaned
				},
			},
		},
	}

	r := NewReconciler(git, pos, rec, ann)
	jobID := r.StartJob("C", nil)
	s := waitForJob(r, jobID)

	if s.Status != "done" {
		t.Fatalf("expected done, got %s: %s", s.Status, s.Error)
	}
	if s.Result.Annotations.Orphaned != 1 {
		t.Fatalf("expected 1 orphaned (no re-anchor), got %d", s.Result.Annotations.Orphaned)
	}
}
