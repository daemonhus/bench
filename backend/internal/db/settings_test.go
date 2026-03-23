package db

import (
	"testing"
)

func TestSettings(t *testing.T) {
	d := openTestDB(t)

	// Missing key returns ("", false, nil)
	val, ok, err := d.GetSetting("theme")
	if err != nil {
		t.Fatalf("GetSetting missing key: %v", err)
	}
	if ok || val != "" {
		t.Errorf("missing key: got (%q, %v), want ('', false)", val, ok)
	}

	// PutSetting / GetSetting round-trip
	if err := d.PutSetting("theme", "dark"); err != nil {
		t.Fatalf("PutSetting: %v", err)
	}
	val, ok, err = d.GetSetting("theme")
	if err != nil {
		t.Fatalf("GetSetting: %v", err)
	}
	if !ok || val != "dark" {
		t.Errorf("theme = (%q, %v), want ('dark', true)", val, ok)
	}

	// PutSetting upserts
	if err := d.PutSetting("theme", "light"); err != nil {
		t.Fatalf("PutSetting upsert: %v", err)
	}
	val, _, _ = d.GetSetting("theme")
	if val != "light" {
		t.Errorf("theme after upsert = %q, want light", val)
	}
}

func TestPutSettings_Batch(t *testing.T) {
	d := openTestDB(t)

	if err := d.PutSettings(map[string]string{"a": "1", "b": "2"}); err != nil {
		t.Fatalf("PutSettings: %v", err)
	}

	all, err := d.GetAllSettings()
	if err != nil {
		t.Fatalf("GetAllSettings: %v", err)
	}
	if all["a"] != "1" {
		t.Errorf("a = %q, want 1", all["a"])
	}
	if all["b"] != "2" {
		t.Errorf("b = %q, want 2", all["b"])
	}

	// GetAllSettings empty DB returns empty map, not error
	d2 := openTestDB(t)
	empty, err := d2.GetAllSettings()
	if err != nil {
		t.Fatalf("GetAllSettings empty: %v", err)
	}
	if len(empty) != 0 {
		t.Errorf("expected empty map, got %d entries", len(empty))
	}
}
