package app

import (
	"database/sql"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"codextelegrambridge/internal/config"
	_ "github.com/mattn/go-sqlite3"
)

const (
	bridgeTempRetention            = 24 * time.Hour
	bridgeStateTempRetention       = time.Hour
	codexSessionRetention          = 14 * 24 * time.Hour
	codexSessionMaxFiles           = 100
	codexSnapshotRetention         = 7 * 24 * time.Hour
	codexSnapshotMaxFiles          = 50
	codexHistoryMaxBytes     int64 = 10 * 1024 * 1024
	codexLogMaxBytes         int64 = 20 * 1024 * 1024
	codexLogMaxBackups             = 3
)

type fileWithModTime struct {
	path    string
	modTime time.Time
}

func cleanupBridgeRuntimeFiles(cfg config.Config, now time.Time) error {
	if err := removeOldFiles(cfg.TempDir, func(path string) bool {
		info, err := os.Stat(path)
		return err == nil && info.Mode().IsRegular()
	}, now.Add(-bridgeTempRetention)); err != nil {
		return err
	}
	return removeOldFiles(cfg.AppHome, func(path string) bool {
		base := filepath.Base(path)
		if !strings.HasPrefix(base, ".bridge-state-") || !strings.HasSuffix(base, ".json") {
			return false
		}
		info, err := os.Stat(path)
		return err == nil && info.Mode().IsRegular()
	}, now.Add(-bridgeStateTempRetention))
}

func cleanupCodexArtifacts(codexHome string, now time.Time) error {
	if strings.TrimSpace(codexHome) == "" {
		return nil
	}
	if err := pruneFiles(filepath.Join(codexHome, "sessions"), func(path string) bool {
		return filepath.Ext(path) == ".jsonl"
	}, now.Add(-codexSessionRetention), codexSessionMaxFiles); err != nil {
		return err
	}
	if err := pruneFiles(filepath.Join(codexHome, "shell_snapshots"), func(path string) bool {
		return filepath.Ext(path) == ".sh"
	}, now.Add(-codexSnapshotRetention), codexSnapshotMaxFiles); err != nil {
		return err
	}
	if err := trimJSONLFile(filepath.Join(codexHome, "history.jsonl"), codexHistoryMaxBytes); err != nil {
		return err
	}
	return rotateStandaloneFile(filepath.Join(codexHome, "log", "codex-tui.log"), codexLogMaxBytes, codexLogMaxBackups)
}

func checkpointCodexStateDBs(codexHome string) error {
	if strings.TrimSpace(codexHome) == "" {
		return nil
	}
	paths, err := filepath.Glob(filepath.Join(codexHome, "state_*.sqlite"))
	if err != nil {
		return err
	}
	for _, path := range paths {
		db, err := sql.Open("sqlite3", "file:"+path+"?_busy_timeout=1000")
		if err != nil {
			return err
		}
		_, execErr := db.Exec(`PRAGMA wal_checkpoint(TRUNCATE)`)
		_ = db.Close()
		if execErr != nil {
			message := strings.ToLower(execErr.Error())
			if strings.Contains(message, "busy") || strings.Contains(message, "locked") {
				continue
			}
			return execErr
		}
	}
	return nil
}

func removeOldFiles(root string, match func(path string) bool, cutoff time.Time) error {
	if _, err := os.Stat(root); err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	return filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() || !match(path) {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return nil
		}
		if info.ModTime().Before(cutoff) {
			return os.Remove(path)
		}
		return nil
	})
}

func pruneFiles(root string, match func(path string) bool, cutoff time.Time, maxFiles int) error {
	if _, err := os.Stat(root); err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}

	var files []fileWithModTime
	if err := filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() || !match(path) {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return nil
		}
		files = append(files, fileWithModTime{path: path, modTime: info.ModTime()})
		return nil
	}); err != nil {
		return err
	}

	sort.Slice(files, func(i, j int) bool {
		if files[i].modTime.Equal(files[j].modTime) {
			return files[i].path > files[j].path
		}
		return files[i].modTime.After(files[j].modTime)
	})
	for index, file := range files {
		keepByCount := maxFiles <= 0 || index < maxFiles
		keepByAge := cutoff.IsZero() || !file.modTime.Before(cutoff)
		if keepByCount && keepByAge {
			continue
		}
		if err := os.Remove(file.path); err != nil && !os.IsNotExist(err) {
			return err
		}
	}
	return nil
}

func trimJSONLFile(path string, maxBytes int64) error {
	if maxBytes <= 0 {
		return nil
	}
	info, err := os.Stat(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	if info.Size() <= maxBytes {
		return nil
	}

	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()

	offset := info.Size() - maxBytes
	if _, err := file.Seek(offset, io.SeekStart); err != nil {
		return err
	}
	body, err := io.ReadAll(file)
	if err != nil {
		return err
	}
	if offset > 0 {
		if newline := strings.IndexByte(string(body), '\n'); newline >= 0 && newline+1 < len(body) {
			body = body[newline+1:]
		}
	}
	tempPath := path + ".tmp"
	if err := os.WriteFile(tempPath, body, 0o600); err != nil {
		return err
	}
	return os.Rename(tempPath, path)
}

func rotateStandaloneFile(path string, maxBytes int64, maxBackups int) error {
	if maxBytes <= 0 {
		return nil
	}
	info, err := os.Stat(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	if info.Size() <= maxBytes {
		return nil
	}
	if maxBackups > 0 {
		oldest := fmt.Sprintf("%s.%d", path, maxBackups)
		_ = os.Remove(oldest)
		for index := maxBackups - 1; index >= 1; index-- {
			source := fmt.Sprintf("%s.%d", path, index)
			target := fmt.Sprintf("%s.%d", path, index+1)
			if _, err := os.Stat(source); err == nil {
				if err := os.Rename(source, target); err != nil {
					return err
				}
			}
		}
		return os.Rename(path, path+".1")
	}
	return os.Remove(path)
}
