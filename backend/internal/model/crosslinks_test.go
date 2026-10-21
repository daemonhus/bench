package model

import (
	"errors"
	"slices"
	"testing"
)

type stubCross struct{ CrossLinks }

func (stubCross) Self() string { return "alpha" }

func TestSplitRefs(t *testing.T) {
	local, foreign, err := SplitRefs(stubCross{}, []string{"f1", "alpha:f2", "beta:f3"})
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(local, []string{"f1", "f2"}) || !slices.Equal(foreign, []string{"beta:f3"}) {
		t.Fatalf("local %v foreign %v", local, foreign)
	}
	// A standalone workbench (no cross store) takes its own ids and refuses the rest.
	if local, _, err := SplitRefs(nil, []string{"f1"}); err != nil || !slices.Equal(local, []string{"f1"}) {
		t.Fatalf("plain ids: %v %v", local, err)
	}
	if _, _, err := SplitRefs(nil, []string{"beta:f3"}); !errors.Is(err, ErrUnknownFeature) {
		t.Fatalf("want ErrUnknownFeature, got %v", err)
	}
	if _, _, ok := SplitCrossRef(":x"); ok {
		t.Fatal(`":x" is not a reference`)
	}
}
