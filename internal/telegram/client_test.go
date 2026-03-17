package telegram

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestCallReturnsHTTPStatusErrors(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "upstream failure", http.StatusBadGateway)
	}))
	defer server.Close()

	client := NewClientWithOptions(Options{
		Token:      "token",
		HTTPClient: server.Client(),
		BaseURL:    server.URL + "/bottoken",
	})

	_, err := client.SendMessage(context.Background(), "1", "hello", nil)
	if err == nil {
		t.Fatal("expected sendMessage to fail")
	}
	if !strings.Contains(err.Error(), "http 502") {
		t.Fatalf("expected http status in error, got %v", err)
	}
}

func TestDownloadToTempRejectsFailedDownloads(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.Contains(r.URL.Path, "/getFile"):
			_ = json.NewEncoder(w).Encode(map[string]any{
				"ok": true,
				"result": map[string]any{
					"file_path": "broken.jpg",
				},
			})
		case strings.Contains(r.URL.Path, "/file/"):
			http.Error(w, "missing file", http.StatusNotFound)
		default:
			http.Error(w, "unsupported", http.StatusNotFound)
		}
	}))
	defer server.Close()

	client := NewClientWithOptions(Options{
		Token:       "token",
		HTTPClient:  server.Client(),
		BaseURL:     server.URL + "/bottoken",
		FileBaseURL: server.URL + "/file/bottoken",
	})

	_, _, err := client.DownloadToTemp(context.Background(), "file-id", "photo.jpg", t.TempDir())
	if err == nil {
		t.Fatal("expected download to fail")
	}
	if !strings.Contains(err.Error(), "http 404") {
		t.Fatalf("expected http status in error, got %v", err)
	}
}

func TestCallRedactsTokenFromTransportErrors(t *testing.T) {
	t.Parallel()

	client := NewClientWithOptions(Options{
		Token: "super-secret-token",
		HTTPClient: &http.Client{
			Timeout: 50 * time.Millisecond,
		},
		BaseURL: "http://127.0.0.1:1/botsuper-secret-token",
	})

	_, err := client.SendMessage(context.Background(), "1", "hello", nil)
	if err == nil {
		t.Fatal("expected sendMessage to fail")
	}
	if strings.Contains(err.Error(), "super-secret-token") {
		t.Fatalf("expected token to be redacted, got %v", err)
	}
	if !strings.Contains(err.Error(), "[redacted]") {
		t.Fatalf("expected redacted marker in error, got %v", err)
	}
}
