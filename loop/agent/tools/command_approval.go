package tools

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode"

	"github.com/google/uuid"
)

type CommandApprovalDecision string

const (
	CommandApprovalDecisionDeny         CommandApprovalDecision = "deny"
	CommandApprovalDecisionAllowOnce    CommandApprovalDecision = "allow_once"
	CommandApprovalDecisionAllowSession CommandApprovalDecision = "allow_session"
)

const commandApprovalWaitTimeout = 10 * time.Minute

var (
	ErrCommandApprovalNotFound = errors.New("command approval request not found")
	ErrInvalidCommandDecision  = errors.New("invalid command approval decision")
)

type CommandApprovalRequest struct {
	ID             string    `json:"id"`
	SessionID      string    `json:"session_id,omitempty"`
	ConversationID string    `json:"conversation_id,omitempty"`
	ToolName       string    `json:"tool_name"`
	Command        string    `json:"command"`
	Workdir        string    `json:"workdir,omitempty"`
	RequestedAt    time.Time `json:"requested_at"`
}

type CommandApprovalResolution struct {
	Decision CommandApprovalDecision `json:"decision"`
	Message  string                  `json:"message,omitempty"`
}

type CommandApprovalRequester interface {
	RequestCommandApproval(ctx context.Context, req CommandApprovalRequest) (CommandApprovalResolution, error)
}

type CommandApprovalRequesterFunc func(ctx context.Context, req CommandApprovalRequest) (CommandApprovalResolution, error)

func (f CommandApprovalRequesterFunc) RequestCommandApproval(
	ctx context.Context,
	req CommandApprovalRequest,
) (CommandApprovalResolution, error) {
	if f == nil {
		return CommandApprovalResolution{Decision: CommandApprovalDecisionAllowSession}, nil
	}
	return f(ctx, req)
}

type pendingCommandApproval struct {
	request    CommandApprovalRequest
	decisionCh chan CommandApprovalResolution
}

// CommandApprovalManager coordinates in-flight shell/exec approval prompts.
// It is process-local and suitable for a single loop server instance.
type CommandApprovalManager struct {
	mu sync.Mutex

	pending       map[string]*pendingCommandApproval
	allowSessions map[string]bool
}

func NewCommandApprovalManager() *CommandApprovalManager {
	return &CommandApprovalManager{
		pending:       make(map[string]*pendingCommandApproval),
		allowSessions: make(map[string]bool),
	}
}

func ParseCommandApprovalDecision(raw string) (CommandApprovalDecision, error) {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case string(CommandApprovalDecisionDeny):
		return CommandApprovalDecisionDeny, nil
	case string(CommandApprovalDecisionAllowOnce):
		return CommandApprovalDecisionAllowOnce, nil
	case string(CommandApprovalDecisionAllowSession):
		return CommandApprovalDecisionAllowSession, nil
	default:
		return "", fmt.Errorf("%w: %q (allowed: deny, allow_once, allow_session)", ErrInvalidCommandDecision, raw)
	}
}

func (m *CommandApprovalManager) AwaitDecision(
	ctx context.Context,
	req CommandApprovalRequest,
	notify func(CommandApprovalRequest),
) (CommandApprovalResolution, error) {
	if m == nil {
		return CommandApprovalResolution{Decision: CommandApprovalDecisionAllowSession}, nil
	}

	req.SessionID = strings.TrimSpace(req.SessionID)
	req.ConversationID = strings.TrimSpace(req.ConversationID)
	req.ToolName = strings.TrimSpace(req.ToolName)
	req.Command = strings.TrimSpace(req.Command)
	req.Workdir = strings.TrimSpace(req.Workdir)

	switch {
	case req.SessionID == "":
		return CommandApprovalResolution{}, fmt.Errorf("approval session_id is required")
	case req.ToolName == "":
		return CommandApprovalResolution{}, fmt.Errorf("approval tool_name is required")
	case req.Command == "":
		return CommandApprovalResolution{}, fmt.Errorf("approval command is required")
	}

	if m.isSessionAllowed(req.SessionID) {
		return CommandApprovalResolution{Decision: CommandApprovalDecisionAllowSession}, nil
	}

	req.ID = uuid.New().String()
	req.RequestedAt = time.Now().UTC()

	entry := &pendingCommandApproval{
		request:    req,
		decisionCh: make(chan CommandApprovalResolution, 1),
	}

	m.mu.Lock()
	m.pending[req.ID] = entry
	m.mu.Unlock()

	if notify != nil {
		notify(req)
	}

	timer := time.NewTimer(commandApprovalWaitTimeout)
	defer timer.Stop()

	select {
	case resolution := <-entry.decisionCh:
		m.removePending(req.ID)
		normalized, err := ParseCommandApprovalDecision(string(resolution.Decision))
		if err != nil {
			return CommandApprovalResolution{Decision: CommandApprovalDecisionDeny}, nil
		}
		if normalized == CommandApprovalDecisionAllowSession {
			m.setSessionAllowed(req.SessionID, true)
		}
		return CommandApprovalResolution{
			Decision: normalized,
			Message:  strings.TrimSpace(resolution.Message),
		}, nil
	case <-ctx.Done():
		m.removePending(req.ID)
		return CommandApprovalResolution{}, fmt.Errorf("approval cancelled: %w", ctx.Err())
	case <-timer.C:
		m.removePending(req.ID)
		return CommandApprovalResolution{}, fmt.Errorf("approval timed out after %s", commandApprovalWaitTimeout)
	}
}

func (m *CommandApprovalManager) Resolve(id string, decision CommandApprovalDecision, message string) error {
	if m == nil {
		return fmt.Errorf("command approval manager is not configured")
	}
	id = strings.TrimSpace(id)
	if id == "" {
		return fmt.Errorf("approval id is required")
	}

	normalized, err := ParseCommandApprovalDecision(string(decision))
	if err != nil {
		return err
	}
	message = strings.TrimSpace(message)
	if normalized != CommandApprovalDecisionDeny {
		message = ""
	}

	m.mu.Lock()
	entry, ok := m.pending[id]
	if !ok {
		m.mu.Unlock()
		return ErrCommandApprovalNotFound
	}
	delete(m.pending, id)
	if normalized == CommandApprovalDecisionAllowSession {
		m.allowSessions[entry.request.SessionID] = true
	}
	m.mu.Unlock()

	select {
	case entry.decisionCh <- CommandApprovalResolution{
		Decision: normalized,
		Message:  message,
	}:
	default:
	}
	return nil
}

func (m *CommandApprovalManager) ClearSession(sessionID string) {
	if m == nil {
		return
	}
	sessionID = strings.TrimSpace(sessionID)
	if sessionID == "" {
		return
	}
	m.mu.Lock()
	delete(m.allowSessions, sessionID)
	m.mu.Unlock()
}

func (m *CommandApprovalManager) ListPending(conversationID string) []CommandApprovalRequest {
	if m == nil {
		return nil
	}
	conversationID = strings.TrimSpace(conversationID)

	m.mu.Lock()
	pending := make([]CommandApprovalRequest, 0, len(m.pending))
	for _, entry := range m.pending {
		if entry == nil {
			continue
		}
		req := entry.request
		if conversationID != "" && req.ConversationID != conversationID {
			continue
		}
		pending = append(pending, req)
	}
	m.mu.Unlock()

	sort.Slice(pending, func(i, j int) bool {
		if pending[i].RequestedAt.Equal(pending[j].RequestedAt) {
			return pending[i].ID < pending[j].ID
		}
		return pending[i].RequestedAt.Before(pending[j].RequestedAt)
	})

	return pending
}

func (m *CommandApprovalManager) removePending(id string) {
	if m == nil {
		return
	}
	m.mu.Lock()
	delete(m.pending, id)
	m.mu.Unlock()
}

func (m *CommandApprovalManager) isSessionAllowed(sessionID string) bool {
	if m == nil {
		return false
	}
	sessionID = strings.TrimSpace(sessionID)
	if sessionID == "" {
		return false
	}
	m.mu.Lock()
	allowed := m.allowSessions[sessionID]
	m.mu.Unlock()
	return allowed
}

func (m *CommandApprovalManager) setSessionAllowed(sessionID string, allowed bool) {
	if m == nil {
		return
	}
	sessionID = strings.TrimSpace(sessionID)
	if sessionID == "" {
		return
	}
	m.mu.Lock()
	if allowed {
		m.allowSessions[sessionID] = true
	} else {
		delete(m.allowSessions, sessionID)
	}
	m.mu.Unlock()
}

func maybeRequireCommandApproval(
	ctx context.Context,
	requester CommandApprovalRequester,
	req CommandApprovalRequest,
) error {
	if requester == nil {
		return nil
	}
	if isAllowlistedSafeCommand(req.ToolName, req.Command) {
		return nil
	}

	resolution, err := requester.RequestCommandApproval(ctx, req)
	if err != nil {
		return fmt.Errorf("command approval failed: %w", err)
	}
	if resolution.Decision == CommandApprovalDecisionDeny {
		message := strings.TrimSpace(resolution.Message)
		if message != "" {
			return fmt.Errorf("command execution denied by user: %s", message)
		}
		return fmt.Errorf("command execution denied by user")
	}
	return nil
}

func isAllowlistedSafeCommand(toolName string, command string) bool {
	switch canonicalToolName(toolName) {
	case "exec_command", "shell":
		return isSafeReadonlyCommand(command)
	default:
		return false
	}
}

func canonicalToolName(raw string) string {
	name := strings.ToLower(strings.TrimSpace(raw))
	if idx := strings.LastIndex(name, ":"); idx >= 0 && idx < len(name)-1 {
		name = name[idx+1:]
	}
	if idx := strings.LastIndex(name, "."); idx >= 0 && idx < len(name)-1 {
		name = name[idx+1:]
	}
	return name
}

func isSafeReadonlyCommand(command string) bool {
	cmd := strings.TrimSpace(command)
	if cmd == "" {
		return false
	}
	if strings.Contains(cmd, "||") || strings.Contains(cmd, ";") {
		return false
	}
	if strings.ContainsAny(cmd, "`$|<>[]{}()\n\r") {
		return false
	}
	withoutAnd := strings.ReplaceAll(cmd, "&&", "")
	if strings.Contains(withoutAnd, "&") {
		return false
	}

	segments := strings.Split(cmd, "&&")
	if len(segments) == 0 {
		return false
	}
	for _, segment := range segments {
		tokens, ok := splitSafeCommandTokens(segment)
		if !ok || !isAllowlistedReadonlySegment(tokens) {
			return false
		}
	}
	return true
}

func splitSafeCommandTokens(segment string) ([]string, bool) {
	trimmed := strings.TrimSpace(segment)
	if trimmed == "" {
		return nil, false
	}
	if strings.ContainsAny(trimmed, `'"\\`) {
		return nil, false
	}
	tokens := strings.Fields(trimmed)
	if len(tokens) == 0 {
		return nil, false
	}
	for _, token := range tokens {
		if !isSafeToken(token) {
			return nil, false
		}
	}
	return tokens, true
}

func isSafeToken(token string) bool {
	if token == "" {
		return false
	}
	for _, r := range token {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			continue
		}
		switch r {
		case '-', '_', '.', '/', '@', ':', '+', ',', '=', '%', '~':
			continue
		default:
			return false
		}
	}
	return true
}

func isAllowlistedReadonlySegment(tokens []string) bool {
	if len(tokens) == 0 {
		return false
	}
	switch tokens[0] {
	case "pwd":
		return len(tokens) == 1
	case "ls", "cat", "head", "tail", "wc", "stat", "file", "rg", "grep":
		return allReadonlyArgs(tokens[1:])
	case "git":
		return isAllowlistedGitReadonly(tokens[1:])
	default:
		return false
	}
}

func allReadonlyArgs(args []string) bool {
	for _, arg := range args {
		if arg == "--" || strings.HasPrefix(arg, "-") {
			continue
		}
		if isAbsolutePathArg(arg) {
			return false
		}
	}
	return true
}

func isAllowlistedGitReadonly(args []string) bool {
	if len(args) == 0 {
		return false
	}
	subcommand := strings.ToLower(strings.TrimSpace(args[0]))
	switch subcommand {
	case "status", "diff", "log", "show", "rev-parse", "branch", "ls-files":
		// allowed
	default:
		return false
	}

	for _, arg := range args[1:] {
		if arg == "--" {
			continue
		}
		lower := strings.ToLower(arg)
		if lower == "-c" ||
			strings.HasPrefix(lower, "--config-env") ||
			strings.HasPrefix(lower, "--exec-path") ||
			strings.HasPrefix(lower, "--git-dir") ||
			strings.HasPrefix(lower, "--work-tree") {
			return false
		}
		if isAbsolutePathArg(arg) {
			return false
		}
	}
	return true
}

func isAbsolutePathArg(arg string) bool {
	if strings.HasPrefix(arg, "/") || strings.HasPrefix(arg, `\\`) {
		return true
	}
	if len(arg) >= 3 && unicode.IsLetter(rune(arg[0])) && arg[1] == ':' && (arg[2] == '\\' || arg[2] == '/') {
		return true
	}
	return false
}
