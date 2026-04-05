package db

// GetSetting returns the value for a setting key, or ("", false, nil) if not found.
func (d *DB) GetSetting(key string) (string, bool, error) {
	var val string
	err := d.conn.QueryRow("SELECT value FROM settings WHERE key = ?", key).Scan(&val)
	if err != nil {
		return "", false, nil // not found
	}
	return val, true, nil
}

// GetAllSettings returns all settings as a key-value map.
func (d *DB) GetAllSettings() (map[string]string, error) {
	rows, err := d.conn.Query("SELECT key, value FROM settings")
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	result := make(map[string]string)
	for rows.Next() {
		var k, v string
		if err := rows.Scan(&k, &v); err != nil {
			continue
		}
		result[k] = v
	}
	return result, nil
}

// PutSetting upserts a single setting.
func (d *DB) PutSetting(key, value string) error {
	return wq0(d.wq, func() error {
		_, err := d.conn.Exec(
			"INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?",
			key, value, value,
		)
		return err
	})
}

// PutSettings upserts multiple settings atomically.
func (d *DB) PutSettings(settings map[string]string) error {
	return wq0(d.wq, func() error {
		tx, err := d.conn.Begin()
		if err != nil {
			return err
		}
		defer tx.Rollback()
		for k, v := range settings {
			if _, err := tx.Exec(
				"INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?",
				k, v, v,
			); err != nil {
				return err
			}
		}
		return tx.Commit()
	})
}
