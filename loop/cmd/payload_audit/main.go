package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"flag"
	"fmt"
	"html/template"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/joho/godotenv"
	_ "github.com/mattn/go-sqlite3"
	"google.golang.org/genai"
	"google.golang.org/genai/tokenizer"

	"loop/agent"
	"loop/agent/systeminstruction"
	"loop/agent/systeminstruction/evals"
	agenttools "loop/agent/tools"
	"loop/models"
)

type conversationRow struct {
	ID               string
	Title            string
	WorkspaceID      string
	SystemPromptID   string
	SystemPromptName string
	WorktreePath     string
}

type workspaceRow struct {
	ID                string
	Name              string
	RootPath          string
	CanonicalRootPath string
}

type messageRow struct {
	ID             string
	Seq            int64
	SentBy         string
	PartsJSON      string
	MetadataJSON   string
	CreatedAt      string
	Parts          []models.MessagePart
	Metadata       map[string]any
	ModelBytes     int
	ModelPartKinds []string
	ToolName       string
	OutputChars    int
}

type callCurvePoint struct {
	MessageSeq int64 `json:"message_seq"`
	Iteration  int   `json:"iteration"`
	Input      int   `json:"input"`
	Output     int   `json:"output"`
	Cached     int   `json:"cached"`
	Uncached   int   `json:"uncached"`
}

type offender struct {
	Seq         int64  `json:"seq"`
	SentBy      string `json:"sent_by"`
	ToolName    string `json:"tool_name,omitempty"`
	ModelBytes  int    `json:"model_bytes"`
	OutputChars int    `json:"output_chars,omitempty"`
	PartKinds   string `json:"part_kinds"`
}

type fixedOverhead struct {
	Base          int32 `json:"base"`
	SystemOnly    int32 `json:"system_only"`
	ToolsOnly     int32 `json:"tools_only"`
	SystemAndTool int32 `json:"system_and_tool"`
}

type tokenVariant struct {
	LoggedInput  int   `json:"logged_input"`
	LoggedCached int   `json:"logged_cached"`
	LoggedUncach int   `json:"logged_uncached"`
	APIFull      int32 `json:"api_full"`
	APINoTools   int32 `json:"api_no_tool_messages"`
	APIHarness   int32 `json:"api_harness"`
}

type turnReport struct {
	UserTurnIndex     int          `json:"user_turn_index"`
	UserMessageID     string       `json:"user_message_id"`
	UserMessageSeq    int64        `json:"user_message_seq"`
	InitialAgentSeq   int64        `json:"initial_agent_seq"`
	Model             string       `json:"model"`
	ThinkingLevel     string       `json:"thinking_level"`
	UserText          string       `json:"user_text"`
	HistoryCount      int          `json:"history_count"`
	HistoryUserCount  int          `json:"history_user_count"`
	HistoryAgentCount int          `json:"history_agent_count"`
	HistoryToolCount  int          `json:"history_tool_count"`
	HistoryBytes      int          `json:"history_model_bytes"`
	Tokens            tokenVariant `json:"tokens"`
	SavingsNoToolsPct float64      `json:"savings_no_tool_messages_pct"`
	SavingsHarnessPct float64      `json:"savings_harness_pct"`
	TopOffenders      []offender   `json:"top_offenders"`
	PayloadFile       string       `json:"payload_file"`
	HarnessPayload    string       `json:"harness_payload_file"`
}

type report struct {
	GeneratedAt         string           `json:"generated_at"`
	ConversationID      string           `json:"conversation_id"`
	ConversationTitle   string           `json:"conversation_title"`
	WorkspaceRoot       string           `json:"workspace_root"`
	SystemPromptID      string           `json:"system_prompt_id"`
	SystemPromptName    string           `json:"system_prompt_name"`
	SystemPromptChars   int              `json:"system_prompt_chars"`
	ToolCount           int              `json:"tool_count"`
	Fixed               fixedOverhead    `json:"fixed_overhead"`
	UserTurnCount       int              `json:"user_turn_count"`
	ModelCallCount      int              `json:"model_call_count"`
	MaxInputTokens      int              `json:"max_input_tokens"`
	MaxCachedTokens     int              `json:"max_cached_tokens"`
	MaxUncachedTokens   int              `json:"max_uncached_tokens"`
	Curve               []callCurvePoint `json:"curve"`
	Turns               []turnReport     `json:"turns"`
	GlobalTopOffenders  []offender       `json:"global_top_offenders"`
	WrongThings         []string         `json:"wrong_things"`
	CorrectThings       []string         `json:"correct_things"`
	OptimizationActions []string         `json:"optimization_actions"`
	Sources             []sourceLink     `json:"sources"`
}

type sourceLink struct {
	Label string `json:"label"`
	URL   string `json:"url"`
}

type harnessCase struct {
	UserMessageID string
	Prompt        string
}

func main() {
	var (
		dbPath         = flag.String("db", "loop.db", "path to loop db")
		conversationID = flag.String("conversation", "", "conversation id")
		outDir         = flag.String("out", "../tmp/payload-audit", "output directory")
	)
	flag.Parse()

	if strings.TrimSpace(*conversationID) == "" {
		log.Fatal("-conversation is required")
	}

	_ = godotenv.Load(".env")
	apiKey := strings.TrimSpace(os.Getenv("GEMINI_API_KEY"))
	if apiKey == "" {
		log.Fatal("GEMINI_API_KEY is required")
	}

	ctx := context.Background()
	client, err := genai.NewClient(ctx, &genai.ClientConfig{
		APIKey:  apiKey,
		Backend: genai.BackendGeminiAPI,
	})
	if err != nil {
		log.Fatalf("create genai client: %v", err)
	}

	conv, ws, messages, err := loadConversation(*dbPath, *conversationID)
	if err != nil {
		log.Fatal(err)
	}

	if conv.WorktreePath != "" {
		ws.RootPath = conv.WorktreePath
		ws.CanonicalRootPath = conv.WorktreePath
	}

	systemPrompt := systeminstruction.Get()
	if strings.TrimSpace(conv.SystemPromptID) == "" || strings.TrimSpace(conv.SystemPromptName) == "" {
		variant := systeminstruction.DefaultVariant()
		if strings.TrimSpace(conv.SystemPromptID) == "" {
			conv.SystemPromptID = variant.ID
		}
		if strings.TrimSpace(conv.SystemPromptName) == "" {
			conv.SystemPromptName = variant.Name
		}
	}

	toolDefs := buildToolDefs(ws, conv)
	modelTools := agent.BuildToolsForModel(toolDefs)
	fixed, err := measureFixedOverhead(agent.DefaultModel, systemPrompt, modelTools)
	if err != nil {
		log.Fatalf("measure fixed overhead: %v", err)
	}

	harnessCases, err := buildHarnessCases(*dbPath, *conversationID)
	if err != nil {
		log.Fatalf("build harness cases: %v", err)
	}

	if err := os.MkdirAll(*outDir, 0o755); err != nil {
		log.Fatalf("mkdir %s: %v", *outDir, err)
	}

	curve := buildCurve(messages)
	maxInput, maxCached, maxUncached := maxCurve(curve)

	payloadDir := filepath.Join(*outDir, "payloads")
	if err := os.MkdirAll(payloadDir, 0o755); err != nil {
		log.Fatalf("mkdir %s: %v", payloadDir, err)
	}

	turns, err := buildTurnReports(ctx, client, conv, ws, messages, systemPrompt, modelTools, payloadDir, fixed, harnessCases)
	if err != nil {
		log.Fatalf("build turn reports: %v", err)
	}

	rep := report{
		GeneratedAt:        time.Now().UTC().Format(time.RFC3339),
		ConversationID:     conv.ID,
		ConversationTitle:  conv.Title,
		WorkspaceRoot:      ws.RootPath,
		SystemPromptID:     conv.SystemPromptID,
		SystemPromptName:   conv.SystemPromptName,
		SystemPromptChars:  len(systemPrompt),
		ToolCount:          countToolDecls(modelTools),
		Fixed:              fixed,
		UserTurnCount:      len(turns),
		ModelCallCount:     len(curve),
		MaxInputTokens:     maxInput,
		MaxCachedTokens:    maxCached,
		MaxUncachedTokens:  maxUncached,
		Curve:              curve,
		Turns:              turns,
		GlobalTopOffenders: globalTopOffenders(messages, 12),
		WrongThings: []string{
			"Large exec_command stdout blobs are persisted as tool messages and replayed in later model calls.",
			"Old tool results remain in the raw conversation prefix even after their information has already been consumed.",
			"Repeated or near-duplicate command outputs show up multiple times, increasing prompt size without adding fresh state.",
			"The full tool catalog is resent on every call even though it is mostly static across the conversation.",
		},
		CorrectThings: []string{
			"The system prompt is stable and worth keeping; it is fixed overhead, not the main source of turn-to-turn growth.",
			"Prior user requests and the current user message are low-volume and high-signal.",
			"Recent assistant text is small compared with tool output and usually contains useful narrative continuity.",
			"Thought text is already pruned from replay, which avoids a much larger failure mode.",
		},
		OptimizationActions: []string{
			"Stop replaying full tool stdout after the turn that produced it; store it for UI/debugging, but replace prompt replay with compact summaries plus file/message references.",
			"Summarize oversized tool responses above a byte or token threshold at persistence time, especially exec_command, grep_files, and read_file output.",
			"Carry a short working-set memory per completed user turn instead of the full raw transcript prefix.",
			"Keep static system and tool schema content eligible for caching or prefix reuse when the selected Gemini model/runtime supports it.",
			"Bias the agent toward structured tools that naturally bound output size, which reduces both immediate prompt growth and future replay cost.",
		},
		Sources: []sourceLink{
			{Label: "Gemini token counting", URL: "https://ai.google.dev/gemini-api/docs/tokens"},
			{Label: "Gemini pricing", URL: "https://ai.google.dev/gemini-api/docs/pricing"},
			{Label: "Gemini caching", URL: "https://ai.google.dev/gemini-api/docs/caching/"},
		},
	}

	reportJSON, err := json.MarshalIndent(rep, "", "  ")
	if err != nil {
		log.Fatalf("marshal report: %v", err)
	}
	if err := os.WriteFile(filepath.Join(*outDir, "report.json"), reportJSON, 0o644); err != nil {
		log.Fatalf("write report.json: %v", err)
	}

	htmlBytes, err := renderHTML(rep)
	if err != nil {
		log.Fatalf("render html: %v", err)
	}
	if err := os.WriteFile(filepath.Join(*outDir, "index.html"), htmlBytes, 0o644); err != nil {
		log.Fatalf("write index.html: %v", err)
	}

	fmt.Printf("report: %s\n", filepath.Join(*outDir, "report.json"))
	fmt.Printf("html: %s\n", filepath.Join(*outDir, "index.html"))
}

func loadConversation(dbPath, conversationID string) (conversationRow, *models.Workspace, []messageRow, error) {
	db, err := sql.Open("sqlite3", fmt.Sprintf("file:%s?mode=ro&_busy_timeout=5000", dbPath))
	if err != nil {
		return conversationRow{}, nil, nil, fmt.Errorf("open db: %w", err)
	}
	defer db.Close()

	var conv conversationRow
	if err := db.QueryRow(`
		SELECT id, title, workspace_id, system_prompt_id, system_prompt_name, worktree_path
		FROM conversations
		WHERE id = ?
	`, conversationID).Scan(&conv.ID, &conv.Title, &conv.WorkspaceID, &conv.SystemPromptID, &conv.SystemPromptName, &conv.WorktreePath); err != nil {
		return conversationRow{}, nil, nil, fmt.Errorf("load conversation %s: %w", conversationID, err)
	}

	ws := &models.Workspace{}
	if err := db.QueryRow(`
		SELECT id, name, root_path, canonical_root_path
		FROM workspaces
		WHERE id = ?
	`, conv.WorkspaceID).Scan(&ws.ID, &ws.Name, &ws.RootPath, &ws.CanonicalRootPath); err != nil {
		return conversationRow{}, nil, nil, fmt.Errorf("load workspace %s: %w", conv.WorkspaceID, err)
	}

	rows, err := db.Query(`
		SELECT id, seq, sent_by, parts_json, metadata_json, created_at
		FROM messages
		WHERE conversation_id = ? AND archived = 0
		ORDER BY seq ASC
	`, conversationID)
	if err != nil {
		return conversationRow{}, nil, nil, fmt.Errorf("load messages: %w", err)
	}
	defer rows.Close()

	var messages []messageRow
	for rows.Next() {
		var row messageRow
		if err := rows.Scan(&row.ID, &row.Seq, &row.SentBy, &row.PartsJSON, &row.MetadataJSON, &row.CreatedAt); err != nil {
			return conversationRow{}, nil, nil, fmt.Errorf("scan message: %w", err)
		}
		if err := json.Unmarshal([]byte(row.PartsJSON), &row.Parts); err != nil {
			return conversationRow{}, nil, nil, fmt.Errorf("parse parts for seq %d: %w", row.Seq, err)
		}
		if row.MetadataJSON == "" {
			row.Metadata = map[string]any{}
		} else if err := json.Unmarshal([]byte(row.MetadataJSON), &row.Metadata); err != nil {
			return conversationRow{}, nil, nil, fmt.Errorf("parse metadata for seq %d: %w", row.Seq, err)
		}
		row.ModelBytes, row.ModelPartKinds = modelMessageStats(row)
		row.ToolName = extractToolName(row.Parts)
		row.OutputChars = extractOutputChars(row.Parts)
		messages = append(messages, row)
	}
	if err := rows.Err(); err != nil {
		return conversationRow{}, nil, nil, fmt.Errorf("iterate messages: %w", err)
	}

	return conv, ws, messages, nil
}

func buildToolDefs(ws *models.Workspace, conv conversationRow) []*agent.ToolDef {
	pm := agenttools.NewProcessManager()
	baseTools := []*agent.ToolDef{
		agenttools.NewReadFileTool(ws),
		agenttools.NewListDirTool(ws),
		agenttools.NewGrepFilesTool(ws),
	}
	baseTools = append(baseTools, agenttools.NewParallelToolUseTool(func() []*agent.ToolDef { return baseTools }))
	baseTools = append(baseTools,
		agenttools.NewExecCommandTool(pm, ws),
		agenttools.NewWriteStdinTool(pm),
		agenttools.NewApplyPatchTool(ws),
		agenttools.NewUpdatePlanTool(),
		agenttools.NewRequestUserInputTool(),
	)

	childConv := &models.Conversation{
		ID:               models.ConversationID(conv.ID),
		WorkspaceID:      models.WorkspaceID(conv.WorkspaceID),
		Title:            conv.Title,
		SystemPromptID:   conv.SystemPromptID,
		SystemPromptName: conv.SystemPromptName,
	}
	return append(baseTools,
		agenttools.NewSpawnThreadTool(nil, nil, ws, childConv, baseTools, 0),
		agenttools.NewAwaitThreadTool(nil),
	)
}

func measureFixedOverhead(model, systemPrompt string, modelTools []*genai.Tool) (fixedOverhead, error) {
	tok, err := tokenizer.NewLocalTokenizer(localTokenizerModel(model))
	if err != nil {
		return fixedOverhead{}, err
	}

	dummy := []*genai.Content{{Role: "user", Parts: []*genai.Part{genai.NewPartFromText("x")}}}
	base, err := localCount(tok, dummy, "", nil)
	if err != nil {
		return fixedOverhead{}, err
	}
	systemOnly, err := localCount(tok, dummy, systemPrompt, nil)
	if err != nil {
		return fixedOverhead{}, err
	}
	toolsOnly, err := localCount(tok, dummy, "", modelTools)
	if err != nil {
		return fixedOverhead{}, err
	}
	both, err := localCount(tok, dummy, systemPrompt, modelTools)
	if err != nil {
		return fixedOverhead{}, err
	}

	return fixedOverhead{
		Base:          base,
		SystemOnly:    systemOnly - base,
		ToolsOnly:     toolsOnly - base,
		SystemAndTool: both - base,
	}, nil
}

func buildHarnessCases(dbPath, conversationID string) (map[string]harnessCase, error) {
	suite, err := evals.GenerateSuite(dbPath)
	if err != nil {
		return nil, err
	}
	out := make(map[string]harnessCase)
	for _, c := range suite.Cases {
		if c.Source.ConversationID != conversationID {
			continue
		}
		out[c.Source.MessageID] = harnessCase{
			UserMessageID: c.Source.MessageID,
			Prompt:        renderCasePrompt(c),
		}
	}
	return out, nil
}

func buildTurnReports(
	ctx context.Context,
	client *genai.Client,
	conv conversationRow,
	ws *models.Workspace,
	messages []messageRow,
	systemPrompt string,
	modelTools []*genai.Tool,
	payloadDir string,
	fixed fixedOverhead,
	harnessCases map[string]harnessCase,
) ([]turnReport, error) {
	var turns []turnReport

	for i, msg := range messages {
		if msg.SentBy != string(models.SentByUser) {
			continue
		}

		var initialAgent *messageRow
		for j := i + 1; j < len(messages); j++ {
			if messages[j].SentBy == string(models.SentByUser) {
				break
			}
			if messages[j].SentBy == string(models.SentByAgent) {
				initialAgent = &messages[j]
				break
			}
		}
		if initialAgent == nil {
			continue
		}

		history := make([]*models.Message, 0, initialAgent.Seq-1)
		var historyMsgs []messageRow
		var userCount, agentCount, toolCount, historyBytes int
		for _, candidate := range messages {
			if candidate.Seq >= initialAgent.Seq {
				break
			}
			history = append(history, &models.Message{
				ID:       models.MessageID(candidate.ID),
				Seq:      candidate.Seq,
				SentBy:   models.Sender(candidate.SentBy),
				Parts:    candidate.Parts,
				Metadata: candidate.Metadata,
			})
			historyMsgs = append(historyMsgs, candidate)
			historyBytes += candidate.ModelBytes
			switch candidate.SentBy {
			case string(models.SentByUser):
				userCount++
			case string(models.SentByAgent):
				agentCount++
			case string(models.SentByTool):
				toolCount++
			}
		}

		modelName := stringValue(initialAgent.Metadata, "model")
		if modelName == "" {
			modelName = agent.DefaultModel
		}
		thinkingLevel := stringValue(msg.Metadata, "thinking_level")

		liveContents := agent.MessagesToModelContents(history)
		liveContentCount, err := countTokens(ctx, client, modelName, liveContents)
		if err != nil {
			return nil, fmt.Errorf("count full turn %d: %w", len(turns)+1, err)
		}

		var noToolHistory []*models.Message
		for _, hm := range history {
			if hm.SentBy == models.SentByTool {
				continue
			}
			noToolHistory = append(noToolHistory, hm)
		}
		noToolContents := agent.MessagesToModelContents(noToolHistory)
		noToolContentCount, err := countTokens(ctx, client, modelName, noToolContents)
		if err != nil {
			return nil, fmt.Errorf("count no-tool turn %d: %w", len(turns)+1, err)
		}

		hCase, ok := harnessCases[msg.ID]
		if !ok {
			return nil, fmt.Errorf("missing harness case for user message %s", msg.ID)
		}
		harnessContents := []*genai.Content{{
			Role:  "user",
			Parts: []*genai.Part{genai.NewPartFromText(hCase.Prompt)},
		}}
		harnessContentCount, err := countTokens(ctx, client, modelName, harnessContents)
		if err != nil {
			return nil, fmt.Errorf("count harness turn %d: %w", len(turns)+1, err)
		}

		livePayloadPath := filepath.Join(payloadDir, fmt.Sprintf("turn-%02d-live.json", len(turns)+1))
		harnessPayloadPath := filepath.Join(payloadDir, fmt.Sprintf("turn-%02d-harness.json", len(turns)+1))
		if err := writePayload(livePayloadPath, map[string]any{
			"conversation_id":      conv.ID,
			"user_turn_index":      len(turns) + 1,
			"user_message_id":      msg.ID,
			"user_message_seq":     msg.Seq,
			"initial_agent_seq":    initialAgent.Seq,
			"model":                modelName,
			"thinking_level":       thinkingLevel,
			"system_prompt_id":     conv.SystemPromptID,
			"system_prompt_name":   conv.SystemPromptName,
			"system_instruction":   systemPrompt,
			"tool_declarations":    modelTools,
			"history_message_seqs": seqs(historyMsgs),
			"contents":             liveContents,
		}); err != nil {
			return nil, err
		}
		if err := writePayload(harnessPayloadPath, map[string]any{
			"conversation_id":    conv.ID,
			"user_turn_index":    len(turns) + 1,
			"user_message_id":    msg.ID,
			"model":              modelName,
			"thinking_level":     thinkingLevel,
			"system_prompt_id":   conv.SystemPromptID,
			"system_prompt_name": conv.SystemPromptName,
			"system_instruction": systemPrompt,
			"tool_declarations":  modelTools,
			"contents":           harnessContents,
			"prompt_text":        hCase.Prompt,
		}); err != nil {
			return nil, err
		}

		liveEstimate := liveContentCount + fixed.SystemAndTool
		loggedInput := intValue(initialAgent.Metadata, "tokens_input")
		loggedCached := intValue(initialAgent.Metadata, "tokens_cached")
		loggedUncached := loggedInput - loggedCached
		if loggedUncached < 0 {
			loggedUncached = 0
		}
		calibration := int32(0)
		if loggedInput > 0 {
			calibration = int32(loggedInput) - liveEstimate
		}
		liveCount := liveEstimate + calibration
		noToolCount := noToolContentCount + fixed.SystemAndTool + calibration
		harnessCount := harnessContentCount + fixed.SystemAndTool + calibration

		turn := turnReport{
			UserTurnIndex:     len(turns) + 1,
			UserMessageID:     msg.ID,
			UserMessageSeq:    msg.Seq,
			InitialAgentSeq:   initialAgent.Seq,
			Model:             modelName,
			ThinkingLevel:     thinkingLevel,
			UserText:          extractText(msg.Parts),
			HistoryCount:      len(historyMsgs),
			HistoryUserCount:  userCount,
			HistoryAgentCount: agentCount,
			HistoryToolCount:  toolCount,
			HistoryBytes:      historyBytes,
			Tokens: tokenVariant{
				LoggedInput:  loggedInput,
				LoggedCached: loggedCached,
				LoggedUncach: loggedUncached,
				APIFull:      liveCount,
				APINoTools:   noToolCount,
				APIHarness:   harnessCount,
			},
			SavingsNoToolsPct: savingsPct(liveCount, noToolCount),
			SavingsHarnessPct: savingsPct(liveCount, harnessCount),
			TopOffenders:      topOffenders(historyMsgs, 5),
			PayloadFile:       filepath.Base(livePayloadPath),
			HarnessPayload:    filepath.Base(harnessPayloadPath),
		}
		_ = fixed
		turns = append(turns, turn)
	}

	return turns, nil
}

func writePayload(path string, payload any) error {
	raw, err := json.MarshalIndent(payload, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal payload %s: %w", path, err)
	}
	if err := os.WriteFile(path, raw, 0o644); err != nil {
		return fmt.Errorf("write payload %s: %w", path, err)
	}
	return nil
}

func countTokens(ctx context.Context, client *genai.Client, model string, contents []*genai.Content) (int32, error) {
	resp, err := client.Models.CountTokens(ctx, model, contents, nil)
	if err != nil {
		return 0, err
	}
	return resp.TotalTokens, nil
}

func localCount(tok *tokenizer.LocalTokenizer, contents []*genai.Content, systemPrompt string, modelTools []*genai.Tool) (int32, error) {
	cfg := &genai.CountTokensConfig{}
	if strings.TrimSpace(systemPrompt) != "" {
		cfg.SystemInstruction = &genai.Content{
			Parts: []*genai.Part{genai.NewPartFromText(systemPrompt)},
		}
	}
	if len(modelTools) > 0 {
		cfg.Tools = modelTools
	}
	resp, err := tok.CountTokens(contents, cfg)
	if err != nil {
		return 0, err
	}
	return resp.TotalTokens, nil
}

func localTokenizerModel(model string) string {
	switch strings.TrimSpace(model) {
	case agent.ModelGemini31ProPreview:
		return agent.ModelGemini3ProPreview
	default:
		return model
	}
}

func buildCurve(messages []messageRow) []callCurvePoint {
	var curve []callCurvePoint
	iteration := 0
	for _, msg := range messages {
		if msg.SentBy != string(models.SentByAgent) {
			continue
		}
		input := intValue(msg.Metadata, "tokens_input")
		if input == 0 {
			iteration = 0
			continue
		}
		output := intValue(msg.Metadata, "tokens_output")
		cached := intValue(msg.Metadata, "tokens_cached")
		iteration++
		curve = append(curve, callCurvePoint{
			MessageSeq: msg.Seq,
			Iteration:  iteration,
			Input:      input,
			Output:     output,
			Cached:     cached,
			Uncached:   maxInt(input-cached, 0),
		})
	}
	return curve
}

func maxCurve(curve []callCurvePoint) (int, int, int) {
	var maxInput, maxCached, maxUncached int
	for _, p := range curve {
		if p.Input > maxInput {
			maxInput = p.Input
		}
		if p.Cached > maxCached {
			maxCached = p.Cached
		}
		if p.Uncached > maxUncached {
			maxUncached = p.Uncached
		}
	}
	return maxInput, maxCached, maxUncached
}

func modelMessageStats(msg messageRow) (int, []string) {
	content := agent.MessagesToModelContents([]*models.Message{{
		SentBy: models.Sender(msg.SentBy),
		Parts:  msg.Parts,
	}})
	if len(content) == 0 {
		return 0, nil
	}
	raw, _ := json.Marshal(content[0])
	var kinds []string
	for _, p := range content[0].Parts {
		switch {
		case p.FunctionCall != nil:
			kinds = append(kinds, "function_call")
		case p.FunctionResponse != nil:
			kinds = append(kinds, "function_response")
		case p.Text != "":
			kinds = append(kinds, "text")
		case p.InlineData != nil:
			kinds = append(kinds, "inline_data")
		case p.FileData != nil:
			kinds = append(kinds, "file_data")
		case p.ExecutableCode != nil:
			kinds = append(kinds, "code")
		case p.CodeExecutionResult != nil:
			kinds = append(kinds, "code_result")
		}
	}
	return len(raw), kinds
}

func extractText(parts []models.MessagePart) string {
	var lines []string
	for _, part := range parts {
		if part.Kind == models.PartText && part.Text != nil {
			text := strings.TrimSpace(part.Text.Text)
			if text != "" {
				lines = append(lines, text)
			}
		}
	}
	return strings.Join(lines, "\n")
}

func extractToolName(parts []models.MessagePart) string {
	for _, part := range parts {
		if part.Kind == models.PartFunctionResponse && part.FunctionResponse != nil {
			return strings.TrimSpace(part.FunctionResponse.Name)
		}
	}
	return ""
}

func extractOutputChars(parts []models.MessagePart) int {
	for _, part := range parts {
		if part.Kind != models.PartFunctionResponse || part.FunctionResponse == nil {
			continue
		}
		var payload map[string]any
		if err := json.Unmarshal(part.FunctionResponse.ResponseJSON, &payload); err != nil {
			return len(part.FunctionResponse.ResponseJSON)
		}
		if output, ok := payload["output"].(string); ok {
			return len(output)
		}
		return len(part.FunctionResponse.ResponseJSON)
	}
	return 0
}

func topOffenders(messages []messageRow, limit int) []offender {
	rows := append([]messageRow(nil), messages...)
	sort.Slice(rows, func(i, j int) bool {
		if rows[i].ModelBytes == rows[j].ModelBytes {
			return rows[i].Seq < rows[j].Seq
		}
		return rows[i].ModelBytes > rows[j].ModelBytes
	})
	if len(rows) > limit {
		rows = rows[:limit]
	}
	out := make([]offender, 0, len(rows))
	for _, row := range rows {
		out = append(out, offender{
			Seq:         row.Seq,
			SentBy:      row.SentBy,
			ToolName:    row.ToolName,
			ModelBytes:  row.ModelBytes,
			OutputChars: row.OutputChars,
			PartKinds:   strings.Join(row.ModelPartKinds, ", "),
		})
	}
	return out
}

func globalTopOffenders(messages []messageRow, limit int) []offender {
	var included []messageRow
	for _, row := range messages {
		if row.ModelBytes > 0 {
			included = append(included, row)
		}
	}
	return topOffenders(included, limit)
}

func seqs(messages []messageRow) []int64 {
	out := make([]int64, 0, len(messages))
	for _, m := range messages {
		out = append(out, m.Seq)
	}
	return out
}

func countToolDecls(tools []*genai.Tool) int {
	total := 0
	for _, tool := range tools {
		total += len(tool.FunctionDeclarations)
	}
	return total
}

func stringValue(meta map[string]any, key string) string {
	if meta == nil {
		return ""
	}
	if s, ok := meta[key].(string); ok {
		return strings.TrimSpace(s)
	}
	return ""
}

func intValue(meta map[string]any, key string) int {
	if meta == nil {
		return 0
	}
	switch v := meta[key].(type) {
	case int:
		return v
	case int32:
		return int(v)
	case int64:
		return int(v)
	case float64:
		return int(v)
	default:
		return 0
	}
}

func savingsPct(full, trimmed int32) float64 {
	if full <= 0 {
		return 0
	}
	return float64(full-trimmed) * 100 / float64(full)
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}

func renderCasePrompt(testCase evals.Case) string {
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

func renderToolCounts(counts map[string]int) string {
	type pair struct {
		Name  string
		Count int
	}
	var pairs []pair
	for name, count := range counts {
		pairs = append(pairs, pair{Name: name, Count: count})
	}
	sort.Slice(pairs, func(i, j int) bool {
		if pairs[i].Count == pairs[j].Count {
			return pairs[i].Name < pairs[j].Name
		}
		return pairs[i].Count > pairs[j].Count
	})
	parts := make([]string, 0, len(pairs))
	for _, p := range pairs {
		parts = append(parts, fmt.Sprintf("%s x%d", p.Name, p.Count))
	}
	return strings.Join(parts, ", ")
}

func renderHTML(rep report) ([]byte, error) {
	reportJSON, err := json.Marshal(rep)
	if err != nil {
		return nil, err
	}

	tmpl := template.Must(template.New("audit").Parse(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Prompt Sediment Audit</title>
  <style>
    :root {
      --paper: #f7f1e4;
      --ink: #1d1a16;
      --muted: #5b5347;
      --sand: #d2b48c;
      --brick: #b34a3c;
      --sage: #6b8f71;
      --steel: #556b8d;
      --line: rgba(29,26,22,.14);
      --panel: rgba(255,255,255,.58);
      --shadow: 0 22px 60px rgba(41, 27, 7, 0.12);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      color: var(--ink);
      background:
        radial-gradient(circle at 12% 20%, rgba(107,143,113,.18), transparent 26%),
        radial-gradient(circle at 88% 14%, rgba(179,74,60,.16), transparent 24%),
        linear-gradient(180deg, #faf6ee 0%, var(--paper) 54%, #efe5d2 100%);
      font-family: "Iowan Old Style", "Palatino Linotype", "Book Antiqua", Palatino, serif;
      min-height: 100vh;
    }
    body::before {
      content: "";
      position: fixed;
      inset: 0;
      pointer-events: none;
      background-image:
        linear-gradient(rgba(29,26,22,.03) 1px, transparent 1px),
        linear-gradient(90deg, rgba(29,26,22,.03) 1px, transparent 1px);
      background-size: 34px 34px;
      opacity: .4;
      mix-blend-mode: multiply;
    }
    .shell {
      width: min(1260px, calc(100vw - 32px));
      margin: 0 auto;
      padding: 28px 0 56px;
      position: relative;
    }
    .hero, .panel {
      background: var(--panel);
      backdrop-filter: blur(14px);
      border: 1px solid rgba(255,255,255,.7);
      box-shadow: var(--shadow);
      border-radius: 28px;
    }
    .hero {
      padding: 30px;
      position: relative;
      overflow: hidden;
    }
    .hero::after {
      content: "";
      position: absolute;
      inset: auto -8% -38% auto;
      width: 340px;
      height: 340px;
      border-radius: 50%;
      background: radial-gradient(circle, rgba(210,180,140,.7), rgba(210,180,140,0));
      filter: blur(10px);
    }
    .eyebrow {
      display: inline-block;
      padding: 7px 12px;
      border-radius: 999px;
      background: rgba(29,26,22,.08);
      color: var(--muted);
      font-size: 12px;
      letter-spacing: .18em;
      text-transform: uppercase;
    }
    h1 {
      margin: 16px 0 10px;
      font-size: clamp(2.6rem, 5vw, 5.2rem);
      line-height: .92;
      font-weight: 700;
      max-width: 11ch;
    }
    .lede {
      max-width: 58ch;
      font-size: 1.02rem;
      line-height: 1.65;
      color: var(--muted);
    }
    .metrics {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 12px;
      margin-top: 24px;
    }
    .metric {
      padding: 14px 16px;
      border-radius: 20px;
      background: rgba(255,255,255,.72);
      border: 1px solid rgba(29,26,22,.08);
    }
    .metric span {
      display: block;
      font-size: .74rem;
      letter-spacing: .16em;
      text-transform: uppercase;
      color: var(--muted);
      margin-bottom: 9px;
    }
    .metric strong {
      font-size: 1.55rem;
      line-height: 1;
    }
    .grid {
      display: grid;
      grid-template-columns: 1.1fr .9fr;
      gap: 18px;
      margin-top: 18px;
    }
    .panel {
      padding: 22px;
    }
    h2 {
      margin: 0 0 14px;
      font-size: 1.35rem;
    }
    .small {
      color: var(--muted);
      font-size: .95rem;
      line-height: 1.6;
    }
    .curve svg {
      width: 100%;
      height: 260px;
      display: block;
      border-radius: 18px;
      background: linear-gradient(180deg, rgba(255,255,255,.78), rgba(255,255,255,.32));
      border: 1px solid rgba(29,26,22,.08);
    }
    .legend {
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
      margin-top: 12px;
      color: var(--muted);
      font-size: .9rem;
    }
    .legend i {
      width: 12px;
      height: 12px;
      display: inline-block;
      border-radius: 999px;
      margin-right: 6px;
      vertical-align: middle;
    }
    .fixed-grid {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 10px;
    }
    .fixed-card {
      padding: 14px;
      border-radius: 18px;
      border: 1px solid rgba(29,26,22,.08);
      background: linear-gradient(180deg, rgba(255,255,255,.85), rgba(255,255,255,.48));
    }
    .fixed-card label {
      display: block;
      text-transform: uppercase;
      letter-spacing: .12em;
      font-size: .72rem;
      color: var(--muted);
      margin-bottom: 8px;
    }
    .fixed-card strong {
      font-size: 1.4rem;
    }
    .turns {
      margin-top: 18px;
      display: grid;
      gap: 14px;
    }
    .turn {
      display: grid;
      grid-template-columns: .8fr 1.2fr;
      gap: 18px;
      padding: 18px;
      border-radius: 24px;
      border: 1px solid rgba(29,26,22,.08);
      background: linear-gradient(180deg, rgba(255,255,255,.82), rgba(255,255,255,.44));
      box-shadow: inset 0 1px 0 rgba(255,255,255,.4);
    }
    .turn h3 {
      margin: 0 0 10px;
      font-size: 1.08rem;
    }
    .turn .prompt {
      color: var(--muted);
      line-height: 1.55;
      font-size: .94rem;
      max-height: 8.6em;
      overflow: hidden;
      position: relative;
    }
    .turn .prompt::after {
      content: "";
      position: absolute;
      inset: auto 0 0;
      height: 2.2em;
      background: linear-gradient(180deg, rgba(247,241,228,0), rgba(247,241,228,.95));
    }
    .stack-wrap {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
      align-items: end;
    }
    .stack-card {
      border-radius: 18px;
      padding: 14px;
      background: rgba(29,26,22,.03);
      border: 1px solid rgba(29,26,22,.06);
    }
    .stack-label {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      margin-bottom: 10px;
      font-size: .88rem;
      color: var(--muted);
    }
    .stack {
      height: 180px;
      display: flex;
      align-items: flex-end;
      gap: 0;
      border-radius: 16px;
      overflow: hidden;
      background: rgba(255,255,255,.55);
      border: 1px solid rgba(29,26,22,.08);
      position: relative;
    }
    .stack::after {
      content: "";
      position: absolute;
      inset: 0;
      background: linear-gradient(120deg, transparent 28%, rgba(255,255,255,.42) 50%, transparent 72%);
      animation: sweep 5s linear infinite;
      opacity: .55;
    }
    .segment {
      width: 100%;
      position: relative;
      min-height: 1px;
    }
    .segment span {
      position: absolute;
      left: 10px;
      top: 8px;
      font-size: .72rem;
      line-height: 1.15;
      color: rgba(29,26,22,.72);
      max-width: calc(100% - 20px);
    }
    .system { background: rgba(85,107,141,.72); }
    .tools { background: rgba(107,143,113,.72); }
    .history { background: rgba(210,180,140,.84); }
    .toolouts { background: rgba(179,74,60,.82); }
    .harness { background: rgba(85,107,141,.78); }
    .offenders, .notes {
      display: grid;
      gap: 10px;
    }
    .offender, .note {
      padding: 12px 14px;
      border-radius: 16px;
      background: rgba(255,255,255,.65);
      border: 1px solid rgba(29,26,22,.08);
    }
    .offender strong {
      display: block;
      margin-bottom: 4px;
    }
    .mono {
      font-family: Menlo, Monaco, Consolas, monospace;
      font-size: .88rem;
    }
    .footer {
      margin-top: 18px;
      color: var(--muted);
      font-size: .9rem;
      display: flex;
      gap: 14px;
      flex-wrap: wrap;
    }
    .footer a { color: inherit; }
    @keyframes sweep {
      from { transform: translateX(-120%); }
      to { transform: translateX(120%); }
    }
    @media (max-width: 980px) {
      .grid, .turn { grid-template-columns: 1fr; }
      .metrics, .fixed-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }
    @media (max-width: 680px) {
      .shell { width: min(100vw - 16px, 1260px); padding-top: 16px; }
      .hero, .panel { border-radius: 22px; }
      .metrics, .fixed-grid, .stack-wrap { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="shell">
    <section class="hero">
      <div class="eyebrow">Prompt Sediment Audit</div>
      <h1>How the prompt swelled while the task barely changed.</h1>
      <p class="lede" id="lede"></p>
      <div class="metrics" id="metrics"></div>
    </section>

    <div class="grid">
      <section class="panel curve">
        <h2>All Model Calls</h2>
        <p class="small">Logged input tokens for every persisted agent call. The sand line is total prompt, the brick line is uncached prompt, and the blue fill shows cached replay.</p>
        <svg id="curve" viewBox="0 0 800 260" preserveAspectRatio="none"></svg>
        <div class="legend">
          <span><i style="background:#d2b48c"></i>Total input</span>
          <span><i style="background:#b34a3c"></i>Uncached input</span>
          <span><i style="background:#556b8d"></i>Cached replay</span>
        </div>
      </section>
      <section class="panel">
        <h2>Fixed Overhead</h2>
        <p class="small">This cost is mostly stable. The real growth comes from replaying conversation payload, especially tool output.</p>
        <div class="fixed-grid" id="fixed"></div>
      </section>
    </div>

    <section class="panel" style="margin-top:18px;">
      <h2>User Turns</h2>
      <p class="small">Each card compares the live request for the first model call of that user turn against two tighter alternatives: drop raw tool messages, or replace the transcript with the harness-style summary prompt.</p>
      <div class="turns" id="turns"></div>
    </section>

    <div class="grid">
      <section class="panel">
        <h2>Largest Replayed Messages</h2>
        <p class="small">These are the heaviest individual messages after conversion to the actual model payload format, not raw DB row size.</p>
        <div class="offenders" id="offenders"></div>
      </section>
      <section class="panel">
        <h2>What Is Wrong vs Right</h2>
        <div class="notes" id="notes"></div>
      </section>
    </div>

    <div class="footer" id="footer"></div>
  </div>

  <script id="report-data" type="application/json">{{ .ReportJSON }}</script>
  <script>
    const report = JSON.parse(document.getElementById('report-data').textContent);

    const fmt = new Intl.NumberFormat('en-US');
    const pct = (value) => value.toFixed(1) + '%';

    document.getElementById('lede').textContent =
      report.conversation_title + ' ran for ' + fmt.format(report.user_turn_count) +
      ' user turns and ' + fmt.format(report.model_call_count) +
      ' model calls. The peak live prompt reached ' + fmt.format(report.max_input_tokens) +
      ' input tokens, with ' + fmt.format(report.max_cached_tokens) +
      ' of those tokens coming back as cached replay.';

    const metrics = [
      ['User turns', report.user_turn_count],
      ['Model calls', report.model_call_count],
      ['Peak input', report.max_input_tokens],
      ['Peak uncached', report.max_uncached_tokens],
    ];
    document.getElementById('metrics').innerHTML = metrics.map(function(item) {
      const label = item[0];
      const value = item[1];
      return '<div class="metric">' +
        '<span>' + label + '</span>' +
        '<strong>' + fmt.format(value) + '</strong>' +
      '</div>';
    }).join('');

    const fixed = [
      ['Base wrapper', report.fixed_overhead.base],
      ['System prompt', report.fixed_overhead.system_only],
      ['Tool schema', report.fixed_overhead.tools_only],
      ['System + tools', report.fixed_overhead.system_and_tool],
    ];
    document.getElementById('fixed').innerHTML = fixed.map(function(item) {
      const label = item[0];
      const value = item[1];
      return '<div class="fixed-card">' +
        '<label>' + label + '</label>' +
        '<strong>' + fmt.format(value) + '</strong>' +
      '</div>';
    }).join('');

    const svg = document.getElementById('curve');
    const pts = report.curve;
    const maxY = Math.max(...pts.map((p) => p.input), 1);
    const width = 800;
    const height = 260;
    const padX = 24;
    const padY = 20;
    const x = (index) => padX + (width - padX * 2) * (pts.length <= 1 ? 0 : index / (pts.length - 1));
    const y = (value) => height - padY - ((height - padY * 2) * value / maxY);
    const poly = (key) => pts.map(function(p, i) { return x(i) + ',' + y(p[key]); }).join(' ');
    const area = pts.map(function(p, i) { return x(i) + ',' + y(p.cached); }).join(' ');
    svg.innerHTML =
      '<defs>' +
        '<linearGradient id="areaFill" x1="0" y1="0" x2="0" y2="1">' +
          '<stop offset="0%" stop-color="rgba(85,107,141,.45)"/>' +
          '<stop offset="100%" stop-color="rgba(85,107,141,0)"/>' +
        '</linearGradient>' +
      '</defs>' +
      [0, .25, .5, .75, 1].map(function(t) {
        return '<line x1="' + padX + '" y1="' + y(maxY * t) + '" x2="' + (width-padX) + '" y2="' + y(maxY * t) + '" stroke="rgba(29,26,22,.08)" stroke-width="1"/>';
      }).join('') +
      '<polygon points="' + padX + ',' + (height-padY) + ' ' + area + ' ' + (width-padX) + ',' + (height-padY) + '" fill="url(#areaFill)"></polygon>' +
      '<polyline points="' + poly('input') + '" fill="none" stroke="#d2b48c" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"></polyline>' +
      '<polyline points="' + poly('uncached') + '" fill="none" stroke="#b34a3c" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"></polyline>';

    const turns = document.getElementById('turns');
    const fixedOverhead = report.fixed_overhead.system_and_tool;
    turns.innerHTML = report.turns.map(function(turn) {
      const live = Math.max(turn.tokens.api_full, 1);
      const history = Math.max(live - fixedOverhead, 1);
      const toolOut = Math.max(turn.tokens.api_full - turn.tokens.api_no_tool_messages, 0);
      const narrative = Math.max(history - toolOut, 0);
      const liveHistoryPct = history / live * 100;
      const toolOutPct = toolOut / live * 100;
      const fixedPct = fixedOverhead / live * 100;
      const harnessHistoryPct = Math.max(turn.tokens.api_harness - fixedOverhead, 0) / Math.max(turn.tokens.api_harness, 1) * 100;
      return '<article class="turn">' +
        '<div>' +
          '<h3>Turn ' + turn.user_turn_index + '</h3>' +
          '<div class="prompt">' + turn.user_text + '</div>' +
          '<p class="small" style="margin:12px 0 0;">' +
            'Prefix before first call: ' + fmt.format(turn.history_count) + ' messages ' +
            '(' + fmt.format(turn.history_user_count) + ' user / ' + fmt.format(turn.history_agent_count) + ' agent / ' + fmt.format(turn.history_tool_count) + ' tool) ' +
            'and ' + fmt.format(turn.history_model_bytes) + ' payload bytes after conversion.' +
          '</p>' +
          '<p class="small" style="margin:8px 0 0;">' +
            'Logged cache hit: ' + fmt.format(turn.tokens.logged_cached) + ' of ' + fmt.format(turn.tokens.logged_input) + ' input tokens. ' +
            'Payloads: <span class="mono">' + turn.payload_file + '</span> and <span class="mono">' + turn.harness_payload_file + '</span>.' +
          '</p>' +
        '</div>' +
        '<div class="stack-wrap">' +
          '<div class="stack-card">' +
            '<div class="stack-label"><strong>Live request</strong><span>' + fmt.format(turn.tokens.api_full) + ' tok</span></div>' +
            '<div class="stack">' +
              '<div class="segment system" style="height:' + fixedPct + '%"><span>fixed<br>' + fmt.format(fixedOverhead) + '</span></div>' +
              '<div class="segment history" style="height:' + Math.max(liveHistoryPct - toolOutPct, 0) + '%"><span>narrative<br>' + fmt.format(narrative) + '</span></div>' +
              '<div class="segment toolouts" style="height:' + toolOutPct + '%"><span>tool output<br>' + fmt.format(toolOut) + '</span></div>' +
            '</div>' +
          '</div>' +
          '<div class="stack-card">' +
            '<div class="stack-label"><strong>Harness prompt</strong><span>' + fmt.format(turn.tokens.api_harness) + ' tok</span></div>' +
            '<div class="stack">' +
              '<div class="segment system" style="height:' + ((fixedOverhead / Math.max(turn.tokens.api_harness,1)) * 100) + '%"><span>fixed</span></div>' +
              '<div class="segment harness" style="height:' + harnessHistoryPct + '%"><span>summary</span></div>' +
            '</div>' +
            '<p class="small" style="margin:10px 0 0;">Savings: ' + pct(turn.savings_harness_pct) + '. Drop-tool-only savings: ' + pct(turn.savings_no_tool_messages_pct) + '.</p>' +
          '</div>' +
        '</div>' +
      '</article>';
    }).join('');

    document.getElementById('offenders').innerHTML = report.global_top_offenders.map(function(item) {
      return '<div class="offender">' +
        '<strong>seq ' + item.seq + ' · ' + item.sent_by + (item.tool_name ? ' · ' + item.tool_name : '') + '</strong>' +
        '<div class="small">payload bytes: ' + fmt.format(item.model_bytes) + (item.output_chars ? ' · output chars: ' + fmt.format(item.output_chars) : '') + '</div>' +
        '<div class="mono" style="margin-top:6px;">' + item.part_kinds + '</div>' +
      '</div>';
    }).join('');

    const notes = document.getElementById('notes');
    notes.innerHTML = [
      ...report.wrong_things.map(function(text) { return '<div class="note"><strong>Wrong</strong><div class="small">' + text + '</div></div>'; }),
      ...report.correct_things.map(function(text) { return '<div class="note"><strong>Right</strong><div class="small">' + text + '</div></div>'; }),
      ...report.optimization_actions.map(function(text) { return '<div class="note"><strong>Action</strong><div class="small">' + text + '</div></div>'; }),
    ].join('');

    document.getElementById('footer').innerHTML = report.sources.map(function(src) {
      return '<a href="' + src.url + '">' + src.label + '</a>';
    }).join('');
  </script>
</body>
</html>`))

	var out strings.Builder
	if err := tmpl.Execute(&out, map[string]any{"ReportJSON": template.JS(reportJSON)}); err != nil {
		return nil, err
	}
	return []byte(out.String()), nil
}
