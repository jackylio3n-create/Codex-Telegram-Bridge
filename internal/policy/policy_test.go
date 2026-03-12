package policy

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"codextelegrambridge/internal/model"
	"golang.org/x/crypto/scrypt"
)

func TestVerifyPassword(t *testing.T) {
	t.Parallel()

	password := "secret-pass"
	encoded := mustEncodePassword(t, password)
	if !VerifyPassword(password, encoded) {
		t.Fatal("expected password verification to succeed")
	}
	if VerifyPassword("wrong-pass", encoded) {
		t.Fatal("expected password verification to fail")
	}
}

func TestResolveDirectoryHonorsWorkspaceScope(t *testing.T) {
	t.Parallel()

	root := t.TempDir()
	inside := filepath.Join(root, "inside")
	outside := filepath.Join(t.TempDir(), "outside")
	if err := os.MkdirAll(inside, 0o755); err != nil {
		t.Fatalf("mkdir inside: %v", err)
	}
	if err := os.MkdirAll(outside, 0o755); err != nil {
		t.Fatalf("mkdir outside: %v", err)
	}

	session := model.Session{
		WorkspaceRoot: root,
		CWD:           root,
		AccessScope:   model.ScopeWorkspace,
	}
	if _, err := ResolveDirectory(session, inside); err != nil {
		t.Fatalf("expected inside path to resolve: %v", err)
	}
	if _, err := ResolveDirectory(session, outside); err == nil {
		t.Fatal("expected outside path to be rejected")
	}
}

func mustEncodePassword(t *testing.T, password string) string {
	t.Helper()

	var salt [16]byte
	if _, err := rand.Read(salt[:]); err != nil {
		t.Fatalf("rand.Read: %v", err)
	}
	derived, err := scrypt.Key([]byte(password), salt[:], 16384, 8, 1, 32)
	if err != nil {
		t.Fatalf("scrypt.Key: %v", err)
	}
	return fmt.Sprintf("scrypt$16384$8$1$32$%s$%s", hex.EncodeToString(salt[:]), hex.EncodeToString(derived))
}
