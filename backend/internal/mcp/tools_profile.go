package mcp

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"bench/internal/events"
)

func registerProfileTools(deps *toolDeps) []Tool {
	return []Tool{
		toolGetServiceProfile(deps),
		toolUpdateServiceProfile(deps),
	}
}

func toolGetServiceProfile(deps *toolDeps) Tool {
	return Tool{
		Name: "get_service_profile",
		Description: "Get the service profile - reviewer-configured meta-attributes describing the service under review " +
			"(exposure, compute, data sensitivity, criticality, tenancy, lifecycle, edge protections, compliance scope, " +
			"authentication model, consumer types). Call this at the start of a review: these attributes provide deployment " +
			"context that application code cannot reveal, and may make certain finding classes moot (e.g. rate limiting at " +
			"the gateway, auth terminated upstream) or hotter (e.g. multi-tenant + PII). Empty fields mean 'not configured' - " +
			"never treat absence as confirmation that a control is missing.",
		InputSchema: json.RawMessage(`{"type": "object", "properties": {}}`),
		Handler: func(ctx context.Context, params json.RawMessage) (string, error) {
			p, err := deps.db.GetServiceProfile()
			if err != nil {
				return "", err
			}
			b, err := json.MarshalIndent(p, "", "  ")
			if err != nil {
				return "", err
			}
			if p.UpdatedAt == "" {
				return "Service profile not configured yet. Fields and their current (empty) values:\n" + string(b) +
					"\nSet what you know via update_service_profile - review-judgment writes are rejected until the profile is configured.", nil
			}
			return string(b), nil
		},
	}
}

func toolUpdateServiceProfile(deps *toolDeps) Tool {
	return Tool{
		Name: "update_service_profile",
		Description: "Update the service profile (partial update - omitted fields are left unchanged). Array fields replace " +
			"the full list; pass [] to clear back to 'not configured'. In array fields, 'none' is an explicit positive claim " +
			"(control confirmed absent) and cannot be combined with other values.",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"description":          {"type": "string", "description": "What the service does"},
				"owner":                {"type": "string", "description": "Team or person accountable"},
				"externally_facing":    {"type": "string", "enum": ["", "full", "partial", "none"], "description": "Internet reachability"},
				"compute":              {"type": "string", "enum": ["", "vps", "kubernetes", "serverless", "bare-metal"], "description": "Runtime environment"},
				"data_sensitivity":     {"type": "string", "enum": ["", "public", "internal", "pii", "payment", "phi", "credentials"], "description": "Declared highest data classification"},
				"criticality":          {"type": "string", "enum": ["", "low", "medium", "high", "critical"], "description": "Business impact if compromised or down"},
				"tenancy":              {"type": "string", "enum": ["", "single-tenant", "multi-tenant"], "description": "Tenancy model"},
				"lifecycle":            {"type": "string", "enum": ["", "active", "maintenance", "deprecated", "decommissioning"], "description": "Service lifecycle stage"},
				"edge_protections":     {"type": "array", "items": {"type": "string", "enum": ["waf", "api-gateway", "rate-limiting", "ddos-protection", "none"]}, "description": "Infra-level controls outside app code. Replaces the full list."},
				"compliance_scope":     {"type": "array", "items": {"type": "string", "enum": ["pci-dss", "hipaa", "soc2", "gdpr", "none"]}, "description": "Regulatory regimes in scope. Replaces the full list."},
				"authentication_model": {"type": "array", "items": {"type": "string", "enum": ["none", "api-key", "oauth-oidc", "mtls", "session", "gateway-terminated"]}, "description": "How callers authenticate - may live outside app code. Replaces the full list."},
				"consumer_type":        {"type": "array", "items": {"type": "string", "enum": ["first-party-frontend", "internal-services", "third-party-partners", "general-public"]}, "description": "Who calls this service. Replaces the full list."}
			}
		}`),
		Handler: func(ctx context.Context, params json.RawMessage) (string, error) {
			// Pointer fields distinguish "omitted" from "set to empty".
			var p struct {
				Description         *string   `json:"description"`
				Owner               *string   `json:"owner"`
				ExternallyFacing    *string   `json:"externally_facing"`
				Compute             *string   `json:"compute"`
				DataSensitivity     *string   `json:"data_sensitivity"`
				Criticality         *string   `json:"criticality"`
				Tenancy             *string   `json:"tenancy"`
				Lifecycle           *string   `json:"lifecycle"`
				EdgeProtections     *[]string `json:"edge_protections"`
				ComplianceScope     *[]string `json:"compliance_scope"`
				AuthenticationModel *[]string `json:"authentication_model"`
				ConsumerType        *[]string `json:"consumer_type"`
			}
			if err := json.Unmarshal(params, &p); err != nil {
				return "", fmt.Errorf("invalid params: %w", err)
			}

			profile, err := deps.db.GetServiceProfile()
			if err != nil {
				return "", err
			}

			var changed []string
			overlayStr := func(name string, src *string, dst *string) {
				if src != nil {
					*dst = *src
					changed = append(changed, fmt.Sprintf("%s=%q", name, *src))
				}
			}
			overlayArr := func(name string, src *[]string, dst *[]string) {
				if src != nil {
					*dst = *src
					changed = append(changed, fmt.Sprintf("%s=%v", name, *src))
				}
			}
			overlayStr("description", p.Description, &profile.Description)
			overlayStr("owner", p.Owner, &profile.Owner)
			overlayStr("externally_facing", p.ExternallyFacing, &profile.ExternallyFacing)
			overlayStr("compute", p.Compute, &profile.Compute)
			overlayStr("data_sensitivity", p.DataSensitivity, &profile.DataSensitivity)
			overlayStr("criticality", p.Criticality, &profile.Criticality)
			overlayStr("tenancy", p.Tenancy, &profile.Tenancy)
			overlayStr("lifecycle", p.Lifecycle, &profile.Lifecycle)
			overlayArr("edge_protections", p.EdgeProtections, &profile.EdgeProtections)
			overlayArr("compliance_scope", p.ComplianceScope, &profile.ComplianceScope)
			overlayArr("authentication_model", p.AuthenticationModel, &profile.AuthenticationModel)
			overlayArr("consumer_type", p.ConsumerType, &profile.ConsumerType)

			if err := profile.Validate(); err != nil {
				return "", err
			}
			if err := deps.db.PutServiceProfile(profile); err != nil {
				return "", err
			}
			if deps.broker != nil {
				deps.broker.Publish(events.TopicProfile)
			}
			if len(changed) == 0 {
				return "Service profile touched (no fields provided) - profile now counts as configured.", nil
			}
			return "Service profile updated: " + strings.Join(changed, ", "), nil
		},
	}
}

// profileSection renders the profile as a markdown section for embedding in
// get_summary and get_delta responses, so agents entering via those tools
// absorb the service context without an extra call.
func profileSection(deps *toolDeps) string {
	var sb strings.Builder
	fmt.Fprintf(&sb, "\n### Service Profile\n")
	configured, err := deps.db.ProfileConfigured()
	if err != nil || !configured {
		fmt.Fprintf(&sb, "Not configured - call get_service_profile for the schema, then update_service_profile with what you know. Review-judgment writes are rejected until then.\n")
		return sb.String()
	}
	p, err := deps.db.GetServiceProfile()
	if err != nil {
		return ""
	}
	line := func(name, val string) {
		if val != "" {
			fmt.Fprintf(&sb, "- %s: %s\n", name, val)
		}
	}
	line("description", p.Description)
	line("owner", p.Owner)
	line("externally-facing", p.ExternallyFacing)
	line("compute", p.Compute)
	line("data-sensitivity", p.DataSensitivity)
	line("criticality", p.Criticality)
	line("tenancy", p.Tenancy)
	line("lifecycle", p.Lifecycle)
	line("edge-protections", strings.Join(p.EdgeProtections, ", "))
	line("compliance-scope", strings.Join(p.ComplianceScope, ", "))
	line("authentication-model", strings.Join(p.AuthenticationModel, ", "))
	line("consumer-type", strings.Join(p.ConsumerType, ", "))
	return sb.String()
}

// profileGateMessage instructs an agent blocked by the write gate how to
// unblock itself.
const profileGateMessage = "service profile not configured - call get_service_profile to see the schema, then " +
	"update_service_profile to set what you know. This context determines which finding classes are moot " +
	"(e.g. rate limiting at the gateway) or amplified (e.g. multi-tenant + PII). Review-judgment writes are " +
	"rejected until the profile is configured."

// requiresProfile reports whether a tool records review judgment and should
// be gated behind profile configuration. Centralised by name pattern so new
// write tools are gated by default; the profile tools themselves are the
// bootstrap path and stay exempt.
func requiresProfile(name string) bool {
	if name == "update_service_profile" || name == "get_service_profile" {
		return false
	}
	for _, prefix := range []string{"create_", "update_", "delete_", "clear_", "batch_", "resolve_", "set_", "mark_"} {
		if strings.HasPrefix(name, prefix) {
			return true
		}
	}
	return false
}
