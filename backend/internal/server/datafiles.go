package server

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

// The data folder holds the server's database, default.db (projects, flows, settings), and one
// database per project named <slug>-<hash of its repository path>.db. The hash keeps a project's
// file from ever taking the server's name, whatever the project is called.
const (
	serverDBName       = "default.db"
	legacyServerDBName = "platform.db"
)

// projectDBName is the file name of a project's database; changing the project's repository
// path renames it (see moveDB).
func projectDBName(slug, repoPath string) string {
	sum := sha256.Sum256([]byte(filepath.Clean(repoPath)))
	return slug + "-" + hex.EncodeToString(sum[:])[:8] + ".db"
}

// moveDB renames the closed SQLite database from to to in dir, with its -wal and -shm files
// (journal files first, so an interrupted move leaves the database with its journal). It does
// nothing when from is missing, or when to already exists, so it never overwrites data.
func moveDB(dir, from, to string) error {
	if from == to {
		return nil
	}
	src, dst := filepath.Join(dir, from), filepath.Join(dir, to)
	if _, err := os.Stat(dst); err == nil {
		return nil
	}
	if _, err := os.Stat(src); errors.Is(err, os.ErrNotExist) {
		return nil
	}
	for _, suffix := range []string{"-wal", "-shm", ""} {
		if err := os.Rename(src+suffix, dst+suffix); err != nil && !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("rename %s to %s: %w", from+suffix, to+suffix, err)
		}
	}
	return nil
}

// moveProjectDBs gives each project's database its current name: databases from before the
// names carried a hash were <slug>.db.
func moveProjectDBs(conn *sql.DB, dataDir string) error {
	rows, err := conn.Query("SELECT slug, repo_path FROM projects")
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var slug, repoPath string
		if err := rows.Scan(&slug, &repoPath); err != nil {
			return err
		}
		if err := moveDB(dataDir, slug+".db", projectDBName(slug, repoPath)); err != nil {
			return err
		}
	}
	return rows.Err()
}
