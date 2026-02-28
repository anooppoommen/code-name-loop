package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"loop/agent"

	"google.golang.org/genai"
)

const (
	maxRequestUserInputQuestions = 3
	maxQuestionHeaderLength      = 12
)

type requestUserInputArgs struct {
	Questions []requestUserInputQuestion `json:"questions"`
}

type requestUserInputQuestion struct {
	ID       string                        `json:"id"`
	Header   string                        `json:"header"`
	Question string                        `json:"question"`
	Options  []requestUserInputQuestionOpt `json:"options"`
}

type requestUserInputQuestionOpt struct {
	Label       string `json:"label"`
	Description string `json:"description"`
}

// NewRequestUserInputTool creates the request_user_input tool.
func NewRequestUserInputTool() *agent.ToolDef {
	return &agent.ToolDef{
		Declaration: &genai.FunctionDeclaration{
			Name:        "request_user_input",
			Description: "Request user input for one to three short questions and wait for the response. In this runtime, the tool validates the questions and returns a structured prompt payload for the assistant to ask in its next message.",
			Parameters: &genai.Schema{
				Type: genai.TypeObject,
				Properties: map[string]*genai.Schema{
					"questions": {
						Type:        genai.TypeArray,
						Description: "Questions to show the user. Prefer 1 and do not exceed 3",
						Items: &genai.Schema{
							Type: genai.TypeObject,
							Properties: map[string]*genai.Schema{
								"id": {
									Type:        genai.TypeString,
									Description: "Stable identifier for mapping answers (snake_case).",
								},
								"header": {
									Type:        genai.TypeString,
									Description: "Short header label shown in the UI (12 or fewer chars).",
								},
								"question": {
									Type:        genai.TypeString,
									Description: "Single-sentence prompt shown to the user.",
								},
								"options": {
									Type:        genai.TypeArray,
									Description: "Provide 2-3 mutually exclusive choices. Put the recommended option first and suffix its label with (Recommended).",
									Items: &genai.Schema{
										Type: genai.TypeObject,
										Properties: map[string]*genai.Schema{
											"label": {
												Type:        genai.TypeString,
												Description: "User-facing label (1-5 words).",
											},
											"description": {
												Type:        genai.TypeString,
												Description: "One short sentence explaining impact/tradeoff if selected.",
											},
										},
										Required: []string{"label", "description"},
									},
								},
							},
							Required: []string{"id", "header", "question", "options"},
						},
					},
				},
				Required: []string{"questions"},
			},
		},
		Handler: handleRequestUserInput,
	}
}

func handleRequestUserInput(_ context.Context, args json.RawMessage) (json.RawMessage, error) {
	var a requestUserInputArgs
	if err := json.Unmarshal(args, &a); err != nil {
		return nil, fmt.Errorf("failed to parse arguments: %w", err)
	}

	if len(a.Questions) == 0 {
		return nil, fmt.Errorf("questions must contain at least one question")
	}
	if len(a.Questions) > maxRequestUserInputQuestions {
		return nil, fmt.Errorf("questions must contain at most %d questions", maxRequestUserInputQuestions)
	}

	seenIDs := make(map[string]struct{}, len(a.Questions))
	normalized := make([]requestUserInputQuestion, len(a.Questions))
	for i, q := range a.Questions {
		id := strings.TrimSpace(q.ID)
		if id == "" {
			return nil, fmt.Errorf("questions[%d].id must not be empty", i)
		}
		if _, exists := seenIDs[id]; exists {
			return nil, fmt.Errorf("questions[%d].id must be unique", i)
		}
		seenIDs[id] = struct{}{}

		header := strings.TrimSpace(q.Header)
		if header == "" {
			return nil, fmt.Errorf("questions[%d].header must not be empty", i)
		}
		if len([]rune(header)) > maxQuestionHeaderLength {
			return nil, fmt.Errorf("questions[%d].header must be %d characters or fewer", i, maxQuestionHeaderLength)
		}

		question := strings.TrimSpace(q.Question)
		if question == "" {
			return nil, fmt.Errorf("questions[%d].question must not be empty", i)
		}

		if len(q.Options) < 2 || len(q.Options) > 3 {
			return nil, fmt.Errorf("questions[%d].options must contain 2-3 items", i)
		}

		normalizedOpts := make([]requestUserInputQuestionOpt, len(q.Options))
		for j, opt := range q.Options {
			label := strings.TrimSpace(opt.Label)
			desc := strings.TrimSpace(opt.Description)
			if label == "" {
				return nil, fmt.Errorf("questions[%d].options[%d].label must not be empty", i, j)
			}
			if desc == "" {
				return nil, fmt.Errorf("questions[%d].options[%d].description must not be empty", i, j)
			}
			normalizedOpts[j] = requestUserInputQuestionOpt{Label: label, Description: desc}
		}

		normalized[i] = requestUserInputQuestion{
			ID:       id,
			Header:   header,
			Question: question,
			Options:  normalizedOpts,
		}
	}

	return json.Marshal(map[string]any{
		"supported": false,
		"reason":    "interactive request_user_input is not yet supported in this runtime",
		"next_step": "Ask the same question(s) directly to the user in your next assistant message and wait for their reply.",
		"questions": normalized,
	})
}
