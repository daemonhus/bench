package reconcile

import (
	"strings"
	"testing"
)

// ---------------------------------------------------------------------------
// ParseDiffHunks tests
// ---------------------------------------------------------------------------

func TestParseDiffHunks_Empty(t *testing.T) {
	hunks := ParseDiffHunks("")
	if len(hunks) != 0 {
		t.Fatalf("expected 0 hunks, got %d", len(hunks))
	}
}

func TestParseDiffHunks_SingleHunk(t *testing.T) {
	raw := strings.Join([]string{
		"diff --git a/file.txt b/file.txt",
		"index abc..def 100644",
		"--- a/file.txt",
		"+++ b/file.txt",
		"@@ -3,5 +3,6 @@ some context",
		" line 3",
		" line 4",
		"-old line 5",
		"+new line 5a",
		"+new line 5b",
		" line 6",
		" line 7",
	}, "\n")

	hunks := ParseDiffHunks(raw)
	if len(hunks) != 1 {
		t.Fatalf("expected 1 hunk, got %d", len(hunks))
	}

	h := hunks[0]
	if h.OldStart != 3 || h.OldCount != 5 || h.NewStart != 3 || h.NewCount != 6 {
		t.Fatalf("hunk header: got old=%d,%d new=%d,%d", h.OldStart, h.OldCount, h.NewStart, h.NewCount)
	}

	// 4 context + 1 delete + 2 insert = 7 lines
	if len(h.Lines) != 7 {
		t.Fatalf("expected 7 lines, got %d", len(h.Lines))
	}

	// Verify context lines have both old/new numbers
	assertLine(t, h.Lines[0], Context, 3, 3)
	assertLine(t, h.Lines[1], Context, 4, 4)
	assertLine(t, h.Lines[2], Delete, 5, 0)
	assertLine(t, h.Lines[3], Insert, 0, 5)
	assertLine(t, h.Lines[4], Insert, 0, 6)
	assertLine(t, h.Lines[5], Context, 6, 7)
	assertLine(t, h.Lines[6], Context, 7, 8)
}

func TestParseDiffHunks_MultipleHunks(t *testing.T) {
	raw := strings.Join([]string{
		"@@ -1,3 +1,2 @@",
		" line 1",
		"-line 2",
		" line 3",
		"@@ -10,3 +9,4 @@",
		" line 10",
		"+inserted",
		" line 11",
		" line 12",
	}, "\n")

	hunks := ParseDiffHunks(raw)
	if len(hunks) != 2 {
		t.Fatalf("expected 2 hunks, got %d", len(hunks))
	}

	if hunks[0].OldStart != 1 || hunks[0].OldCount != 3 {
		t.Fatalf("hunk 0 old: %d,%d", hunks[0].OldStart, hunks[0].OldCount)
	}
	if hunks[1].OldStart != 10 || hunks[1].NewCount != 4 {
		t.Fatalf("hunk 1: old=%d,%d new=%d,%d", hunks[1].OldStart, hunks[1].OldCount, hunks[1].NewStart, hunks[1].NewCount)
	}
}

func TestParseDiffHunks_CountDefaultsToOne(t *testing.T) {
	// When count is omitted, it defaults to 1
	raw := "@@ -5 +5,2 @@\n-old\n+new1\n+new2"
	hunks := ParseDiffHunks(raw)
	if len(hunks) != 1 {
		t.Fatalf("expected 1 hunk, got %d", len(hunks))
	}
	if hunks[0].OldCount != 1 {
		t.Fatalf("expected OldCount=1, got %d", hunks[0].OldCount)
	}
}

func TestParseDiffHunks_PureInsertion(t *testing.T) {
	raw := "@@ -5,0 +6,2 @@\n+new line 1\n+new line 2"
	hunks := ParseDiffHunks(raw)
	if len(hunks) != 1 {
		t.Fatalf("expected 1 hunk, got %d", len(hunks))
	}
	h := hunks[0]
	if h.OldCount != 0 {
		t.Fatalf("expected OldCount=0, got %d", h.OldCount)
	}
	if len(h.Lines) != 2 {
		t.Fatalf("expected 2 lines, got %d", len(h.Lines))
	}
	assertLine(t, h.Lines[0], Insert, 0, 6)
	assertLine(t, h.Lines[1], Insert, 0, 7)
}

func TestParseDiffHunks_PureDeletion(t *testing.T) {
	raw := "@@ -5,2 +4,0 @@\n-deleted 1\n-deleted 2"
	hunks := ParseDiffHunks(raw)
	if len(hunks) != 1 {
		t.Fatalf("expected 1 hunk, got %d", len(hunks))
	}
	h := hunks[0]
	if h.NewCount != 0 {
		t.Fatalf("expected NewCount=0, got %d", h.NewCount)
	}
	assertLine(t, h.Lines[0], Delete, 5, 0)
	assertLine(t, h.Lines[1], Delete, 6, 0)
}

func TestParseDiffHunks_NoNewlineMarker(t *testing.T) {
	raw := strings.Join([]string{
		"@@ -1,2 +1,2 @@",
		"-old",
		"+new",
		" same",
		`\ No newline at end of file`,
	}, "\n")

	hunks := ParseDiffHunks(raw)
	if len(hunks) != 1 {
		t.Fatalf("expected 1 hunk, got %d", len(hunks))
	}
	// "\ No newline" should be skipped
	if len(hunks[0].Lines) != 3 {
		t.Fatalf("expected 3 lines, got %d", len(hunks[0].Lines))
	}
}

// ---------------------------------------------------------------------------
// MapLineRange tests
// ---------------------------------------------------------------------------

func TestMapLineRange_EmptyHunks(t *testing.T) {
	// No diff = identity mapping
	ns, ne, ok := MapLineRange(10, 15, nil)
	if !ok || ns != 10 || ne != 15 {
		t.Fatalf("expected (10, 15, true), got (%d, %d, %v)", ns, ne, ok)
	}
}

func TestMapLineRange_InvalidRange(t *testing.T) {
	hunks := []DiffHunk{{OldStart: 1, OldCount: 1, NewStart: 1, NewCount: 1}}
	_, _, ok := MapLineRange(10, 5, hunks) // start > end
	if ok {
		t.Fatal("expected ok=false for start > end")
	}
	_, _, ok = MapLineRange(0, 5, hunks) // start < 1
	if ok {
		t.Fatal("expected ok=false for start < 1")
	}
}

func TestMapLineRange_SingleLine(t *testing.T) {
	// Single-line annotation, no diff touching it
	ns, ne, ok := MapLineRange(5, 5, nil)
	if !ok || ns != 5 || ne != 5 {
		t.Fatalf("expected (5, 5, true), got (%d, %d, %v)", ns, ne, ok)
	}
}

func TestMapLineRange_BeforeHunk(t *testing.T) {
	// Annotation at lines 2-3, hunk starts at line 10
	hunks := makeHunks("@@ -10,3 +10,4 @@\n line 10\n+inserted\n line 11\n line 12")
	ns, ne, ok := MapLineRange(2, 3, hunks)
	if !ok || ns != 2 || ne != 3 {
		t.Fatalf("expected (2, 3, true), got (%d, %d, %v)", ns, ne, ok)
	}
}

func TestMapLineRange_AfterHunk_ShiftedDown(t *testing.T) {
	// Hunk inserts 1 line (net +1), annotation is after the hunk
	hunks := makeHunks("@@ -5,3 +5,4 @@\n line 5\n+inserted\n line 6\n line 7")
	// Annotation at lines 20-22 (after hunk covering 5-7)
	ns, ne, ok := MapLineRange(20, 22, hunks)
	if !ok || ns != 21 || ne != 23 {
		t.Fatalf("expected (21, 23, true), got (%d, %d, %v)", ns, ne, ok)
	}
}

func TestMapLineRange_AfterHunk_ShiftedUp(t *testing.T) {
	// Hunk deletes 1 line (net -1), annotation is after the hunk
	hunks := makeHunks("@@ -5,3 +5,2 @@\n line 5\n-deleted\n line 7")
	ns, ne, ok := MapLineRange(20, 22, hunks)
	if !ok || ns != 19 || ne != 21 {
		t.Fatalf("expected (19, 21, true), got (%d, %d, %v)", ns, ne, ok)
	}
}

func TestMapLineRange_InsideHunk_ContextLines(t *testing.T) {
	// Annotation lines are context lines within a hunk (unchanged)
	hunks := makeHunks(strings.Join([]string{
		"@@ -3,7 +3,8 @@",
		" line 3",
		" line 4",
		"-deleted line 5",
		"+new line 5a",
		"+new line 5b",
		" line 6",
		" line 7",
		" line 8",
		" line 9",
	}, "\n"))

	// Annotation at old lines 6-7 (context lines within the hunk)
	ns, ne, ok := MapLineRange(6, 7, hunks)
	if !ok {
		t.Fatal("expected ok=true for context lines within hunk")
	}
	// Delete 1 line + insert 2 = net +1, so lines 6,7 shift to 7,8
	if ns != 7 || ne != 8 {
		t.Fatalf("expected (7, 8), got (%d, %d)", ns, ne)
	}
}

func TestMapLineRange_InsideHunk_DeletedLine(t *testing.T) {
	hunks := makeHunks(strings.Join([]string{
		"@@ -3,5 +3,4 @@",
		" line 3",
		" line 4",
		"-deleted line 5",
		" line 6",
		" line 7",
	}, "\n"))

	// Annotation at old lines 4-6 spans a deleted line
	_, _, ok := MapLineRange(4, 6, hunks)
	if ok {
		t.Fatal("expected ok=false when annotation spans a deleted line")
	}
}

func TestMapLineRange_DeletedLineExactly(t *testing.T) {
	hunks := makeHunks("@@ -5,3 +5,2 @@\n line 5\n-deleted\n line 7")
	_, _, ok := MapLineRange(6, 6, hunks)
	if ok {
		t.Fatal("expected ok=false for a single deleted line")
	}
}

func TestMapLineRange_BetweenTwoHunks(t *testing.T) {
	// Hunk 1: net -1, Hunk 2: net +2. Annotation between them.
	raw := strings.Join([]string{
		"@@ -3,3 +3,2 @@",
		" line 3",
		"-deleted",
		" line 5",
		"@@ -15,3 +14,5 @@",
		" line 15",
		"+new A",
		"+new B",
		" line 16",
		" line 17",
	}, "\n")
	hunks := makeHunks(raw)

	// Annotation at old lines 10-12 (between hunk1 ending at old 5 and hunk2 starting at old 15)
	ns, ne, ok := MapLineRange(10, 12, hunks)
	if !ok {
		t.Fatal("expected ok=true for lines between hunks")
	}
	// Offset from hunk 1: 2 - 3 = -1
	if ns != 9 || ne != 11 {
		t.Fatalf("expected (9, 11), got (%d, %d)", ns, ne)
	}
}

func TestMapLineRange_AfterTwoHunks(t *testing.T) {
	raw := strings.Join([]string{
		"@@ -3,3 +3,2 @@",
		" line 3",
		"-deleted",
		" line 5",
		"@@ -15,3 +14,5 @@",
		" line 15",
		"+new A",
		"+new B",
		" line 16",
		" line 17",
	}, "\n")
	hunks := makeHunks(raw)

	// After both hunks: cumulative offset = (2-3) + (5-3) = -1 + 2 = +1
	ns, ne, ok := MapLineRange(30, 32, hunks)
	if !ok {
		t.Fatal("expected ok=true for lines after all hunks")
	}
	if ns != 31 || ne != 33 {
		t.Fatalf("expected (31, 33), got (%d, %d)", ns, ne)
	}
}

func TestMapLineRange_PureInsertionHunk(t *testing.T) {
	// Pure insertion: 0 old lines, 3 new lines
	hunks := makeHunks("@@ -5,0 +6,3 @@\n+a\n+b\n+c")

	// Lines before the insertion point: no shift
	ns, ne, ok := MapLineRange(3, 4, hunks)
	if !ok || ns != 3 || ne != 4 {
		t.Fatalf("expected (3, 4, true), got (%d, %d, %v)", ns, ne, ok)
	}

	// Lines after: shifted by +3
	ns, ne, ok = MapLineRange(10, 12, hunks)
	if !ok || ns != 13 || ne != 15 {
		t.Fatalf("expected (13, 15, true), got (%d, %d, %v)", ns, ne, ok)
	}
}

func TestMapLineRange_PureDeletionHunk(t *testing.T) {
	// 2 old lines deleted, 0 new lines
	hunks := makeHunks("@@ -5,2 +4,0 @@\n-line 5\n-line 6")

	// Lines 5-6 are deleted
	_, _, ok := MapLineRange(5, 6, hunks)
	if ok {
		t.Fatal("expected ok=false for deleted lines")
	}

	// Lines after: shifted by -2
	ns, ne, ok := MapLineRange(10, 12, hunks)
	if !ok || ns != 8 || ne != 10 {
		t.Fatalf("expected (8, 10, true), got (%d, %d, %v)", ns, ne, ok)
	}
}

func TestMapLineRange_AnnotationAtLine1(t *testing.T) {
	hunks := makeHunks("@@ -1,2 +1,3 @@\n line 1\n+inserted\n line 2")
	// Line 1 is a context line in the hunk
	ns, ne, ok := MapLineRange(1, 1, hunks)
	if !ok || ns != 1 || ne != 1 {
		t.Fatalf("expected (1, 1, true), got (%d, %d, %v)", ns, ne, ok)
	}
}

func TestMapLineRange_AnnotationExpandsWithInsertion(t *testing.T) {
	// Lines 3-5 have an insertion between them
	raw := strings.Join([]string{
		"@@ -3,3 +3,4 @@",
		" line 3",
		"+inserted between 3 and 4",
		" line 4",
		" line 5",
	}, "\n")
	hunks := makeHunks(raw)

	// Old lines 3-5 map to new lines 3,5,6 (skipping inserted line 4)
	ns, ne, ok := MapLineRange(3, 5, hunks)
	if !ok {
		t.Fatal("expected ok=true — all old lines survived")
	}
	// line 3 → 3, line 4 → 5, line 5 → 6
	if ns != 3 || ne != 6 {
		t.Fatalf("expected (3, 6), got (%d, %d)", ns, ne)
	}
}

func TestMapLineRange_ComplexMultiHunk(t *testing.T) {
	// Real-world-ish diff with 3 hunks
	raw := strings.Join([]string{
		"@@ -1,4 +1,4 @@",
		" line 1",
		"-old line 2",
		"+new line 2",
		" line 3",
		" line 4",
		"@@ -10,3 +10,5 @@",
		" line 10",
		"+added A",
		"+added B",
		" line 11",
		" line 12",
		"@@ -20,3 +22,2 @@",
		" line 20",
		"-deleted 21",
		" line 22",
	}, "\n")
	hunks := makeHunks(raw)

	// Line 1 (context in hunk 1): mapped
	ns, _, ok := MapLineRange(1, 1, hunks)
	if !ok || ns != 1 {
		t.Fatalf("line 1: expected (1, true), got (%d, %v)", ns, ok)
	}

	// Line 2 (deleted in hunk 1): fails
	_, _, ok = MapLineRange(2, 2, hunks)
	if ok {
		t.Fatal("line 2 was deleted, expected ok=false")
	}

	// Lines 6-8 (between hunk 1 and 2, hunk 1 has net 0 offset)
	ns, ne, ok := MapLineRange(6, 8, hunks)
	if !ok || ns != 6 || ne != 8 {
		t.Fatalf("lines 6-8: expected (6, 8, true), got (%d, %d, %v)", ns, ne, ok)
	}

	// Lines 14-16 (between hunk 2 and 3, cumulative offset: 0 + 2 = +2)
	ns, ne, ok = MapLineRange(14, 16, hunks)
	if !ok || ns != 16 || ne != 18 {
		t.Fatalf("lines 14-16: expected (16, 18, true), got (%d, %d, %v)", ns, ne, ok)
	}

	// Lines 25-26 (after all hunks, cumulative offset: 0 + 2 + (-1) = +1)
	ns, ne, ok = MapLineRange(25, 26, hunks)
	if !ok || ns != 26 || ne != 27 {
		t.Fatalf("lines 25-26: expected (26, 27, true), got (%d, %d, %v)", ns, ne, ok)
	}
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

func makeHunks(raw string) []DiffHunk {
	return ParseDiffHunks(raw)
}

func assertLine(t *testing.T, dl DiffLine, typ LineType, oldNo, newNo int) {
	t.Helper()
	if dl.Type != typ {
		t.Errorf("expected type %c, got %c", typ, dl.Type)
	}
	if dl.OldNo != oldNo {
		t.Errorf("expected OldNo=%d, got %d", oldNo, dl.OldNo)
	}
	if dl.NewNo != newNo {
		t.Errorf("expected NewNo=%d, got %d", newNo, dl.NewNo)
	}
}
