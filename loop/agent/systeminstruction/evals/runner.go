package evals

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"google.golang.org/genai"

	"loop/agent"
	"loop/agent/systeminstruction"
	agenttools "loop/agent/tools"
	"loop/models"
	"loop/store"
)

const judgePrompt = `You are grading the first next-turn response of a coding agent.

You will receive:
- the reconstructed user-turn case
- explicit expectations
- the candidate agent's first response (text and/or function calls)

Score each axis from 0 to 5.

Rubric:
- intent_routing: Did it choose explain vs inspect vs patch vs verify vs clarify correctly?
- context_building: Did it target the right artifact/layer first and gather relevant context?
- tool_discipline: Did it avoid bad tool choices, especially shell-first behavior when structured tools fit?
- correction_handling: For correction turns, did it reset the approach instead of defending or repeating?
- turn_efficiency: Was the response concise and proportionate for the step?

Strong negatives:
- apply_patch in the first response for a patch/debug task
- patching or planning during analysis-only tasks
- broad shell exploration when read/search tools fit
- ignoring a named artifact or obvious source-of-truth hint
- using request_user_input when the case is actionable without clarification

Return JSON only with fields:
intent_routing, context_building, tool_discipline, correction_handling, turn_efficiency, strengths, weaknesses, notes`

const (
	modelCallAttempts = 3
	modelCallDelay    = 2 * time.Second
	perCaseTimeout    = 180 * time.Second
)

type RunOptions struct {
	SuitePath   string
	Variant     string
	Model       string
	JudgeModel  string
	CaseLimit   int
	CaseOffset  int
	Parallelism int
}

func RunSuite(ctx context.Context, opts RunOptions) (*RunResult, error) {
	suite, err := LoadSuite(opts.SuitePath)
	if err != nil {
		return nil, err
	}

	prompt, err := systeminstruction.GetVariant(opts.Variant)
	if err != nil {
		return nil, err
	}

	apiKey := strings.TrimSpace(os.Getenv("GEMINI_API_KEY"))
	if apiKey == "" {
		return nil, fmt.Errorf("GEMINI_API_KEY is required")
	}

	client, err := genai.NewClient(ctx, &genai.ClientConfig{
		APIKey:  apiKey,
		Backend: genai.BackendGeminiAPI,
	})
	if err != nil {
		return nil, fmt.Errorf("create genai client: %w", err)
	}

	cases := sliceCases(suite.Cases, opts.CaseOffset, opts.CaseLimit)
	toolDecls := buildEvalToolDeclarations(suite.Source.WorkspaceRoot)

	result := &RunResult{
		SuitePath:   opts.SuitePath,
		Variant:     opts.Variant,
		Model:       opts.Model,
		JudgeModel:  opts.JudgeModel,
		GeneratedAt: time.Now().UTC(),
		CaseCount:   len(cases),
	}

	scoredCases, err := runCases(ctx, client, opts, prompt, toolDecls, cases)
	if err != nil {
		return nil, err
	}
	result.Cases = scoredCases

	result.Summary = summarizeRun(result.Cases)
	result.CategoryScores = summarizeByTag(result.Cases, cases)
	return result, nil
}

func LoadSuite(path string) (*Suite, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read suite %s: %w", path, err)
	}
	var suite Suite
	if err := json.Unmarshal(raw, &suite); err != nil {
		return nil, fmt.Errorf("parse suite %s: %w", path, err)
	}
	return &suite, nil
}

func SaveJSON(path string, value any) error {
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o644)
}

func runCase(ctx context.Context, client *genai.Client, opts RunOptions, prompt string, toolDecls []*genai.Tool, testCase Case) (ScoredCase, error) {
	inputText := renderCasePrompt(testCase)
	config := &genai.GenerateContentConfig{
		SystemInstruction: &genai.Content{
			Parts: []*genai.Part{genai.NewPartFromText(prompt)},
		},
		Tools:       toolDecls,
		Temperature: genai.Ptr(float32(0)),
		ThinkingConfig: &genai.ThinkingConfig{
			IncludeThoughts: false,
			ThinkingLevel:   genai.ThinkingLevelMedium,
		},
	}

	response, err := generateContentWithRetry(
		ctx,
		client,
		opts.Model,
		[]*genai.Content{{Role: "user", Parts: []*genai.Part{genai.NewPartFromText(inputText)}}},
		config,
	)
	if err != nil {
		return ScoredCase{}, fmt.Errorf("candidate model call: %w", err)
	}

	scored := ScoredCase{
		CaseID:        testCase.ID,
		PromptedInput: inputText,
		Usage:         usageToMap(response.UsageMetadata),
	}

	if len(response.Candidates) == 0 || response.Candidates[0].Content == nil {
		return scored, fmt.Errorf("empty candidate response")
	}

	scored.CandidateText, scored.CandidateToolCalls = parseCandidateOutput(response.Candidates[0].Content)
	scored.DeterministicFindings = deterministicFindings(testCase, scored.CandidateToolCalls)

	judge, err := judgeCase(ctx, client, opts.JudgeModel, testCase, scored)
	if err != nil {
		return scored, fmt.Errorf("judge model call: %w", err)
	}
	scored.Judge = judge
	scored.FinalScore = applyDeterministicPenalties(judge, scored.DeterministicFindings)
	scored.Passed = scored.FinalScore >= 70
	return scored, nil
}

func runCases(ctx context.Context, client *genai.Client, opts RunOptions, prompt string, toolDecls []*genai.Tool, cases []Case) ([]ScoredCase, error) {
	if len(cases) == 0 {
		return nil, nil
	}

	parallelism := opts.Parallelism
	if parallelism <= 1 || len(cases) == 1 {
		results := make([]ScoredCase, len(cases))
		for i, testCase := range cases {
			scored, err := runCase(ctx, client, opts, prompt, toolDecls, testCase)
			if err != nil {
				return nil, fmt.Errorf("run case %s: %w", testCase.ID, err)
			}
			results[i] = scored
		}
		return results, nil
	}

	type caseJob struct {
		index int
		c     Case
	}
	type caseResult struct {
		index  int
		scored ScoredCase
	}

	jobs := make(chan caseJob)
	results := make(chan caseResult, len(cases))

	var wg sync.WaitGroup
	for i := 0; i < parallelism; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for job := range jobs {
				caseCtx, cancel := context.WithTimeout(ctx, perCaseTimeout)
				scored, err := runCase(caseCtx, client, opts, prompt, toolDecls, job.c)
				cancel()
				if err != nil {
					scored = ScoredCase{
						CaseID:                job.c.ID,
						PromptedInput:         renderCasePrompt(job.c),
						DeterministicFindings: []string{"run_error"},
						Judge: JudgeResult{
							Notes: fmt.Sprintf("run case %s: %v", job.c.ID, err),
						},
						FinalScore: 0,
						Passed:     false,
					}
				}
				results <- caseResult{index: job.index, scored: scored}
			}
		}()
	}

	go func() {
		for i, testCase := range cases {
			jobs <- caseJob{index: i, c: testCase}
		}
		close(jobs)
		wg.Wait()
		close(results)
	}()

	scoredCases := make([]ScoredCase, len(cases))
	completed := 0
	for result := range results {
		scoredCases[result.index] = result.scored
		completed++
		if completed == len(cases) || completed%10 == 0 {
			log.Printf("prompt_eval: scored %d/%d cases", completed, len(cases))
		}
	}
	return scoredCases, nil
}

func renderCasePrompt(testCase Case) string {
	var sb strings.Builder
	sb.WriteString("You are the coding agent for the next assistant turn.\n")
	sb.WriteString("Workspace root: ")
	sb.WriteString(testCase.Input.WorkspaceRoot)
	sb.WriteString("\nConversation title: ")
	sb.WriteString(testCase.Input.ConversationTitle)
	sb.WriteString("\nConversation phase: ")
	sb.WriteString(testCase.Input.ConversationPhase)
	sb.WriteString("\n")
	if testCase.Input.OriginalFirstQuery != "" {
		sb.WriteString("Original user request: ")
		sb.WriteString(testCase.Input.OriginalFirstQuery)
		sb.WriteString("\n")
	}
	if len(testCase.Input.PriorTurns) > 0 {
		sb.WriteString("Prior turns:\n")
		for i, turn := range testCase.Input.PriorTurns {
			sb.WriteString(fmt.Sprintf("%d. User: %s\n", i+1, turn.UserText))
			if len(turn.AssistantToolCounts) > 0 {
				sb.WriteString("   Assistant tools: ")
				sb.WriteString(renderToolCounts(turn.AssistantToolCounts))
				sb.WriteString("\n")
			}
			if len(turn.AssistantFirstTools) > 0 {
				sb.WriteString("   Assistant started with: ")
				sb.WriteString(strings.Join(turn.AssistantFirstTools, ", "))
				sb.WriteString("\n")
			}
			if turn.AssistantFinalText != "" {
				sb.WriteString("   Assistant claimed: ")
				sb.WriteString(turn.AssistantFinalText)
				sb.WriteString("\n")
			}
			if turn.ApprovalRequests > 0 || turn.Errors > 0 {
				sb.WriteString(fmt.Sprintf("   Turn friction: approvals=%d errors=%d\n", turn.ApprovalRequests, turn.Errors))
			}
		}
	}
	if len(testCase.Input.NamedArtifacts) > 0 {
		sb.WriteString("Named artifacts or components: ")
		sb.WriteString(strings.Join(testCase.Input.NamedArtifacts, ", "))
		sb.WriteString("\n")
	}
	sb.WriteString("Current user message: ")
	sb.WriteString(testCase.Input.LatestUserMessage)
	sb.WriteString("\nRespond with the next assistant turn only. Use tools when appropriate.")
	return sb.String()
}

func judgeCase(ctx context.Context, client *genai.Client, model string, testCase Case, scored ScoredCase) (JudgeResult, error) {
	payload := map[string]any{
		"case":          testCase,
		"candidate":     map[string]any{"text": scored.CandidateText, "tool_calls": scored.CandidateToolCalls},
		"deterministic": scored.DeterministicFindings,
	}
	rawPayload, _ := json.MarshalIndent(payload, "", "  ")
	result, err := generateContentWithRetry(
		ctx,
		client,
		model,
		[]*genai.Content{{Role: "user", Parts: []*genai.Part{genai.NewPartFromText(string(rawPayload))}}},
		&genai.GenerateContentConfig{
			SystemInstruction: &genai.Content{
				Parts: []*genai.Part{genai.NewPartFromText(judgePrompt)},
			},
			Temperature: genai.Ptr(float32(0)),
		},
	)
	if err != nil {
		return JudgeResult{}, err
	}
	if len(result.Candidates) == 0 || result.Candidates[0].Content == nil {
		return JudgeResult{}, fmt.Errorf("empty judge response")
	}
	text, _ := parseCandidateOutput(result.Candidates[0].Content)
	judgeText := extractJSON(text)
	judge, err := parseJudgeResult(judgeText)
	if err != nil {
		return JudgeResult{}, fmt.Errorf("parse judge json: %w; raw=%s", err, text)
	}
	return judge, nil
}

func parseCandidateOutput(content *genai.Content) (string, []ToolCallSnapshot) {
	var textParts []string
	var toolCalls []ToolCallSnapshot
	for _, part := range content.Parts {
		if part == nil {
			continue
		}
		if strings.TrimSpace(part.Text) != "" {
			textParts = append(textParts, strings.TrimSpace(part.Text))
		}
		if part.FunctionCall != nil {
			args := map[string]any{}
			if part.FunctionCall.Args != nil {
				args = part.FunctionCall.Args
			}
			toolCalls = append(toolCalls, ToolCallSnapshot{
				Name: part.FunctionCall.Name,
				Args: args,
			})
		}
	}
	return strings.Join(textParts, "\n"), toolCalls
}

func deterministicFindings(testCase Case, toolCalls []ToolCallSnapshot) []string {
	var findings []string
	if len(toolCalls) == 0 {
		if testCase.Expectations.ShouldPatch && !testCase.Expectations.ShouldAskClarifying && !testCase.Expectations.MustNotPatchThisTurn {
			findings = append(findings, "no_inspection_tools_for_patch_request")
		}
		return findings
	}

	firstTool := toolCalls[0].Name
	if contains(testCase.Expectations.ForbiddenFirstTools, firstTool) {
		findings = append(findings, "forbidden_first_tool:"+firstTool)
	}
	if contains(testCase.Expectations.ForbiddenTools, firstTool) {
		findings = append(findings, "forbidden_tool:"+firstTool)
	}
	if testCase.Expectations.MustNotPatchThisTurn && anyToolNamed(toolCalls, "apply_patch") {
		findings = append(findings, "patched_during_analysis_only_task")
	}
	if testCase.Expectations.MustInspectBeforePatching && firstTool == "apply_patch" {
		findings = append(findings, "patched_before_inspection")
	}
	if testCase.Expectations.AvoidUpdatePlan && anyToolNamed(toolCalls, "update_plan") {
		findings = append(findings, "unnecessary_update_plan")
	}
	if testCase.Expectations.AvoidRequestUserInput && anyToolNamed(toolCalls, "request_user_input") {
		findings = append(findings, "unnecessary_request_user_input")
	}
	if testCase.Expectations.PreferStructuredTools && firstTool == "exec_command" {
		findings = append(findings, "shell_first_when_structured_tools_fit")
	}
	if testCase.Expectations.ShouldCheckGitStatus && firstTool != "exec_command" {
		findings = append(findings, "did_not_start_with_git_state_inspection")
	}
	return findings
}

func applyDeterministicPenalties(judge JudgeResult, findings []string) float64 {
	base := float64(judge.IntentRouting+judge.ContextBuilding+judge.ToolDiscipline+judge.CorrectionHandling+judge.TurnEfficiency) / 25.0 * 100.0
	for _, finding := range findings {
		switch {
		case strings.Contains(finding, "patched_before_inspection"):
			base -= 25
		case strings.Contains(finding, "patched_during_analysis_only_task"):
			base -= 25
		case strings.Contains(finding, "forbidden_first_tool"):
			base -= 20
		case strings.Contains(finding, "shell_first_when_structured_tools_fit"):
			base -= 12
		case strings.Contains(finding, "did_not_start_with_git_state_inspection"):
			base -= 12
		case strings.Contains(finding, "unnecessary_update_plan"), strings.Contains(finding, "unnecessary_request_user_input"):
			base -= 10
		case strings.Contains(finding, "no_inspection_tools_for_patch_request"):
			base -= 15
		default:
			base -= 6
		}
	}
	if base < 0 {
		base = 0
	}
	return base
}

func summarizeRun(scored []ScoredCase) RunSummary {
	if len(scored) == 0 {
		return RunSummary{}
	}
	var summary RunSummary
	for _, item := range scored {
		summary.AverageScore += item.FinalScore
		summary.AverageIntentRouting += float64(item.Judge.IntentRouting)
		summary.AverageContextBuilding += float64(item.Judge.ContextBuilding)
		summary.AverageToolDiscipline += float64(item.Judge.ToolDiscipline)
		summary.AverageCorrectionHandling += float64(item.Judge.CorrectionHandling)
		summary.AverageTurnEfficiency += float64(item.Judge.TurnEfficiency)
		if item.Passed {
			summary.PassRate++
		}
		if len(item.DeterministicFindings) > 0 {
			summary.DeterministicPenaltyEvents++
		}
	}
	n := float64(len(scored))
	summary.AverageScore /= n
	summary.AverageIntentRouting /= n
	summary.AverageContextBuilding /= n
	summary.AverageToolDiscipline /= n
	summary.AverageCorrectionHandling /= n
	summary.AverageTurnEfficiency /= n
	summary.PassRate = (summary.PassRate / n) * 100
	return summary
}

func summarizeByTag(scored []ScoredCase, cases []Case) []CategoryScore {
	scoreByTag := map[string]struct {
		total float64
		count int
	}{}
	for i, item := range scored {
		if i >= len(cases) {
			break
		}
		for _, tag := range cases[i].Tags {
			entry := scoreByTag[tag]
			entry.total += item.FinalScore
			entry.count++
			scoreByTag[tag] = entry
		}
	}
	var out []CategoryScore
	for tag, entry := range scoreByTag {
		out = append(out, CategoryScore{
			Tag:          tag,
			AverageScore: entry.total / float64(entry.count),
			Count:        entry.count,
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].AverageScore < out[j].AverageScore })
	return out
}

func renderToolCounts(counts map[string]int) string {
	if len(counts) == 0 {
		return ""
	}
	keys := make([]string, 0, len(counts))
	for key := range counts {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys))
	for _, key := range keys {
		parts = append(parts, fmt.Sprintf("%s x%d", key, counts[key]))
	}
	return strings.Join(parts, ", ")
}

func buildEvalToolDeclarations(workspaceRoot string) []*genai.Tool {
	ws := &models.Workspace{
		ID:       models.WorkspaceID("eval-workspace"),
		Name:     "eval",
		RootPath: workspaceRoot,
	}
	pm := agenttools.NewProcessManager()
	baseTools := []*agent.ToolDef{
		agenttools.NewExecCommandTool(pm, ws),
		agenttools.NewWriteStdinTool(pm),
		agenttools.NewApplyPatchTool(ws),
		agenttools.NewReadFileTool(ws),
		agenttools.NewListDirTool(ws),
		agenttools.NewGrepFilesTool(ws),
		agenttools.NewUpdatePlanTool(),
		agenttools.NewRequestUserInputTool(),
	}
	baseTools = append(baseTools, agenttools.NewParallelToolUseTool(func() []*agent.ToolDef { return baseTools }))

	var dummyStore store.Store
	agentTools := append(baseTools,
		agenttools.NewSpawnThreadTool(dummyStore, nil, ws, &models.Conversation{
			ID:          models.ConversationID("eval-conversation"),
			WorkspaceID: ws.ID,
		}, baseTools, 0),
		agenttools.NewAwaitThreadTool(dummyStore),
	)

	return agent.BuildToolsForModel(agentTools)
}

func usageToMap(meta *genai.GenerateContentResponseUsageMetadata) map[string]int32 {
	if meta == nil {
		return nil
	}
	return map[string]int32{
		"prompt_tokens":     meta.PromptTokenCount,
		"candidate_tokens":  meta.CandidatesTokenCount,
		"total_token_count": meta.TotalTokenCount,
	}
}

func sliceCases(cases []Case, offset, limit int) []Case {
	if offset < 0 {
		offset = 0
	}
	if offset >= len(cases) {
		return nil
	}
	trimmed := cases[offset:]
	if limit > 0 && limit < len(trimmed) {
		return trimmed[:limit]
	}
	return trimmed
}

func anyToolNamed(calls []ToolCallSnapshot, name string) bool {
	for _, call := range calls {
		if call.Name == name {
			return true
		}
	}
	return false
}

func contains(items []string, target string) bool {
	for _, item := range items {
		if item == target {
			return true
		}
	}
	return false
}

func extractJSON(text string) string {
	start := strings.Index(text, "{")
	end := strings.LastIndex(text, "}")
	if start >= 0 && end >= start {
		return text[start : end+1]
	}
	return text
}

func generateContentWithRetry(ctx context.Context, client *genai.Client, model string, contents []*genai.Content, config *genai.GenerateContentConfig) (*genai.GenerateContentResponse, error) {
	var lastErr error
	for attempt := 1; attempt <= modelCallAttempts; attempt++ {
		resp, err := client.Models.GenerateContent(ctx, model, contents, config)
		if err == nil {
			return resp, nil
		}
		lastErr = err
		if attempt == modelCallAttempts || ctx.Err() != nil {
			break
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(time.Duration(attempt) * modelCallDelay):
		}
	}
	return nil, lastErr
}

func parseJudgeResult(raw string) (JudgeResult, error) {
	var parsed map[string]any
	if err := json.Unmarshal([]byte(raw), &parsed); err != nil {
		return JudgeResult{}, err
	}

	judge := JudgeResult{
		IntentRouting:      intValue(parsed["intent_routing"]),
		ContextBuilding:    intValue(parsed["context_building"]),
		ToolDiscipline:     intValue(parsed["tool_discipline"]),
		CorrectionHandling: intValue(parsed["correction_handling"]),
		TurnEfficiency:     intValue(parsed["turn_efficiency"]),
		Strengths:          stringSliceValue(parsed["strengths"]),
		Weaknesses:         stringSliceValue(parsed["weaknesses"]),
		Notes:              stringValue(parsed["notes"]),
	}

	return judge, nil
}

func intValue(v any) int {
	switch n := v.(type) {
	case float64:
		return int(n)
	case int:
		return n
	default:
		return 0
	}
}

func stringSliceValue(v any) []string {
	switch value := v.(type) {
	case []any:
		out := make([]string, 0, len(value))
		for _, item := range value {
			text := stringValue(item)
			if text != "" {
				out = append(out, text)
			}
		}
		return out
	case string:
		if strings.TrimSpace(value) == "" {
			return nil
		}
		return []string{strings.TrimSpace(value)}
	default:
		return nil
	}
}

func stringValue(v any) string {
	if text, ok := v.(string); ok {
		return strings.TrimSpace(text)
	}
	return ""
}
