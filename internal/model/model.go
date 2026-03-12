package model

import "time"

type SessionMode string
type SessionAccessScope string
type SessionRunState string
type CancellationResult string
type PendingActionResolution string

const (
	ModeAsk  SessionMode = "ask"
	ModePlan SessionMode = "plan"
	ModeCode SessionMode = "code"
)

const (
	ScopeWorkspace SessionAccessScope = "workspace"
	ScopeSystem    SessionAccessScope = "system"
)

const (
	RunIdle            SessionRunState = "idle"
	RunRunning         SessionRunState = "running"
	RunWaitingApproval SessionRunState = "waiting_approval"
	RunCancelling      SessionRunState = "cancelling"
	RunCancelled       SessionRunState = "cancelled"
	RunFailed          SessionRunState = "failed"
)

const (
	CancelFull    CancellationResult = "full"
	CancelPartial CancellationResult = "partial"
	CancelUnknown CancellationResult = "unknown"
)

const (
	ResolutionApproved PendingActionResolution = "approved"
	ResolutionDenied   PendingActionResolution = "denied"
	ResolutionExpired  PendingActionResolution = "expired"
)

type Session struct {
	SessionID          string
	WorkspaceRoot      string
	ExtraAllowedDirs   []string
	CWD                string
	Mode               SessionMode
	AccessScope        SessionAccessScope
	CodexThreadID      string
	RollingSummary     string
	RunState           SessionRunState
	CancellationResult string
	ActiveRunID        string
	StaleRecovered     bool
	LastError          string
	CreatedAt          time.Time
	UpdatedAt          time.Time
}

type TelegramUserAuth struct {
	UserID            string
	LatestChatID      string
	FirstSeenAt       time.Time
	VerifiedAt        *time.Time
	PreferredLanguage string
	FailedAttempts    int
	LastFailedAt      *time.Time
	BannedAt          *time.Time
	UpdatedAt         time.Time
}

type PendingAction struct {
	ActionID        string
	ActionType      string
	SessionID       string
	RunID           string
	ChatID          string
	UserID          string
	SourceMessageID string
	Payload         map[string]string
	ExpiresAt       time.Time
	Resolved        bool
	Resolution      string
	ResolvedAt      *time.Time
	CreatedAt       time.Time
}

type AuditRecord struct {
	SessionID string
	ChatID    string
	RunID     string
	EventType string
	Payload   map[string]any
	CreatedAt time.Time
}
