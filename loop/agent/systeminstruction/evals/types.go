package evals

import "time"

type Suite struct {
	GeneratedAt time.Time   `json:"generated_at"`
	Source      SuiteSource `json:"source"`
	Cases       []Case      `json:"cases"`
}

type SuiteSource struct {
	DBPath            string `json:"db_path"`
	WorkspaceID       string `json:"workspace_id"`
	WorkspaceName     string `json:"workspace_name"`
	WorkspaceRoot     string `json:"workspace_root"`
	ConversationCount int    `json:"conversation_count"`
	UserTurnCount     int    `json:"user_turn_count"`
}

type Case struct {
	ID            string         `json:"id"`
	Source        CaseSource     `json:"source"`
	Input         CaseInput      `json:"input"`
	Expectations  Expectations   `json:"expectations"`
	OriginalRun   OriginalRun    `json:"original_run"`
	FailureTraits []string       `json:"failure_traits,omitempty"`
	Tags          []string       `json:"tags,omitempty"`
	Metadata      map[string]any `json:"metadata,omitempty"`
}

type CaseSource struct {
	ConversationID    string    `json:"conversation_id"`
	ConversationTitle string    `json:"conversation_title"`
	MessageID         string    `json:"message_id"`
	UserTurnIndex     int       `json:"user_turn_index"`
	CreatedAt         time.Time `json:"created_at"`
}

type CaseInput struct {
	WorkspaceRoot      string      `json:"workspace_root"`
	ConversationTitle  string      `json:"conversation_title"`
	ConversationPhase  string      `json:"conversation_phase"`
	PriorTurns         []PriorTurn `json:"prior_turns,omitempty"`
	LatestUserMessage  string      `json:"latest_user_message"`
	NamedArtifacts     []string    `json:"named_artifacts,omitempty"`
	OriginalFirstQuery string      `json:"original_first_query,omitempty"`
}

type PriorTurn struct {
	UserText            string         `json:"user_text"`
	AssistantToolCounts map[string]int `json:"assistant_tool_counts,omitempty"`
	AssistantFirstTools []string       `json:"assistant_first_tools,omitempty"`
	AssistantFinalText  string         `json:"assistant_final_text,omitempty"`
	ApprovalRequests    int            `json:"approval_requests,omitempty"`
	Errors              int            `json:"errors,omitempty"`
}

type Expectations struct {
	PrimaryIntent             string   `json:"primary_intent"`
	ShouldPatch               bool     `json:"should_patch"`
	MustInspectBeforePatching bool     `json:"must_inspect_before_patching"`
	MustNotPatchThisTurn      bool     `json:"must_not_patch_this_turn"`
	ShouldAskClarifying       bool     `json:"should_ask_clarifying"`
	ShouldCheckGitStatus      bool     `json:"should_check_git_status"`
	RequireContractReset      bool     `json:"require_contract_reset"`
	PrioritizeNamedArtifacts  bool     `json:"prioritize_named_artifacts"`
	PrioritizeSourceOfTruth   bool     `json:"prioritize_source_of_truth"`
	PreferParallelDiscovery   bool     `json:"prefer_parallel_discovery"`
	AvoidUpdatePlan           bool     `json:"avoid_update_plan"`
	AvoidRequestUserInput     bool     `json:"avoid_request_user_input"`
	PreferStructuredTools     bool     `json:"prefer_structured_tools"`
	PreferredFirstTools       []string `json:"preferred_first_tools,omitempty"`
	ForbiddenFirstTools       []string `json:"forbidden_first_tools,omitempty"`
	ForbiddenTools            []string `json:"forbidden_tools,omitempty"`
	QualitySignals            []string `json:"quality_signals,omitempty"`
}

type OriginalRun struct {
	ToolCounts            map[string]int `json:"tool_counts,omitempty"`
	FirstTools            []string       `json:"first_tools,omitempty"`
	ApprovalRequests      int            `json:"approval_requests"`
	Errors                int            `json:"errors"`
	FinalAssistantText    string         `json:"final_assistant_text,omitempty"`
	NextUserCorrection    string         `json:"next_user_correction,omitempty"`
	UserExpressedDissatis int            `json:"user_expressed_dissatisfaction"`
}

type RunResult struct {
	SuitePath      string          `json:"suite_path"`
	Variant        string          `json:"variant"`
	Model          string          `json:"model"`
	JudgeModel     string          `json:"judge_model"`
	GeneratedAt    time.Time       `json:"generated_at"`
	CaseCount      int             `json:"case_count"`
	Summary        RunSummary      `json:"summary"`
	CategoryScores []CategoryScore `json:"category_scores,omitempty"`
	Cases          []ScoredCase    `json:"cases"`
}

type RunSummary struct {
	AverageScore               float64 `json:"average_score"`
	AverageIntentRouting       float64 `json:"average_intent_routing"`
	AverageContextBuilding     float64 `json:"average_context_building"`
	AverageToolDiscipline      float64 `json:"average_tool_discipline"`
	AverageCorrectionHandling  float64 `json:"average_correction_handling"`
	AverageTurnEfficiency      float64 `json:"average_turn_efficiency"`
	PassRate                   float64 `json:"pass_rate"`
	DeterministicPenaltyEvents int     `json:"deterministic_penalty_events"`
}

type CategoryScore struct {
	Tag          string  `json:"tag"`
	AverageScore float64 `json:"average_score"`
	Count        int     `json:"count"`
}

type ScoredCase struct {
	CaseID                string             `json:"case_id"`
	PromptedInput         string             `json:"prompted_input"`
	CandidateToolCalls    []ToolCallSnapshot `json:"candidate_tool_calls,omitempty"`
	CandidateText         string             `json:"candidate_text,omitempty"`
	Usage                 map[string]int32   `json:"usage,omitempty"`
	DeterministicFindings []string           `json:"deterministic_findings,omitempty"`
	Judge                 JudgeResult        `json:"judge"`
	FinalScore            float64            `json:"final_score"`
	Passed                bool               `json:"passed"`
}

type ToolCallSnapshot struct {
	Name string         `json:"name"`
	Args map[string]any `json:"args,omitempty"`
}

type JudgeResult struct {
	IntentRouting      int      `json:"intent_routing"`
	ContextBuilding    int      `json:"context_building"`
	ToolDiscipline     int      `json:"tool_discipline"`
	CorrectionHandling int      `json:"correction_handling"`
	TurnEfficiency     int      `json:"turn_efficiency"`
	Strengths          []string `json:"strengths,omitempty"`
	Weaknesses         []string `json:"weaknesses,omitempty"`
	Notes              string   `json:"notes,omitempty"`
}
