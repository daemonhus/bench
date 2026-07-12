package db

import (
	"testing"

	"bench/internal/model"
)

func makeFeature(id, kind string) model.Feature {
	return model.Feature{
		ID:     id,
		Anchor: model.Anchor{FileID: "src/a.go", CommitID: "abc"},
		Kind:   kind,
		Title:  id,
		Status: "active",
		Tags:   []string{},
	}
}

func TestFeatureLinks_GetFeatureReturnsLinkedIDs(t *testing.T) {
	d := openTestDB(t)

	a := makeFeature("fa", "interface")
	b := makeFeature("fb", "sink")
	d.CreateFeature(&a)
	d.CreateFeature(&b)

	if err := d.ReplaceLinkedFeatures("fa", []model.LinkedFeature{{ID: "fb"}}); err != nil {
		t.Fatalf("ReplaceLinkedFeatures: %v", err)
	}

	got, err := d.GetFeature("fa")
	if err != nil {
		t.Fatalf("GetFeature fa: %v", err)
	}
	if len(got.LinkedFeatures) != 1 || got.LinkedFeatures[0].ID != "fb" {
		t.Errorf("fa.linkedFeatures = %v, want [{id:fb}]", got.LinkedFeatures)
	}
}

func TestFeatureLinks_Bidirectional(t *testing.T) {
	d := openTestDB(t)

	d.CreateFeature(&[]model.Feature{makeFeature("fa", "interface")}[0])
	d.CreateFeature(&[]model.Feature{makeFeature("fb", "sink")}[0])

	d.ReplaceLinkedFeatures("fa", []model.LinkedFeature{{ID: "fb"}})

	// fb should see fa even though the row was inserted with fa as feature_id
	got, _ := d.GetFeature("fb")
	if len(got.LinkedFeatures) != 1 || got.LinkedFeatures[0].ID != "fa" {
		t.Errorf("fb.linkedFeatures = %v, want [{id:fa}]", got.LinkedFeatures)
	}
}

func TestFeatureLinks_ListFeaturesEnriches(t *testing.T) {
	d := openTestDB(t)

	d.CreateFeature(&[]model.Feature{makeFeature("fa", "interface")}[0])
	d.CreateFeature(&[]model.Feature{makeFeature("fb", "sink")}[0])
	d.ReplaceLinkedFeatures("fa", []model.LinkedFeature{{ID: "fb"}})

	list, _, _ := d.ListFeatures("", "", 0, 0)
	byID := map[string]model.Feature{}
	for _, f := range list {
		byID[f.ID] = f
	}

	if lf := byID["fa"].LinkedFeatures; len(lf) != 1 || lf[0].ID != "fb" {
		t.Errorf("list fa.linkedFeatures = %v, want [{id:fb}]", lf)
	}
	if lf := byID["fb"].LinkedFeatures; len(lf) != 1 || lf[0].ID != "fa" {
		t.Errorf("list fb.linkedFeatures = %v, want [{id:fa}]", lf)
	}
}

func TestFeatureLinks_LinkedToFilter(t *testing.T) {
	d := openTestDB(t)

	d.CreateFeature(&[]model.Feature{makeFeature("fa", "interface")}[0])
	d.CreateFeature(&[]model.Feature{makeFeature("fb", "sink")}[0])
	d.CreateFeature(&[]model.Feature{makeFeature("fc", "source")}[0])
	d.ReplaceLinkedFeatures("fa", []model.LinkedFeature{{ID: "fb"}})

	// Only fb should be returned when filtering by fa
	list, _, err := d.ListFeatures("", "fa", 0, 0)
	if err != nil {
		t.Fatalf("ListFeatures linkedTo=fa: %v", err)
	}
	if len(list) != 1 || list[0].ID != "fb" {
		t.Errorf("linkedTo=fa list = %v ids, want [fb]", featureIDs(list))
	}

	// From the other direction: linkedTo=fb should return fa
	list2, _, _ := d.ListFeatures("", "fb", 0, 0)
	if len(list2) != 1 || list2[0].ID != "fa" {
		t.Errorf("linkedTo=fb list = %v, want [fa]", featureIDs(list2))
	}

	// fc is unlinked: linkedTo=fc should be empty
	list3, _, _ := d.ListFeatures("", "fc", 0, 0)
	if len(list3) != 0 {
		t.Errorf("linkedTo=fc list = %v, want []", featureIDs(list3))
	}
}

func TestFeatureLinks_Replace(t *testing.T) {
	d := openTestDB(t)

	d.CreateFeature(&[]model.Feature{makeFeature("fa", "interface")}[0])
	d.CreateFeature(&[]model.Feature{makeFeature("fb", "sink")}[0])
	d.CreateFeature(&[]model.Feature{makeFeature("fc", "source")}[0])

	d.ReplaceLinkedFeatures("fa", []model.LinkedFeature{{ID: "fb"}})

	// Replace fb with fc
	if err := d.ReplaceLinkedFeatures("fa", []model.LinkedFeature{{ID: "fc"}}); err != nil {
		t.Fatalf("ReplaceLinkedFeatures replace: %v", err)
	}

	got, _ := d.GetFeature("fa")
	if len(got.LinkedFeatures) != 1 || got.LinkedFeatures[0].ID != "fc" {
		t.Errorf("after replace: fa.linkedFeatures = %v, want [{id:fc}]", got.LinkedFeatures)
	}
	// fb should now show no links
	fb, _ := d.GetFeature("fb")
	if len(fb.LinkedFeatures) != 0 {
		t.Errorf("after replace: fb.linkedFeatures = %v, want []", fb.LinkedFeatures)
	}
}

func TestFeatureLinks_Clear(t *testing.T) {
	d := openTestDB(t)

	d.CreateFeature(&[]model.Feature{makeFeature("fa", "interface")}[0])
	d.CreateFeature(&[]model.Feature{makeFeature("fb", "sink")}[0])
	d.ReplaceLinkedFeatures("fa", []model.LinkedFeature{{ID: "fb"}})

	if err := d.ReplaceLinkedFeatures("fa", []model.LinkedFeature{}); err != nil {
		t.Fatalf("ReplaceLinkedFeatures clear: %v", err)
	}

	got, _ := d.GetFeature("fa")
	if len(got.LinkedFeatures) != 0 {
		t.Errorf("after clear: fa.linkedFeatures = %v, want []", got.LinkedFeatures)
	}
}

func TestFeatureLinks_SelfLink(t *testing.T) {
	d := openTestDB(t)
	d.CreateFeature(&[]model.Feature{makeFeature("fa", "interface")}[0])

	err := d.ReplaceLinkedFeatures("fa", []model.LinkedFeature{{ID: "fa"}})
	if err == nil {
		t.Error("expected error for self-link, got nil")
	}
}

func TestFeatureLinks_Description(t *testing.T) {
	d := openTestDB(t)

	d.CreateFeature(&[]model.Feature{makeFeature("fa", "interface")}[0])
	d.CreateFeature(&[]model.Feature{makeFeature("fb", "sink")}[0])

	links := []model.LinkedFeature{{ID: "fb", Description: "primary data store"}}
	if err := d.ReplaceLinkedFeatures("fa", links); err != nil {
		t.Fatalf("ReplaceLinkedFeatures: %v", err)
	}

	got, _ := d.GetFeature("fa")
	if len(got.LinkedFeatures) != 1 || got.LinkedFeatures[0].Description != "primary data store" {
		t.Errorf("linkedFeatures[0].description = %q, want %q", got.LinkedFeatures[0].Description, "primary data store")
	}
	// Bidirectional: fb should also see the description
	fb, _ := d.GetFeature("fb")
	if len(fb.LinkedFeatures) != 1 || fb.LinkedFeatures[0].Description != "primary data store" {
		t.Errorf("fb.linkedFeatures[0].description = %q, want %q", fb.LinkedFeatures[0].Description, "primary data store")
	}
}

func TestFeatureLinks_DeleteCascades(t *testing.T) {
	d := openTestDB(t)

	d.CreateFeature(&[]model.Feature{makeFeature("fa", "interface")}[0])
	d.CreateFeature(&[]model.Feature{makeFeature("fb", "sink")}[0])
	d.ReplaceLinkedFeatures("fa", []model.LinkedFeature{{ID: "fb"}})

	// Delete fb - link should disappear
	if err := d.DeleteFeature("fb"); err != nil {
		t.Fatalf("DeleteFeature: %v", err)
	}

	got, _ := d.GetFeature("fa")
	if len(got.LinkedFeatures) != 0 {
		t.Errorf("after deleting fb: fa.linkedFeatures = %v, want []", got.LinkedFeatures)
	}
}

func TestFeatureLinks_EmptyByDefault(t *testing.T) {
	d := openTestDB(t)
	d.CreateFeature(&[]model.Feature{makeFeature("fa", "interface")}[0])

	got, _ := d.GetFeature("fa")
	if got.LinkedFeatures == nil {
		t.Error("LinkedFeatures should be empty slice, not nil")
	}
	if len(got.LinkedFeatures) != 0 {
		t.Errorf("LinkedFeatures = %v, want []", got.LinkedFeatures)
	}
}

// featureIDs extracts IDs for readable error messages.
func featureIDs(features []model.Feature) []string {
	ids := make([]string, len(features))
	for i, f := range features {
		ids[i] = f.ID
	}
	return ids
}
