package policy

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"codextelegrambridge/internal/model"
	"golang.org/x/crypto/scrypt"
)

func VerifyPassword(password, encodedHash string) bool {
	parts := strings.Split(strings.TrimSpace(encodedHash), "$")
	if len(parts) != 7 || parts[0] != "scrypt" {
		return false
	}

	var cost, blockSize, parallelization, keyLength int
	if _, err := fmt.Sscanf(parts[1], "%d", &cost); err != nil {
		return false
	}
	if _, err := fmt.Sscanf(parts[2], "%d", &blockSize); err != nil {
		return false
	}
	if _, err := fmt.Sscanf(parts[3], "%d", &parallelization); err != nil {
		return false
	}
	if _, err := fmt.Sscanf(parts[4], "%d", &keyLength); err != nil {
		return false
	}

	salt, err := hex.DecodeString(parts[5])
	if err != nil {
		return false
	}
	expected, err := hex.DecodeString(parts[6])
	if err != nil || len(expected) != keyLength {
		return false
	}

	actual, err := scrypt.Key([]byte(strings.TrimSpace(password)), salt, cost, blockSize, parallelization, keyLength)
	if err != nil {
		return false
	}

	return subtle.ConstantTimeCompare(actual, expected) == 1
}

func HashPassword(password string) (string, error) {
	normalized := strings.TrimSpace(password)
	if normalized == "" {
		return "", nil
	}
	var salt [16]byte
	if _, err := rand.Read(salt[:]); err != nil {
		return "", err
	}
	derived, err := scrypt.Key([]byte(normalized), salt[:], 16384, 8, 1, 32)
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("scrypt$16384$8$1$32$%s$%s", hex.EncodeToString(salt[:]), hex.EncodeToString(derived)), nil
}

func ResolveDirectory(session model.Session, requested string) (string, error) {
	target := strings.TrimSpace(requested)
	if target == "" {
		return "", errors.New("path is required")
	}
	if !filepath.IsAbs(target) {
		target = filepath.Join(session.CWD, target)
	}
	target = filepath.Clean(target)
	info, err := os.Stat(target)
	if err != nil {
		return "", err
	}
	if !info.IsDir() {
		return "", fmt.Errorf("%s is not a directory", target)
	}
	if session.AccessScope == model.ScopeSystem {
		return target, nil
	}
	for _, allowed := range AllowedPaths(session) {
		if isInside(target, allowed) {
			return target, nil
		}
	}
	return "", fmt.Errorf("%s is outside the allowed workspace", target)
}

func AllowedPaths(session model.Session) []string {
	allowed := []string{filepath.Clean(session.WorkspaceRoot)}
	for _, extra := range session.ExtraAllowedDirs {
		extra = filepath.Clean(extra)
		if extra != "" {
			allowed = append(allowed, extra)
		}
	}
	if session.AccessScope == model.ScopeSystem {
		allowed = append(allowed, string(filepath.Separator))
	}
	return allowed
}

func ValidateWorkspaceRoot(workspaceRoot string) (string, error) {
	if strings.TrimSpace(workspaceRoot) == "" {
		return "", errors.New("workspace root is required")
	}
	root := filepath.Clean(workspaceRoot)
	if !filepath.IsAbs(root) {
		return "", errors.New("workspace root must be absolute")
	}
	info, err := os.Stat(root)
	if err != nil {
		return "", err
	}
	if !info.IsDir() {
		return "", errors.New("workspace root must be a directory")
	}
	return root, nil
}

func BuildRollingSummary(audits []model.AuditRecord) string {
	if len(audits) == 0 {
		return ""
	}
	lines := make([]string, 0, len(audits))
	for _, audit := range audits {
		lines = append(lines, fmt.Sprintf("[%s] %s", audit.EventType, summarizePayload(audit.Payload)))
	}
	return strings.Join(lines, "\n")
}

func BuildResumePrompt(summary string) string {
	summary = strings.TrimSpace(summary)
	if summary == "" {
		summary = "approved request"
	}
	return "Resume the previous task. Approval granted for: " + summary
}

func isInside(target, base string) bool {
	target = filepath.Clean(target)
	base = filepath.Clean(base)
	if base == string(filepath.Separator) {
		return strings.HasPrefix(target, string(filepath.Separator))
	}
	return target == base || strings.HasPrefix(target, base+string(filepath.Separator))
}

func summarizePayload(payload map[string]any) string {
	if len(payload) == 0 {
		return ""
	}
	parts := make([]string, 0, len(payload))
	for key, value := range payload {
		parts = append(parts, fmt.Sprintf("%s=%v", key, value))
	}
	return strings.Join(parts, ", ")
}
