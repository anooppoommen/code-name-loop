package tools

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"
)

func TestCommandApprovalManager_AwaitAndResolveAllowOnce(t *testing.T) {
	mgr := NewCommandApprovalManager()
	promptCh := make(chan CommandApprovalRequest, 1)
	resultCh := make(chan CommandApprovalResolution, 1)
	errCh := make(chan error, 1)

	go func() {
		resolution, err := mgr.AwaitDecision(
			context.Background(),
			CommandApprovalRequest{
				SessionID: "session-1",
				ToolName:  "exec_command",
				Command:   "pwd",
				Workdir:   "/tmp",
			},
			func(req CommandApprovalRequest) {
				promptCh <- req
			},
		)
		if err != nil {
			errCh <- err
			return
		}
		resultCh <- resolution
	}()

	var prompt CommandApprovalRequest
	select {
	case prompt = <-promptCh:
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for approval prompt")
	}
	if prompt.ID == "" {
		t.Fatal("expected generated approval id")
	}

	if err := mgr.Resolve(prompt.ID, CommandApprovalDecisionAllowOnce, ""); err != nil {
		t.Fatalf("resolve: %v", err)
	}

	select {
	case err := <-errCh:
		t.Fatalf("await returned error: %v", err)
	case resolution := <-resultCh:
		if resolution.Decision != CommandApprovalDecisionAllowOnce {
			t.Fatalf("decision = %q, want %q", resolution.Decision, CommandApprovalDecisionAllowOnce)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for approval decision")
	}
}

func TestCommandApprovalManager_AllowSessionSkipsSubsequentPrompt(t *testing.T) {
	mgr := NewCommandApprovalManager()
	promptCh := make(chan CommandApprovalRequest, 1)
	resultCh := make(chan CommandApprovalResolution, 1)
	errCh := make(chan error, 1)

	go func() {
		resolution, err := mgr.AwaitDecision(
			context.Background(),
			CommandApprovalRequest{
				SessionID: "session-allow",
				ToolName:  "exec_command",
				Command:   "go test ./...",
			},
			func(req CommandApprovalRequest) {
				promptCh <- req
			},
		)
		if err != nil {
			errCh <- err
			return
		}
		resultCh <- resolution
	}()

	var prompt CommandApprovalRequest
	select {
	case prompt = <-promptCh:
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for approval prompt")
	}

	if err := mgr.Resolve(prompt.ID, CommandApprovalDecisionAllowSession, ""); err != nil {
		t.Fatalf("resolve: %v", err)
	}

	select {
	case err := <-errCh:
		t.Fatalf("await returned error: %v", err)
	case resolution := <-resultCh:
		if resolution.Decision != CommandApprovalDecisionAllowSession {
			t.Fatalf("decision = %q, want %q", resolution.Decision, CommandApprovalDecisionAllowSession)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for approval decision")
	}

	notified := false
	resolution, err := mgr.AwaitDecision(
		context.Background(),
		CommandApprovalRequest{
			SessionID: "session-allow",
			ToolName:  "exec_command",
			Command:   "ls -la",
		},
		func(req CommandApprovalRequest) {
			notified = true
		},
	)
	if err != nil {
		t.Fatalf("second await: %v", err)
	}
	if resolution.Decision != CommandApprovalDecisionAllowSession {
		t.Fatalf("second decision = %q, want %q", resolution.Decision, CommandApprovalDecisionAllowSession)
	}
	if notified {
		t.Fatal("expected second command to skip approval prompt after allow_session")
	}
}

func TestCommandApprovalManager_ResolveUnknown(t *testing.T) {
	mgr := NewCommandApprovalManager()
	err := mgr.Resolve("does-not-exist", CommandApprovalDecisionDeny, "")
	if !errors.Is(err, ErrCommandApprovalNotFound) {
		t.Fatalf("expected ErrCommandApprovalNotFound, got %v", err)
	}
}

func TestCommandApprovalManager_DenyIncludesMessage(t *testing.T) {
	mgr := NewCommandApprovalManager()
	promptCh := make(chan CommandApprovalRequest, 1)
	resultCh := make(chan CommandApprovalResolution, 1)
	errCh := make(chan error, 1)

	go func() {
		resolution, err := mgr.AwaitDecision(
			context.Background(),
			CommandApprovalRequest{
				SessionID: "session-deny",
				ToolName:  "shell",
				Command:   "rm -rf /tmp/test",
			},
			func(req CommandApprovalRequest) {
				promptCh <- req
			},
		)
		if err != nil {
			errCh <- err
			return
		}
		resultCh <- resolution
	}()

	var prompt CommandApprovalRequest
	select {
	case prompt = <-promptCh:
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for approval prompt")
	}

	if err := mgr.Resolve(prompt.ID, CommandApprovalDecisionDeny, "not safe to run right now"); err != nil {
		t.Fatalf("resolve: %v", err)
	}

	select {
	case err := <-errCh:
		t.Fatalf("await returned error: %v", err)
	case resolution := <-resultCh:
		if resolution.Decision != CommandApprovalDecisionDeny {
			t.Fatalf("decision = %q, want %q", resolution.Decision, CommandApprovalDecisionDeny)
		}
		if resolution.Message != "not safe to run right now" {
			t.Fatalf("message = %q", resolution.Message)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for approval decision")
	}
}

func TestCommandApprovalManager_ListPendingFilteredAndSorted(t *testing.T) {
	mgr := NewCommandApprovalManager()
	promptCh := make(chan CommandApprovalRequest, 2)
	errCh := make(chan error, 2)

	startAwait := func(sessionID, conversationID, command string) {
		go func() {
			_, err := mgr.AwaitDecision(
				context.Background(),
				CommandApprovalRequest{
					SessionID:      sessionID,
					ConversationID: conversationID,
					ToolName:       "exec_command",
					Command:        command,
				},
				func(req CommandApprovalRequest) {
					promptCh <- req
				},
			)
			if err != nil {
				errCh <- err
			}
		}()
	}

	startAwait("s-1", "conv-a", "echo a")
	startAwait("s-2", "conv-b", "echo b")

	prompts := make([]CommandApprovalRequest, 0, 2)
	deadline := time.After(3 * time.Second)
	for len(prompts) < 2 {
		select {
		case prompt := <-promptCh:
			prompts = append(prompts, prompt)
		case <-deadline:
			t.Fatal("timed out waiting for approval prompts")
		}
	}

	filtered := mgr.ListPending("conv-a")
	if len(filtered) != 1 {
		t.Fatalf("filtered len = %d, want 1", len(filtered))
	}
	if filtered[0].ConversationID != "conv-a" {
		t.Fatalf("filtered conversation_id = %q", filtered[0].ConversationID)
	}
	if filtered[0].Command != "echo a" {
		t.Fatalf("filtered command = %q", filtered[0].Command)
	}

	all := mgr.ListPending("")
	if len(all) != 2 {
		t.Fatalf("all len = %d, want 2", len(all))
	}
	if all[0].RequestedAt.After(all[1].RequestedAt) {
		t.Fatal("pending approvals should be sorted by requested_at")
	}

	for _, prompt := range prompts {
		if err := mgr.Resolve(prompt.ID, CommandApprovalDecisionDeny, "cleanup"); err != nil {
			t.Fatalf("resolve prompt %s: %v", prompt.ID, err)
		}
	}

	select {
	case err := <-errCh:
		t.Fatalf("await returned error: %v", err)
	case <-time.After(50 * time.Millisecond):
		// no-op
	}
}

func TestMaybeRequireCommandApproval_SkipsAllowlistedSafeCommands(t *testing.T) {
	requestCount := 0
	requester := CommandApprovalRequesterFunc(func(ctx context.Context, req CommandApprovalRequest) (CommandApprovalResolution, error) {
		requestCount++
		return CommandApprovalResolution{
			Decision: CommandApprovalDecisionDeny,
			Message:  "should not be requested",
		}, nil
	})

	err := maybeRequireCommandApproval(context.Background(), requester, CommandApprovalRequest{
		SessionID: "session-safe",
		ToolName:  "exec_command",
		Command:   "git status && git diff --staged",
		Workdir:   ".",
	})
	if err != nil {
		t.Fatalf("expected allowlisted command to skip approval, got %v", err)
	}
	if requestCount != 0 {
		t.Fatalf("approval requester called %d times, want 0", requestCount)
	}
}

func TestMaybeRequireCommandApproval_UnsafeCommandStillRequiresPrompt(t *testing.T) {
	requestCount := 0
	requester := CommandApprovalRequesterFunc(func(ctx context.Context, req CommandApprovalRequest) (CommandApprovalResolution, error) {
		requestCount++
		return CommandApprovalResolution{
			Decision: CommandApprovalDecisionDeny,
			Message:  "denied",
		}, nil
	})

	err := maybeRequireCommandApproval(context.Background(), requester, CommandApprovalRequest{
		SessionID: "session-unsafe",
		ToolName:  "exec_command",
		Command:   "git status; rm -rf /tmp/test",
		Workdir:   ".",
	})
	if err == nil {
		t.Fatal("expected unsafe command to require approval and be denied")
	}
	if requestCount != 1 {
		t.Fatalf("approval requester called %d times, want 1", requestCount)
	}
}

func TestMaybeRequireCommandApproval_NonAllowlistedGitSubcommandRequiresPrompt(t *testing.T) {
	requestCount := 0
	requester := CommandApprovalRequesterFunc(func(ctx context.Context, req CommandApprovalRequest) (CommandApprovalResolution, error) {
		requestCount++
		return CommandApprovalResolution{
			Decision: CommandApprovalDecisionAllowOnce,
		}, nil
	})

	err := maybeRequireCommandApproval(context.Background(), requester, CommandApprovalRequest{
		SessionID: "session-commit",
		ToolName:  "shell",
		Command:   "git commit -m test",
		Workdir:   ".",
	})
	if err != nil {
		t.Fatalf("expected prompt-approved command to pass, got %v", err)
	}
	if requestCount != 1 {
		t.Fatalf("approval requester called %d times, want 1", requestCount)
	}
}

func TestIsAllowlistedSafeCommand(t *testing.T) {
	cases := []struct {
		toolName string
		command  string
		want     bool
	}{
		{toolName: "exec_command", command: "pwd", want: true},
		{toolName: "exec_command", command: "ls -la", want: true},
		{toolName: "shell", command: "git status && git diff --staged", want: true},
		{toolName: "shell", command: "git log -1", want: true},
		{toolName: "shell", command: "git commit -m test", want: false},
		{toolName: "shell", command: "cat /etc/passwd", want: false},
		{toolName: "shell", command: "git status; whoami", want: false},
		{toolName: "shell", command: "git status | cat", want: false},
		{toolName: "request_user_input", command: "pwd", want: false},
	}

	for _, tc := range cases {
		t.Run(fmt.Sprintf("%s:%s", tc.toolName, tc.command), func(t *testing.T) {
			got := isAllowlistedSafeCommand(tc.toolName, tc.command)
			if got != tc.want {
				t.Fatalf("isAllowlistedSafeCommand(%q, %q) = %v, want %v", tc.toolName, tc.command, got, tc.want)
			}
		})
	}
}
