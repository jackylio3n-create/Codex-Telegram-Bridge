package daemon

import (
	"fmt"
	"os"
	"path/filepath"
	"sync"
)

type rotatingFileWriter struct {
	path       string
	maxBytes   int64
	maxBackups int

	mu   sync.Mutex
	file *os.File
	size int64
}

func newRotatingFileWriter(path string, maxBytes int64, maxBackups int) (*rotatingFileWriter, error) {
	writer := &rotatingFileWriter{
		path:       path,
		maxBytes:   maxBytes,
		maxBackups: maxBackups,
	}
	if err := writer.openLocked(); err != nil {
		return nil, err
	}
	return writer, nil
}

func (w *rotatingFileWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()

	if w.file == nil {
		if err := w.openLocked(); err != nil {
			return 0, err
		}
	}
	if w.maxBytes > 0 && w.size+int64(len(p)) > w.maxBytes {
		if err := w.rotateLocked(); err != nil {
			return 0, err
		}
	}
	n, err := w.file.Write(p)
	w.size += int64(n)
	return n, err
}

func (w *rotatingFileWriter) Close() error {
	w.mu.Lock()
	defer w.mu.Unlock()

	if w.file == nil {
		return nil
	}
	err := w.file.Close()
	w.file = nil
	w.size = 0
	return err
}

func (w *rotatingFileWriter) openLocked() error {
	if err := os.MkdirAll(filepath.Dir(w.path), 0o700); err != nil {
		return err
	}
	file, err := os.OpenFile(w.path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	info, err := file.Stat()
	if err != nil {
		file.Close()
		return err
	}
	w.file = file
	w.size = info.Size()
	return nil
}

func (w *rotatingFileWriter) rotateLocked() error {
	if w.file != nil {
		if err := w.file.Close(); err != nil {
			return err
		}
		w.file = nil
	}

	if w.maxBackups > 0 {
		oldest := fmt.Sprintf("%s.%d", w.path, w.maxBackups)
		_ = os.Remove(oldest)
		for index := w.maxBackups - 1; index >= 1; index-- {
			source := fmt.Sprintf("%s.%d", w.path, index)
			target := fmt.Sprintf("%s.%d", w.path, index+1)
			if _, err := os.Stat(source); err == nil {
				if err := os.Rename(source, target); err != nil {
					return err
				}
			}
		}
		if _, err := os.Stat(w.path); err == nil {
			if err := os.Rename(w.path, w.path+".1"); err != nil {
				return err
			}
		}
	} else {
		_ = os.Remove(w.path)
	}
	return w.openLocked()
}
