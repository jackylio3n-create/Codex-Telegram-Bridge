package telegram

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type Client struct {
	token       string
	httpClient  *http.Client
	baseURL     string
	fileBaseURL string
}

type Update struct {
	UpdateID      int64          `json:"update_id"`
	Message       *Message       `json:"message,omitempty"`
	EditedMessage *Message       `json:"edited_message,omitempty"`
	CallbackQuery *CallbackQuery `json:"callback_query,omitempty"`
}

type Message struct {
	MessageID int64       `json:"message_id"`
	Date      int64       `json:"date"`
	Text      string      `json:"text,omitempty"`
	Caption   string      `json:"caption,omitempty"`
	Chat      Chat        `json:"chat"`
	From      *User       `json:"from,omitempty"`
	Photo     []PhotoSize `json:"photo,omitempty"`
	Document  *Document   `json:"document,omitempty"`
}

type Chat struct {
	ID   int64  `json:"id"`
	Type string `json:"type"`
}

type User struct {
	ID int64 `json:"id"`
}

type PhotoSize struct {
	FileID   string `json:"file_id"`
	FileSize int64  `json:"file_size,omitempty"`
	Width    int    `json:"width,omitempty"`
	Height   int    `json:"height,omitempty"`
}

type Document struct {
	FileID   string `json:"file_id"`
	MimeType string `json:"mime_type,omitempty"`
	FileName string `json:"file_name,omitempty"`
	FileSize int64  `json:"file_size,omitempty"`
}

type CallbackQuery struct {
	ID      string   `json:"id"`
	From    User     `json:"from"`
	Data    string   `json:"data,omitempty"`
	Message *Message `json:"message,omitempty"`
}

type InlineKeyboardMarkup struct {
	InlineKeyboard [][]InlineKeyboardButton `json:"inline_keyboard"`
}

type InlineKeyboardButton struct {
	Text         string `json:"text"`
	CallbackData string `json:"callback_data"`
}

type File struct {
	FilePath string `json:"file_path"`
}

type apiResponse[T any] struct {
	OK          bool   `json:"ok"`
	Description string `json:"description"`
	Result      T      `json:"result"`
}

type Options struct {
	Token       string
	HTTPClient  *http.Client
	BaseURL     string
	FileBaseURL string
}

func NewClient(token string) *Client {
	return NewClientWithOptions(Options{Token: token})
}

func NewClientWithOptions(options Options) *Client {
	httpClient := options.HTTPClient
	if httpClient == nil {
		httpClient = &http.Client{
			Timeout: 45 * time.Second,
		}
	}
	baseURL := options.BaseURL
	if baseURL == "" {
		baseURL = fmt.Sprintf("https://api.telegram.org/bot%s", options.Token)
	}
	fileBaseURL := options.FileBaseURL
	if fileBaseURL == "" {
		fileBaseURL = fmt.Sprintf("https://api.telegram.org/file/bot%s", options.Token)
	}
	return &Client{
		token:       options.Token,
		httpClient:  httpClient,
		baseURL:     baseURL,
		fileBaseURL: fileBaseURL,
	}
}

func (c *Client) GetUpdates(ctx context.Context, offset int64, timeoutSeconds int) ([]Update, error) {
	payload := map[string]any{
		"offset":          offset,
		"timeout":         timeoutSeconds,
		"allowed_updates": []string{"message", "callback_query"},
	}
	var response apiResponse[[]Update]
	if err := c.call(ctx, "getUpdates", payload, &response); err != nil {
		return nil, err
	}
	return response.Result, nil
}

func (c *Client) SendMessage(ctx context.Context, chatID, text string, replyMarkup *InlineKeyboardMarkup) (int64, error) {
	payload := map[string]any{
		"chat_id": chatID,
		"text":    clampMessage(text),
	}
	if replyMarkup != nil {
		payload["reply_markup"] = replyMarkup
	}
	var response apiResponse[Message]
	if err := c.call(ctx, "sendMessage", payload, &response); err != nil {
		return 0, err
	}
	return response.Result.MessageID, nil
}

func (c *Client) EditMessageText(ctx context.Context, chatID string, messageID int64, text string) error {
	var response apiResponse[map[string]any]
	return c.call(ctx, "editMessageText", map[string]any{
		"chat_id":    chatID,
		"message_id": messageID,
		"text":       clampMessage(text),
	}, &response)
}

func (c *Client) AnswerCallback(ctx context.Context, callbackID, text string, showAlert bool) error {
	var response apiResponse[bool]
	return c.call(ctx, "answerCallbackQuery", map[string]any{
		"callback_query_id": callbackID,
		"text":              clampMessage(text),
		"show_alert":        showAlert,
	}, &response)
}

func (c *Client) DownloadToTemp(ctx context.Context, fileID, preferredName, tempDir string) (string, func(), error) {
	file, err := c.getFile(ctx, fileID)
	if err != nil {
		return "", nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, fmt.Sprintf("%s/%s", strings.TrimRight(c.fileBaseURL, "/"), strings.TrimLeft(file.FilePath, "/")), nil)
	if err != nil {
		return "", nil, err
	}
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return "", nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", nil, fmt.Errorf("telegram file download failed: http %d: %s", resp.StatusCode, readErrorBody(resp.StatusCode, resp.Body))
	}

	if err := os.MkdirAll(tempDir, 0o700); err != nil {
		return "", nil, err
	}
	name := fmt.Sprintf("telegram-media-%d-%s", time.Now().UnixNano(), filepath.Base(preferredName))
	path := filepath.Join(tempDir, name)
	fileHandle, err := os.Create(path)
	if err != nil {
		return "", nil, err
	}
	defer fileHandle.Close()

	if _, err := io.Copy(fileHandle, resp.Body); err != nil {
		return "", nil, err
	}

	cleanup := func() { _ = os.Remove(path) }
	return path, cleanup, nil
}

func (c *Client) getFile(ctx context.Context, fileID string) (File, error) {
	var response apiResponse[File]
	if err := c.call(ctx, "getFile", map[string]any{"file_id": fileID}, &response); err != nil {
		return File{}, err
	}
	return response.Result, nil
}

func (c *Client) call(ctx context.Context, method string, payload any, target any) error {
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, fmt.Sprintf("%s/%s", strings.TrimRight(c.baseURL, "/"), method), bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("telegram %s failed: http %d: %s", method, resp.StatusCode, readErrorBody(resp.StatusCode, resp.Body))
	}

	if err := json.NewDecoder(resp.Body).Decode(target); err != nil {
		return err
	}
	if asResponse, ok := target.(interface {
		GetOK() bool
		GetDescription() string
	}); ok {
		if !asResponse.GetOK() {
			return fmt.Errorf("telegram %s failed: %s", method, asResponse.GetDescription())
		}
		return nil
	}
	switch typed := target.(type) {
	case *apiResponse[[]Update]:
		if !typed.OK {
			return fmt.Errorf("telegram %s failed: %s", method, typed.Description)
		}
	case *apiResponse[Message]:
		if !typed.OK {
			return fmt.Errorf("telegram %s failed: %s", method, typed.Description)
		}
	case *apiResponse[map[string]any]:
		if !typed.OK {
			return fmt.Errorf("telegram %s failed: %s", method, typed.Description)
		}
	case *apiResponse[bool]:
		if !typed.OK {
			return fmt.Errorf("telegram %s failed: %s", method, typed.Description)
		}
	case *apiResponse[File]:
		if !typed.OK {
			return fmt.Errorf("telegram %s failed: %s", method, typed.Description)
		}
	}
	return nil
}

func clampMessage(text string) string {
	runes := []rune(text)
	if len(runes) <= 3900 {
		return text
	}
	return string(runes[:3900]) + "\n\n[truncated]"
}

func readErrorBody(statusCode int, reader io.Reader) string {
	body, err := io.ReadAll(io.LimitReader(reader, 512))
	if err != nil {
		return "unable to read response body"
	}
	trimmed := strings.TrimSpace(string(body))
	if trimmed == "" {
		return http.StatusText(statusCode)
	}
	return trimmed
}
