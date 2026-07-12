# Profile

The Profile panel (shortcut <kbd>5</kbd>, routed at `#/profile`) holds the **service profile**: meta-attributes about the service under review that the code alone can't reveal. The profile is used during investigations and to contextualise risk scores - each field can make certain vulnerability classes moot (rate limiting handled at the gateway, auth terminated upstream) or amplify them (multi-tenant, PII, internet-facing).

This is review context, distinct from *Settings* (colours, keyboard shortcuts), which lives in the parent panel.

Edits save as you make them; the header shows when the profile was last written.

## Fields

**Identity** - free-text description of what the service does, and the owning team or person.

**Exposure** - internet reachability (`full`/`partial`/`none`), compute environment (VPS, Kubernetes, Serverless, Bare Metal), and edge protections applied outside the app code (WAF, API Gateway, Rate Limiting, DDoS Protection).

**Data & Impact** - the declared highest data classification (Public → Credentials & Secrets), business criticality, and compliance scope (PCI-DSS, HIPAA, SOC 2, GDPR).

**Access** - tenancy model, how callers authenticate (including "Terminated at Gateway" for auth that never appears in app code), and who the consumers are.

**Lifecycle** - active, maintenance, deprecated, or decommissioning. A critical finding on a service being decommissioned is triaged differently.

Each field shows a short note explaining how it modulates findings.

## Unset vs. None

Leaving a field unset means "not configured" and is never treated as evidence a control is missing. In the multi-choice groups, **None** is the opposite: an explicit claim that the control is confirmed absent. It's exclusive - selecting it clears the other options.

## The write gate

Until the profile has been saved at least once, bench rejects all review-judgment writes - findings, comments, features, refs, baselines - across the UI, REST API, CLI, and MCP. A banner links here when the profile is unconfigured. Saving with everything unset is allowed and means "reviewed, nothing known".

Agents get the same treatment: MCP write tools return an instructive error pointing at `get_service_profile` / `update_service_profile`, and the profile is embedded in `get_summary` and `get_delta` responses so a session that starts with either has the context automatically.

The gate can be disabled with the server flag `-require-profile=false`.
