package db

import (
	"reflect"
	"testing"

	"bench/internal/model"
)

func TestServiceProfile_ZeroRead(t *testing.T) {
	d := openTestDB(t)

	p, err := d.GetServiceProfile()
	if err != nil {
		t.Fatalf("GetServiceProfile on fresh DB: %v", err)
	}
	if p.Description != "" || p.Owner != "" || p.ExternallyFacing != "" || p.UpdatedAt != "" {
		t.Errorf("zero profile has non-empty fields: %+v", p)
	}
	// Arrays must be [] not nil so JSON serialises as [] not null.
	for name, arr := range map[string][]string{
		"edgeProtections":     p.EdgeProtections,
		"complianceScope":     p.ComplianceScope,
		"authenticationModel": p.AuthenticationModel,
		"consumerType":        p.ConsumerType,
	} {
		if arr == nil {
			t.Errorf("%s is nil, want []", name)
		}
		if len(arr) != 0 {
			t.Errorf("%s = %v, want empty", name, arr)
		}
	}

	configured, err := d.ProfileConfigured()
	if err != nil {
		t.Fatalf("ProfileConfigured: %v", err)
	}
	if configured {
		t.Error("fresh DB reports profile configured")
	}
}

func TestServiceProfile_UpsertRoundTrip(t *testing.T) {
	d := openTestDB(t)

	in := model.ServiceProfile{
		Description:         "Order management API",
		Owner:               "platform-team",
		ExternallyFacing:    "full",
		Compute:             "kubernetes",
		DataSensitivity:     "pii",
		Criticality:         "high",
		Tenancy:             "multi-tenant",
		Lifecycle:           "active",
		EdgeProtections:     []string{"waf", "rate-limiting"},
		ComplianceScope:     []string{"pci-dss", "gdpr"},
		AuthenticationModel: []string{"oauth-oidc", "gateway-terminated"},
		ConsumerType:        []string{"first-party-frontend"},
	}
	if err := d.PutServiceProfile(in); err != nil {
		t.Fatalf("PutServiceProfile: %v", err)
	}

	out, err := d.GetServiceProfile()
	if err != nil {
		t.Fatalf("GetServiceProfile: %v", err)
	}
	if out.UpdatedAt == "" {
		t.Error("updated_at not stamped")
	}
	in.UpdatedAt, out.UpdatedAt = "", ""
	if !reflect.DeepEqual(in, out) {
		t.Errorf("round-trip mismatch:\n in: %+v\nout: %+v", in, out)
	}

	configured, err := d.ProfileConfigured()
	if err != nil {
		t.Fatalf("ProfileConfigured: %v", err)
	}
	if !configured {
		t.Error("profile not reported configured after put")
	}

	// Upsert replaces (including clearing arrays back to []).
	in2 := model.ServiceProfile{Owner: "security-team"}
	if err := d.PutServiceProfile(in2); err != nil {
		t.Fatalf("PutServiceProfile upsert: %v", err)
	}
	out2, err := d.GetServiceProfile()
	if err != nil {
		t.Fatalf("GetServiceProfile after upsert: %v", err)
	}
	if out2.Owner != "security-team" || out2.Description != "" {
		t.Errorf("upsert did not replace: %+v", out2)
	}
	if len(out2.EdgeProtections) != 0 {
		t.Errorf("edgeProtections not cleared: %v", out2.EdgeProtections)
	}
}

func TestServiceProfile_EmptyPutMarksConfigured(t *testing.T) {
	d := openTestDB(t)

	// An all-empty put is a deliberate act ("reviewed, nothing known") and
	// satisfies the write gate.
	if err := d.PutServiceProfile(model.ServiceProfile{}); err != nil {
		t.Fatalf("PutServiceProfile empty: %v", err)
	}
	configured, err := d.ProfileConfigured()
	if err != nil {
		t.Fatalf("ProfileConfigured: %v", err)
	}
	if !configured {
		t.Error("empty put should mark profile configured")
	}
}

func TestServiceProfile_ValidateEnums(t *testing.T) {
	cases := []struct {
		name    string
		profile model.ServiceProfile
		wantErr bool
	}{
		{"empty is valid", model.ServiceProfile{}, false},
		{"valid single", model.ServiceProfile{ExternallyFacing: "partial"}, false},
		{"bad single", model.ServiceProfile{ExternallyFacing: "yes"}, true},
		{"bad severity-style value", model.ServiceProfile{Criticality: "informational"}, true},
		{"valid multi", model.ServiceProfile{EdgeProtections: []string{"waf", "api-gateway"}}, false},
		{"bad multi member", model.ServiceProfile{EdgeProtections: []string{"waf", "firewall"}}, true},
		{"explicit none alone", model.ServiceProfile{EdgeProtections: []string{"none"}}, false},
		{"none mixed", model.ServiceProfile{EdgeProtections: []string{"none", "waf"}}, true},
		{"auth none mixed", model.ServiceProfile{AuthenticationModel: []string{"none", "api-key"}}, true},
		{"consumer type has no none", model.ServiceProfile{ConsumerType: []string{"none"}}, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := tc.profile.Validate()
			if tc.wantErr && err == nil {
				t.Errorf("expected validation error, got nil")
			}
			if !tc.wantErr && err != nil {
				t.Errorf("unexpected validation error: %v", err)
			}
		})
	}
}
