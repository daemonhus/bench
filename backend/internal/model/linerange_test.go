package model

import (
	"errors"
	"testing"
)

func TestParseLineRange(t *testing.T) {
	cases := []struct {
		start, end int
		want       *LineRange
		invalid    bool
	}{
		{5, 9, &LineRange{5, 9}, false},
		{5, 5, &LineRange{5, 5}, false},
		{5, 0, &LineRange{5, 5}, false}, // no end: just the start line
		{0, 0, nil, false},              // no lines: a file-level anchor
		{0, 9, nil, true},               // an end without a start
		{-1, 0, nil, true},
		{9, 5, nil, true}, // ends before it starts
		{5, -1, nil, true},
	}
	for _, c := range cases {
		got, err := ParseLineRange(c.start, c.end)
		if c.invalid {
			if !errors.Is(err, ErrInvalidLineRange) {
				t.Errorf("ParseLineRange(%d, %d) = %v, %v; want ErrInvalidLineRange", c.start, c.end, got, err)
			}
			continue
		}
		if err != nil || (got == nil) != (c.want == nil) || (got != nil && *got != *c.want) {
			t.Errorf("ParseLineRange(%d, %d) = %v, %v; want %v", c.start, c.end, got, err, c.want)
		}
	}

	a := Anchor{LineRange: &LineRange{Start: 7}}
	if err := a.NormalizeLineRange(); err != nil || a.LineRange == nil || *a.LineRange != (LineRange{7, 7}) {
		t.Errorf("NormalizeLineRange on {start: 7} = %v, %v; want {7 7}", a.LineRange, err)
	}
	a = Anchor{LineRange: &LineRange{End: 7}}
	if err := a.NormalizeLineRange(); !errors.Is(err, ErrInvalidLineRange) {
		t.Errorf("NormalizeLineRange on {end: 7}: err = %v, want ErrInvalidLineRange", err)
	}
	a = Anchor{}
	if err := a.NormalizeLineRange(); err != nil || a.LineRange != nil {
		t.Errorf("NormalizeLineRange on no range = %v, %v; want nil, nil", a.LineRange, err)
	}
}
