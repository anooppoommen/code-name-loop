package evals

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"time"

	_ "github.com/mattn/go-sqlite3"

	"loop/models"
)

const priorTurnWindow = 2

type dbConversation struct {
	ID          string
	WorkspaceID string
	Title       string
}

type dbMessage struct {
	ID             string
	ConversationID string
	Seq            int64
	SentBy         string
	PartsJSON      string
	CreatedAt      time.Time
}

type assistantTurnSummary struct {
	ToolCounts       map[string]int
	FirstTools       []string
	FinalAssistant   string
	ApprovalRequests int
	Errors           int
}

type turnBundle struct {
	UserMessage     dbMessage
	UserText        string
	AssistantMsgs   []dbMessage
	Assistant       assistantTurnSummary
	NextUserMessage string
}

func GenerateSuite(dbPath string) (*Suite, error) {
	db, err := sql.Open("sqlite3", dbPath)
	if err != nil {
		return nil, fmt.Errorf("open sqlite db: %w", err)
	}
	defer db.Close()

	workspaceRow := db.QueryRow(`
		SELECT id, name, root_path
		FROM workspaces
		ORDER BY created_at ASC
		LIMIT 1
	`)

	var workspaceID, workspaceName, workspaceRoot string
	if err := workspaceRow.Scan(&workspaceID, &workspaceName, &workspaceRoot); err != nil {
		return nil, fmt.Errorf("load workspace: %w", err)
	}

	conversations, err := loadConversations(db, workspaceID)
	if err != nil {
		return nil, err
	}

	suite := &Suite{
		GeneratedAt: time.Now().UTC(),
		Source: SuiteSource{
			DBPath:            dbPath,
			WorkspaceID:       workspaceID,
			WorkspaceName:     workspaceName,
			WorkspaceRoot:     workspaceRoot,
			ConversationCount: len(conversations),
		},
	}

	for _, conv := range conversations {
		messages, err := loadMessages(db, conv.ID)
		if err != nil {
			return nil, err
		}
		uiCounts, err := loadUIEventCountsBySeq(db, conv.ID)
		if err != nil {
			return nil, err
		}

		bundles := buildTurnBundles(messages, uiCounts)
		for idx, bundle := range bundles {
			if strings.TrimSpace(bundle.UserText) == "" {
				continue
			}
			suite.Cases = append(suite.Cases, buildCase(conv, workspaceRoot, bundle, bundles, idx))
		}
	}

	sort.Slice(suite.Cases, func(i, j int) bool {
		return suite.Cases[i].Source.CreatedAt.Before(suite.Cases[j].Source.CreatedAt)
	})
	suite.Source.UserTurnCount = len(suite.Cases)

	return suite, nil
}

func loadConversations(db *sql.DB, workspaceID string) ([]dbConversation, error) {
	rows, err := db.Query(`
		SELECT id, workspace_id, title
		FROM conversations
		WHERE workspace_id = ? AND parent_conversation_id = ''
		ORDER BY created_at ASC
	`, workspaceID)
	if err != nil {
		return nil, fmt.Errorf("list conversations: %w", err)
	}
	defer rows.Close()

	var conversations []dbConversation
	for rows.Next() {
		var conv dbConversation
		if err := rows.Scan(&conv.ID, &conv.WorkspaceID, &conv.Title); err != nil {
			return nil, fmt.Errorf("scan conversation: %w", err)
		}
		conversations = append(conversations, conv)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate conversations: %w", err)
	}

	return conversations, nil
}

func loadMessages(db *sql.DB, conversationID string) ([]dbMessage, error) {
	rows, err := db.Query(`
		SELECT id, conversation_id, seq, sent_by, parts_json, created_at
		FROM messages
		WHERE conversation_id = ? AND archived = 0
		ORDER BY seq ASC
	`, conversationID)
	if err != nil {
		return nil, fmt.Errorf("list messages for %s: %w", conversationID, err)
	}
	defer rows.Close()

	var messages []dbMessage
	for rows.Next() {
		var msg dbMessage
		if err := rows.Scan(&msg.ID, &msg.ConversationID, &msg.Seq, &msg.SentBy, &msg.PartsJSON, &msg.CreatedAt); err != nil {
			return nil, fmt.Errorf("scan message for %s: %w", conversationID, err)
		}
		messages = append(messages, msg)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate messages for %s: %w", conversationID, err)
	}

	return messages, nil
}

func loadUIEventCountsBySeq(db *sql.DB, conversationID string) (map[int64]map[string]int, error) {
	rows, err := db.Query(`
		SELECT seq, kind
		FROM ui_events
		WHERE conversation_id = ? AND archived = 0
		ORDER BY seq ASC
	`, conversationID)
	if err != nil {
		return nil, fmt.Errorf("list ui events for %s: %w", conversationID, err)
	}
	defer rows.Close()

	counts := make(map[int64]map[string]int)
	for rows.Next() {
		var seq int64
		var kind string
		if err := rows.Scan(&seq, &kind); err != nil {
			return nil, fmt.Errorf("scan ui event for %s: %w", conversationID, err)
		}
		if counts[seq] == nil {
			counts[seq] = make(map[string]int)
		}
		counts[seq][kind]++
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate ui events for %s: %w", conversationID, err)
	}

	return counts, nil
}

func buildTurnBundles(messages []dbMessage, uiCounts map[int64]map[string]int) []turnBundle {
	var bundles []turnBundle
	for i, msg := range messages {
		if msg.SentBy != string(models.SentByUser) {
			continue
		}

		bundle := turnBundle{
			UserMessage: msg,
			UserText:    extractText(msg.PartsJSON),
		}

		for j := i + 1; j < len(messages); j++ {
			if messages[j].SentBy == string(models.SentByUser) {
				bundle.NextUserMessage = extractText(messages[j].PartsJSON)
				break
			}
			bundle.AssistantMsgs = append(bundle.AssistantMsgs, messages[j])
			kinds := uiCounts[messages[j].Seq]
			bundle.Assistant.ApprovalRequests += kinds["approval_request"]
			bundle.Assistant.Errors += kinds["error"]
		}

		bundle.Assistant = summarizeAssistantMessages(bundle.AssistantMsgs, bundle.Assistant)
		bundles = append(bundles, bundle)
	}
	return bundles
}

func summarizeAssistantMessages(messages []dbMessage, seed assistantTurnSummary) assistantTurnSummary {
	summary := seed
	if summary.ToolCounts == nil {
		summary.ToolCounts = make(map[string]int)
	}

	for _, msg := range messages {
		var parts []models.MessagePart
		if err := json.Unmarshal([]byte(msg.PartsJSON), &parts); err != nil {
			continue
		}
		for _, part := range parts {
			switch part.Kind {
			case models.PartFunctionCall:
				if part.FunctionCall == nil {
					continue
				}
				name := strings.TrimSpace(part.FunctionCall.Name)
				if name == "" {
					continue
				}
				summary.ToolCounts[name]++
				if len(summary.FirstTools) < 4 {
					summary.FirstTools = append(summary.FirstTools, name)
				}
			case models.PartText:
				if part.Text == nil {
					continue
				}
				text := normalizeWhitespace(part.Text.Text)
				if text != "" {
					summary.FinalAssistant = truncateText(text, 260)
				}
			}
		}
	}

	return summary
}

func buildCase(conv dbConversation, workspaceRoot string, bundle turnBundle, bundles []turnBundle, idx int) Case {
	priorStart := idx - priorTurnWindow
	if priorStart < 0 {
		priorStart = 0
	}

	var priorTurns []PriorTurn
	for i := priorStart; i < idx; i++ {
		prev := bundles[i]
		priorTurns = append(priorTurns, PriorTurn{
			UserText:            truncateText(normalizeWhitespace(prev.UserText), 280),
			AssistantToolCounts: prev.Assistant.ToolCounts,
			AssistantFirstTools: prev.Assistant.FirstTools,
			AssistantFinalText:  prev.Assistant.FinalAssistant,
			ApprovalRequests:    prev.Assistant.ApprovalRequests,
			Errors:              prev.Assistant.Errors,
		})
	}

	userText := normalizeWhitespace(bundle.UserText)
	originalFirstQuery := ""
	if len(bundles) > 0 {
		originalFirstQuery = truncateText(normalizeWhitespace(bundles[0].UserText), 240)
	}

	artifacts := extractArtifacts(conv.Title + "\n" + userText)
	expectations := inferExpectations(conv, bundle, idx)
	originalRun := OriginalRun{
		ToolCounts:            bundle.Assistant.ToolCounts,
		FirstTools:            bundle.Assistant.FirstTools,
		ApprovalRequests:      bundle.Assistant.ApprovalRequests,
		Errors:                bundle.Assistant.Errors,
		FinalAssistantText:    bundle.Assistant.FinalAssistant,
		NextUserCorrection:    truncateText(normalizeWhitespace(bundle.NextUserMessage), 200),
		UserExpressedDissatis: dissatisfactionScore(bundle.NextUserMessage),
	}

	tags := deriveTags(expectations, artifacts, bundle, originalRun)
	return Case{
		ID: fmt.Sprintf("%s-turn-%02d", conv.ID, idx+1),
		Source: CaseSource{
			ConversationID:    conv.ID,
			ConversationTitle: conv.Title,
			MessageID:         bundle.UserMessage.ID,
			UserTurnIndex:     idx + 1,
			CreatedAt:         bundle.UserMessage.CreatedAt,
		},
		Input: CaseInput{
			WorkspaceRoot:      workspaceRoot,
			ConversationTitle:  conv.Title,
			ConversationPhase:  conversationPhase(idx, userText),
			PriorTurns:         priorTurns,
			LatestUserMessage:  userText,
			NamedArtifacts:     artifacts,
			OriginalFirstQuery: originalFirstQuery,
		},
		Expectations:  expectations,
		OriginalRun:   originalRun,
		FailureTraits: deriveFailureTraits(bundle, originalRun),
		Tags:          tags,
	}
}

func inferExpectations(conv dbConversation, bundle turnBundle, idx int) Expectations {
	text := strings.ToLower(normalizeWhitespace(bundle.UserText))
	correction := isCorrectionTurn(text, idx)
	clarify := shouldAskClarifying(text, idx)
	expect := Expectations{
		PrimaryIntent:             inferPrimaryIntent(text, idx),
		ShouldPatch:               shouldPatch(text, idx),
		MustInspectBeforePatching: shouldPatch(text, idx),
		MustNotPatchThisTurn:      isAnalysisOnly(text),
		ShouldAskClarifying:       clarify,
		ShouldCheckGitStatus:      needsGitStatus(text, conv.Title),
		RequireContractReset:      correction,
		PrioritizeNamedArtifacts:  mentionsConcreteArtifact(text, conv.Title),
		PrioritizeSourceOfTruth:   needsSourceOfTruthInspection(text, bundle.NextUserMessage),
		AvoidUpdatePlan:           shouldAvoidUpdatePlan(text),
		AvoidRequestUserInput:     !clarify,
		PreferStructuredTools:     !needsGitStatus(text, conv.Title) && !requiresVerificationCommand(text),
	}

	if expect.MustNotPatchThisTurn {
		expect.ShouldPatch = false
		expect.MustInspectBeforePatching = false
	}

	switch {
	case expect.ShouldCheckGitStatus:
		expect.PreferredFirstTools = []string{"exec_command"}
		expect.QualitySignals = append(expect.QualitySignals, "Start with git status or git diff before answering.")
	case expect.MustNotPatchThisTurn:
		expect.ForbiddenTools = append(expect.ForbiddenTools, "apply_patch")
		expect.ForbiddenFirstTools = append(expect.ForbiddenFirstTools, "apply_patch", "update_plan")
		expect.QualitySignals = append(expect.QualitySignals, "Do not patch when the user asked for explanation or suggestions only.")
	case expect.ShouldPatch:
		expect.ForbiddenFirstTools = append(expect.ForbiddenFirstTools, "apply_patch")
		if expect.PreferStructuredTools {
			expect.PreferredFirstTools = []string{"read_file", "grep_files", "list_dir", "parallel_tool_use"}
			expect.ForbiddenFirstTools = append(expect.ForbiddenFirstTools, "exec_command")
			expect.QualitySignals = append(expect.QualitySignals, "Inspect relevant files or symbols before patching.")
		} else if requiresVerificationCommand(text) {
			expect.PreferredFirstTools = []string{"exec_command"}
		}
	}

	if expect.RequireContractReset {
		expect.QualitySignals = append(expect.QualitySignals, "Treat the user correction as a contract reset and inspect the failed area again.")
	}
	if expect.PrioritizeNamedArtifacts {
		expect.QualitySignals = append(expect.QualitySignals, "Inspect the named artifact or component before broad repo scans.")
	}
	if expect.PrioritizeSourceOfTruth {
		expect.QualitySignals = append(expect.QualitySignals, "Trace the source-of-truth layer instead of patching only the leaf UI component.")
	}
	if expect.AvoidUpdatePlan {
		expect.ForbiddenFirstTools = append(expect.ForbiddenFirstTools, "update_plan")
	}
	if expect.AvoidRequestUserInput {
		expect.ForbiddenFirstTools = append(expect.ForbiddenFirstTools, "request_user_input")
	}

	expect.ForbiddenFirstTools = dedupe(expect.ForbiddenFirstTools)
	expect.ForbiddenTools = dedupe(expect.ForbiddenTools)
	expect.PreferredFirstTools = dedupe(expect.PreferredFirstTools)
	expect.QualitySignals = dedupe(expect.QualitySignals)
	return expect
}

func inferPrimaryIntent(text string, idx int) string {
	switch {
	case isCorrectionTurn(text, idx) && !isAnalysisOnly(text):
		return "patch"
	case isAnalysisOnly(text):
		return "explain"
	case requiresVerificationCommand(text):
		return "verify"
	case strings.Contains(text, "what changes do i need") || strings.Contains(text, "how much effort") || strings.Contains(text, "what potential fixes"):
		return "investigate"
	case shouldAskClarifying(text, idx):
		return "clarify"
	default:
		return "patch"
	}
}

func shouldPatch(text string, idx int) bool {
	if isCorrectionTurn(text, idx) && !isAnalysisOnly(text) {
		return true
	}
	if isAnalysisOnly(text) {
		return false
	}
	if strings.Contains(text, "what changes do i need") || strings.Contains(text, "how much effort") {
		return false
	}
	return strings.Contains(text, "fix") ||
		strings.Contains(text, "add ") ||
		strings.Contains(text, "implement") ||
		strings.Contains(text, "update ") ||
		strings.Contains(text, "redesign") ||
		strings.Contains(text, "make ") ||
		strings.Contains(text, "remove") ||
		strings.Contains(text, "change ")
}

func isAnalysisOnly(text string) bool {
	return strings.Contains(text, "explain") ||
		strings.Contains(text, "summarize") ||
		strings.Contains(text, "what changed") ||
		strings.Contains(text, "what are potential fixes") ||
		strings.Contains(text, "don't make any changes") ||
		strings.Contains(text, "suggestions for now") ||
		strings.Contains(text, "how much effort") ||
		strings.Contains(text, "what changes do i need")
}

func needsGitStatus(text, title string) bool {
	s := strings.ToLower(title + " " + text)
	return strings.Contains(s, "uncommited changes") ||
		strings.Contains(s, "uncommitted changes") ||
		strings.Contains(s, "latest changes") ||
		strings.Contains(s, "recent changes") ||
		strings.Contains(s, "git diff") ||
		strings.Contains(s, "git status")
}

func shouldAskClarifying(text string, idx int) bool {
	short := len(strings.Fields(text)) < 6
	if idx == 0 && short && !strings.Contains(text, "fix this ui issue") {
		return true
	}
	return strings.Contains(text, "not sure") || strings.Contains(text, "if needed tell me")
}

func requiresVerificationCommand(text string) bool {
	return strings.Contains(text, "run eslint") ||
		strings.Contains(text, "run tests") ||
		strings.Contains(text, "ensure everything is okay") ||
		strings.Contains(text, "profile")
}

func isCorrectionTurn(text string, idx int) bool {
	if idx == 0 {
		return false
	}
	return strings.Contains(text, "did not work") ||
		strings.Contains(text, "still not fixed") ||
		strings.Contains(text, "something is wrong") ||
		strings.Contains(text, "try again") ||
		strings.Contains(text, "please try again") ||
		strings.Contains(text, "please continue") ||
		strings.Contains(text, "try now") ||
		strings.Contains(text, "you screwed up") ||
		strings.Contains(text, "this is bad") ||
		strings.Contains(text, "not quite") ||
		strings.Contains(text, "why ?") ||
		strings.Contains(text, "why?") ||
		strings.Contains(text, "fundamentally wrong") ||
		strings.Contains(text, "your implemenation sucks")
}

func mentionsConcreteArtifact(text, title string) bool {
	s := title + " " + text
	return artifactRegexp.MatchString(s) ||
		strings.Contains(strings.ToLower(s), "screenshot") ||
		strings.Contains(strings.ToLower(s), "loop.db") ||
		strings.Contains(strings.ToLower(s), "timeline") ||
		strings.Contains(strings.ToLower(s), "sidebar") ||
		strings.Contains(strings.ToLower(s), "patch viewer") ||
		strings.Contains(strings.ToLower(s), "activity viewer") ||
		strings.Contains(strings.ToLower(s), "composer")
}

func needsSourceOfTruthInspection(text, nextUser string) bool {
	s := strings.ToLower(text + " " + nextUser)
	keywords := []string{
		"timeline", "group", "store", "persist", "pagination", "loading", "scroll", "event", "conversation", "running thread", "source of truth",
		"switch conversations", "rendering", "history", "stream",
	}
	for _, keyword := range keywords {
		if strings.Contains(s, keyword) {
			return true
		}
	}
	return false
}

func shouldAvoidUpdatePlan(text string) bool {
	return isAnalysisOnly(text) || len(strings.Fields(text)) < 35
}

func conversationPhase(idx int, text string) string {
	if idx == 0 {
		return "initial_request"
	}
	if isCorrectionTurn(strings.ToLower(text), idx) {
		return "correction"
	}
	return "follow_up"
}

func deriveFailureTraits(bundle turnBundle, original OriginalRun) []string {
	var traits []string
	if original.ToolCounts["exec_command"] >= 5 {
		traits = append(traits, "exec_command_heavy")
	}
	if original.ApprovalRequests > 0 {
		traits = append(traits, "approval_heavy")
	}
	if original.UserExpressedDissatis > 0 {
		traits = append(traits, "user_corrected_after_attempt")
	}
	if original.Errors > 0 {
		traits = append(traits, "tool_or_turn_errors")
	}
	if isCorrectionTurn(strings.ToLower(bundle.UserText), 1) {
		traits = append(traits, "contract_reset_required")
	}
	return dedupe(traits)
}

func deriveTags(expect Expectations, artifacts []string, bundle turnBundle, original OriginalRun) []string {
	var tags []string
	tags = append(tags, expect.PrimaryIntent)
	tags = append(tags, bundleTag(expect))
	if expect.RequireContractReset {
		tags = append(tags, "correction")
	}
	if expect.PrioritizeSourceOfTruth {
		tags = append(tags, "source_of_truth")
	}
	if expect.ShouldCheckGitStatus {
		tags = append(tags, "git_state")
	}
	if expect.PreferStructuredTools {
		tags = append(tags, "structured_tools")
	}
	if expect.PrioritizeNamedArtifacts || len(artifacts) > 0 {
		tags = append(tags, "named_artifact")
	}
	if original.ApprovalRequests > 0 {
		tags = append(tags, "approval_risk")
	}
	return dedupe(tags)
}

func bundleTag(expect Expectations) string {
	switch {
	case expect.MustNotPatchThisTurn:
		return "analysis_only"
	case expect.ShouldPatch:
		return "patch_required"
	case expect.ShouldAskClarifying:
		return "clarify"
	default:
		return "investigate"
	}
}

func dissatisfactionScore(text string) int {
	s := strings.ToLower(normalizeWhitespace(text))
	score := 0
	for _, token := range []string{
		"did not work", "still not fixed", "not quite", "something is wrong", "you screwed up", "fundamentally wrong",
		"issue", "sucks", "why", "wrong",
	} {
		if strings.Contains(s, token) {
			score++
		}
	}
	return score
}

var artifactRegexp = regexp.MustCompile(`([A-Za-z0-9_./-]+\.(go|ts|tsx|js|jsx|json|md|sql|db))|([A-Z][A-Za-z0-9]+(?:Store|Viewer|Feed|Composer|Sidebar|Handler|Client|Tool))`)

func extractArtifacts(input string) []string {
	matches := artifactRegexp.FindAllString(input, -1)
	return dedupe(matches)
}

func extractText(partsJSON string) string {
	var parts []models.MessagePart
	if err := json.Unmarshal([]byte(partsJSON), &parts); err != nil {
		return ""
	}
	var sb strings.Builder
	for _, part := range parts {
		if part.Kind == models.PartText && part.Text != nil {
			sb.WriteString(part.Text.Text)
			sb.WriteString(" ")
		}
	}
	return normalizeWhitespace(sb.String())
}

func truncateText(s string, max int) string {
	if max <= 0 || len(s) <= max {
		return s
	}
	return strings.TrimSpace(s[:max]) + "..."
}

func normalizeWhitespace(s string) string {
	return strings.Join(strings.Fields(strings.TrimSpace(s)), " ")
}

func dedupe(items []string) []string {
	seen := make(map[string]struct{}, len(items))
	out := make([]string, 0, len(items))
	for _, item := range items {
		trimmed := strings.TrimSpace(item)
		if trimmed == "" {
			continue
		}
		if _, ok := seen[trimmed]; ok {
			continue
		}
		seen[trimmed] = struct{}{}
		out = append(out, trimmed)
	}
	return out
}
