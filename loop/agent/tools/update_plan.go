package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"loop/agent"

	"google.golang.org/genai"
)

type updatePlanArgs struct {
	Explanation string           `json:"explanation,omitempty"`
	Plan        []updatePlanItem `json:"plan"`
}

type updatePlanItem struct {
	Step   string `json:"step"`
	Status string `json:"status"`
}

// NewUpdatePlanTool creates the update_plan tool.
func NewUpdatePlanTool() *agent.ToolDef {
	return &agent.ToolDef{
		Declaration: &genai.FunctionDeclaration{
			Name: "update_plan",
			Description: `Updates the task plan.
Provide an optional explanation and a list of plan items, each with a step and status.
At most one step can be in_progress at a time.`,
			Parameters: &genai.Schema{
				Type: genai.TypeObject,
				Properties: map[string]*genai.Schema{
					"explanation": {
						Type:        genai.TypeString,
						Description: "Optional explanation for why the plan changed.",
					},
					"plan": {
						Type:        genai.TypeArray,
						Description: "The list of steps",
						Items: &genai.Schema{
							Type: genai.TypeObject,
							Properties: map[string]*genai.Schema{
								"step": {
									Type:        genai.TypeString,
									Description: "Plan step text.",
								},
								"status": {
									Type:        genai.TypeString,
									Description: "One of: pending, in_progress, completed",
									Enum:        []string{"pending", "in_progress", "completed"},
								},
							},
							Required: []string{"step", "status"},
						},
					},
				},
				Required: []string{"plan"},
			},
		},
		Handler: handleUpdatePlan,
	}
}

func handleUpdatePlan(_ context.Context, args json.RawMessage) (json.RawMessage, error) {
	var a updatePlanArgs
	if err := json.Unmarshal(args, &a); err != nil {
		return nil, fmt.Errorf("failed to parse arguments: %w", err)
	}

	if len(a.Plan) == 0 {
		return nil, fmt.Errorf("plan must contain at least one item")
	}

	inProgressCount := 0
	pendingCount := 0
	completedCount := 0

	normalized := make([]updatePlanItem, len(a.Plan))
	for i, item := range a.Plan {
		step := strings.TrimSpace(item.Step)
		if step == "" {
			return nil, fmt.Errorf("plan[%d].step must not be empty", i)
		}

		status := normalizePlanStatus(item.Status)
		switch status {
		case "pending":
			pendingCount++
		case "in_progress":
			inProgressCount++
		case "completed":
			completedCount++
		default:
			return nil, fmt.Errorf("plan[%d].status must be one of: pending, in_progress, completed", i)
		}

		normalized[i] = updatePlanItem{Step: step, Status: status}
	}

	if inProgressCount > 1 {
		return nil, fmt.Errorf("at most one step can be in_progress")
	}

	resp := map[string]any{
		"output":            "Plan updated",
		"plan":              normalized,
		"pending_count":     pendingCount,
		"in_progress_count": inProgressCount,
		"completed_count":   completedCount,
		"all_completed":     completedCount == len(normalized),
	}
	if strings.TrimSpace(a.Explanation) != "" {
		resp["explanation"] = strings.TrimSpace(a.Explanation)
	}

	return json.Marshal(resp)
}

func normalizePlanStatus(status string) string {
	s := strings.ToLower(strings.TrimSpace(status))
	s = strings.ReplaceAll(s, "-", "_")
	s = strings.ReplaceAll(s, " ", "_")
	return s
}
