// Package agent provides the Gemini API client for the coding agent.
// It wraps google.golang.org/genai and provides methods to send
// conversation history and receive model responses, translating between
// the internal models.Message representation and Gemini Content/Part protocol.
package agent

import (
	"context"
	"fmt"
	"strings"

	"google.golang.org/genai"

	"loop/models"
)

const (
	// DefaultModel is the Gemini model used when none is specified.
	ModelGemini31ProPreview  = "gemini-3.1-pro-preview"
	ModelGemini3FlashPreview = "gemini-3-flash-preview"
	ModelGemini3ProPreview   = "gemini-3-pro-preview"
	DefaultModel             = ModelGemini31ProPreview
	defaultIncludeThoughts   = true
	DefaultThinkingLevel     = genai.ThinkingLevelMedium
)

// Client wraps the Gemini GenAI client.
type Client struct {
	genai *genai.Client
	model string
}

// ClientOption configures a Client.
type ClientOption func(*Client)

// WithModel overrides the default model name.
func WithModel(model string) ClientOption {
	return func(c *Client) { c.model = model }
}

// NewClient creates a Gemini API client.
// The API key is passed directly rather than read from the environment,
// since the caller is expected to use config.go for env loading.
func NewClient(ctx context.Context, apiKey string, opts ...ClientOption) (*Client, error) {
	if apiKey == "" {
		return nil, fmt.Errorf("API key is required")
	}

	genaiClient, err := genai.NewClient(ctx, &genai.ClientConfig{
		APIKey:  apiKey,
		Backend: genai.BackendGeminiAPI,
	})
	if err != nil {
		return nil, fmt.Errorf("create genai client: %w", err)
	}

	c := &Client{
		genai: genaiClient,
		model: DefaultModel,
	}
	for _, opt := range opts {
		opt(c)
	}
	return c, nil
}

// Model returns the model name this client is configured to use.
func (c *Client) Model() string { return c.model }

// GenerateContentConfig holds configuration for a model call.
type GenerateContentConfig struct {
	// Model optionally overrides the client's default model for this request.
	Model string
	// SystemInstruction is the system prompt for the model.
	SystemInstruction string
	// Temperature controls randomness (0.0 = deterministic, 2.0 = very random).
	Temperature *float32
	// Tools are the genai tool declarations available to the model.
	Tools []*genai.Tool
	// IncludeThoughts controls whether thought parts should be returned.
	// If nil, the client default is used.
	IncludeThoughts *bool
	// ThinkingLevel controls the model's thought budget profile.
	// If nil, the client default is used.
	ThinkingLevel *genai.ThinkingLevel
}

func (c *Client) buildGenaiConfig(config *GenerateContentConfig) *genai.GenerateContentConfig {
	includeThoughts := defaultIncludeThoughts
	thinkingLevel := DefaultThinkingLevel
	if config != nil {
		if config.IncludeThoughts != nil {
			includeThoughts = *config.IncludeThoughts
		}
		if config.ThinkingLevel != nil {
			thinkingLevel = *config.ThinkingLevel
		}
	}

	if config == nil {
		return &genai.GenerateContentConfig{
			ThinkingConfig: &genai.ThinkingConfig{
				IncludeThoughts: includeThoughts,
				ThinkingLevel:   thinkingLevel,
			},
		}
	}

	genaiConfig := &genai.GenerateContentConfig{}

	if config.SystemInstruction != "" {
		genaiConfig.SystemInstruction = &genai.Content{
			Parts: []*genai.Part{genai.NewPartFromText(config.SystemInstruction)},
		}
	}
	if config.Temperature != nil {
		genaiConfig.Temperature = genai.Ptr(*config.Temperature)
	}
	if len(config.Tools) > 0 {
		genaiConfig.Tools = config.Tools
	}
	// Apply per-turn thinking configuration with sensible defaults.
	genaiConfig.ThinkingConfig = &genai.ThinkingConfig{
		IncludeThoughts: includeThoughts,
		ThinkingLevel:   thinkingLevel,
	}

	return genaiConfig
}

// ParseThinkingLevel normalizes user-facing thinking level values.
// Accepted values: minimal, low, medium, high. Empty defaults to medium.
func ParseThinkingLevel(raw string) (genai.ThinkingLevel, error) {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "":
		return DefaultThinkingLevel, nil
	case "minimal":
		return genai.ThinkingLevelMinimal, nil
	case "low":
		return genai.ThinkingLevelLow, nil
	case "medium":
		return genai.ThinkingLevelMedium, nil
	case "high":
		return genai.ThinkingLevelHigh, nil
	default:
		return "", fmt.Errorf("invalid thinking level %q (allowed: minimal, low, medium, high)", raw)
	}
}

// ParseModel normalizes user-facing model values.
// Accepted canonical values:
//   - gemini-3.1-pro-preview
//   - gemini-3-flash-preview
//   - gemini-3-pro-preview
//
// Empty defaults to DefaultModel.
func ParseModel(raw string) (string, error) {
	normalized := strings.ToLower(strings.TrimSpace(raw))
	normalized = strings.ReplaceAll(normalized, "_", "-")
	normalized = strings.Join(strings.Fields(normalized), "-")

	switch normalized {
	case "":
		return DefaultModel, nil
	case ModelGemini31ProPreview, "gemini-3.1-pro", "gemini-3.1-propreview", "gemini-3-1-pro-preview", "3.1-pro-preview":
		return ModelGemini31ProPreview, nil
	case ModelGemini3FlashPreview, "gemini-3-flash", "gemini-3-flashpreview", "3-flash", "3-flash-preview":
		return ModelGemini3FlashPreview, nil
	case ModelGemini3ProPreview, "gemini-3-pro", "gemini-3-propreview", "3-pro", "3-pro-preview":
		return ModelGemini3ProPreview, nil
	default:
		return "", fmt.Errorf(
			"invalid model %q (allowed: %s, %s, %s)",
			raw,
			ModelGemini31ProPreview,
			ModelGemini3FlashPreview,
			ModelGemini3ProPreview,
		)
	}
}

// StreamMessage sends the conversation history to Gemini using the streaming
// API and returns a channel of TurnEvents. The channel emits EventDelta for
// each chunk, EventMessageDone with the fully assembled message when the
// stream completes, and EventError on failure.
//
// The streaming is driven in a background goroutine and respects context
// cancellation. The returned channel is closed when the stream finishes.
func (c *Client) StreamMessage(ctx context.Context, history []*models.Message, config *GenerateContentConfig) <-chan TurnEvent {
	ch := make(chan TurnEvent, 64)

	go func() {
		defer close(ch)

		contents := MessagesToModelContents(history)
		genaiConfig := c.buildGenaiConfig(config)
		modelName := c.model
		if config != nil && strings.TrimSpace(config.Model) != "" {
			modelName = strings.TrimSpace(config.Model)
		}

		// Use the streaming API: returns iter.Seq2[*GenerateContentResponse, error].
		var accumulatedParts []*genai.Part
		var usage *genai.GenerateContentResponseUsageMetadata

		for resp, err := range c.genai.Models.GenerateContentStream(ctx, modelName, contents, genaiConfig) {
			// Check context cancellation first.
			if ctx.Err() != nil {
				ch <- TurnEvent{Kind: EventError, Error: ctx.Err(), ErrorText: ctx.Err().Error()}
				return
			}

			if err != nil {
				ch <- TurnEvent{Kind: EventError, Error: err, ErrorText: err.Error()}
				return
			}

			if resp == nil || len(resp.Candidates) == 0 {
				continue
			}

			if resp.UsageMetadata != nil {
				usage = resp.UsageMetadata
			}

			candidate := resp.Candidates[0]
			if candidate.Content == nil {
				continue
			}

			// Emit deltas for each part in this chunk.
			for _, part := range candidate.Content.Parts {
				accumulatedParts = append(accumulatedParts, part)

				// Emit text/thought deltas for real-time streaming.
				if part.Text != "" {
					delta := &StreamDelta{
						Text:      part.Text,
						IsThought: part.Thought,
					}
					ch <- TurnEvent{Kind: EventDelta, Delta: delta}
				}
			}
		}

		// If we got nothing, emit an error.
		if len(accumulatedParts) == 0 {
			ch <- TurnEvent{
				Kind:      EventError,
				Error:     fmt.Errorf("empty response from model"),
				ErrorText: "empty response from model",
			}
			return
		}

		// Assemble the final message from all accumulated parts.
		finalContent := &genai.Content{
			Role:  "model",
			Parts: accumulatedParts,
		}
		msg := ContentToMessage(finalContent)
		msg.State = models.MessageStateCompleted

		if usage != nil {
			msg.Metadata = map[string]any{
				"tokens_input":  usage.PromptTokenCount,
				"tokens_output": usage.CandidatesTokenCount,
				"tokens_cached": usage.CachedContentTokenCount,
				"model":         modelName,
			}
		}

		ch <- TurnEvent{Kind: EventMessageDone, Message: msg}
	}()

	return ch
}

// SendMessage is a convenience wrapper that collects all stream events
// into a single completed message. Useful for non-streaming contexts
// like tests or simple tool execution.
func (c *Client) SendMessage(ctx context.Context, history []*models.Message, config *GenerateContentConfig) (*models.Message, error) {
	var result *models.Message

	for event := range c.StreamMessage(ctx, history, config) {
		switch event.Kind {
		case EventMessageDone:
			if msg, ok := event.Message.(*models.Message); ok {
				result = msg
			}
		case EventError:
			return nil, event.Error
		}
	}

	if result == nil {
		return nil, fmt.Errorf("no message received from stream")
	}
	return result, nil
}
