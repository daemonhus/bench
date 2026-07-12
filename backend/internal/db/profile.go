package db

import (
	"database/sql"
	"encoding/json"
	"fmt"

	"bench/internal/model"
)

// GetServiceProfile returns the singleton service profile. If it has never
// been configured, a zero profile (all fields empty, arrays []) is returned
// without inserting a row.
func (d *DB) GetServiceProfile() (model.ServiceProfile, error) {
	var p model.ServiceProfile
	var edge, compliance, auth, consumer string
	err := d.conn.QueryRow(`SELECT description, owner, externally_facing, compute,
		data_sensitivity, criticality, tenancy, lifecycle,
		edge_protections, compliance_scope, authentication_model, consumer_type,
		updated_at
		FROM service_profile WHERE id = 1`).Scan(
		&p.Description, &p.Owner, &p.ExternallyFacing, &p.Compute,
		&p.DataSensitivity, &p.Criticality, &p.Tenancy, &p.Lifecycle,
		&edge, &compliance, &auth, &consumer,
		&p.UpdatedAt,
	)
	if err == sql.ErrNoRows {
		p.Normalize()
		return p, nil
	}
	if err != nil {
		return p, fmt.Errorf("get service profile: %w", err)
	}
	for _, col := range []struct {
		raw  string
		dest *[]string
	}{
		{edge, &p.EdgeProtections},
		{compliance, &p.ComplianceScope},
		{auth, &p.AuthenticationModel},
		{consumer, &p.ConsumerType},
	} {
		if err := json.Unmarshal([]byte(col.raw), col.dest); err != nil {
			return p, fmt.Errorf("decode service profile array: %w", err)
		}
	}
	p.Normalize()
	return p, nil
}

// PutServiceProfile upserts the full service profile document and stamps
// updated_at. Validation is the caller's responsibility (model.Validate).
func (d *DB) PutServiceProfile(p model.ServiceProfile) error {
	p.Normalize()
	arrays := make([]string, 4)
	for i, vals := range [][]string{p.EdgeProtections, p.ComplianceScope, p.AuthenticationModel, p.ConsumerType} {
		b, err := json.Marshal(vals)
		if err != nil {
			return fmt.Errorf("encode service profile array: %w", err)
		}
		arrays[i] = string(b)
	}
	err := wq0(d.wq, func() error {
		_, err := d.conn.Exec(`INSERT INTO service_profile (
			id, description, owner, externally_facing, compute,
			data_sensitivity, criticality, tenancy, lifecycle,
			edge_protections, compliance_scope, authentication_model, consumer_type,
			updated_at)
			VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
			ON CONFLICT(id) DO UPDATE SET
				description = excluded.description,
				owner = excluded.owner,
				externally_facing = excluded.externally_facing,
				compute = excluded.compute,
				data_sensitivity = excluded.data_sensitivity,
				criticality = excluded.criticality,
				tenancy = excluded.tenancy,
				lifecycle = excluded.lifecycle,
				edge_protections = excluded.edge_protections,
				compliance_scope = excluded.compliance_scope,
				authentication_model = excluded.authentication_model,
				consumer_type = excluded.consumer_type,
				updated_at = excluded.updated_at`,
			p.Description, p.Owner, p.ExternallyFacing, p.Compute,
			p.DataSensitivity, p.Criticality, p.Tenancy, p.Lifecycle,
			arrays[0], arrays[1], arrays[2], arrays[3],
		)
		return err
	})
	if err == nil {
		d.profileConfigured.Store(true)
	}
	return err
}

// ProfileConfigured reports whether the service profile has ever been
// explicitly written. Used by the write gate: review-judgment writes are
// rejected until this is true.
func (d *DB) ProfileConfigured() (bool, error) {
	if d.profileConfigured.Load() {
		return true, nil
	}
	var n int
	if err := d.conn.QueryRow(`SELECT COUNT(*) FROM service_profile WHERE id = 1`).Scan(&n); err != nil {
		return false, fmt.Errorf("check service profile: %w", err)
	}
	if n > 0 {
		d.profileConfigured.Store(true)
		return true, nil
	}
	return false, nil
}
