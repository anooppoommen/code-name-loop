// Package agent provides the Gemini API client for the coding agent.
// It wraps google.golang.org/genai and provides methods to send
// conversation history and receive model responses, translating between
// the internal models.Message representation and Gemini Content/Part protocol.
package agent

import (
	"context"
	"fmt"

	"google.golang.org/genai"

	"loop/models"
)

// DefaultModel is the Gemini model used when none is specified.
const DefaultModel = "gemini-3.1-pro-preview"

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
	// SystemInstruction is the system prompt for the model.
	SystemInstruction string
	// Temperature controls randomness (0.0 = deterministic, 2.0 = very random).
	Temperature *float32
	// Tools are the genai tool declarations available to the model.
	Tools []*genai.Tool
}

func (c *Client) buildGenaiConfig(config *GenerateContentConfig) *genai.GenerateContentConfig {
	if config == nil {
		return &genai.GenerateContentConfig{
			ThinkingConfig: &genai.ThinkingConfig{
				IncludeThoughts: true,
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
	// Always request thought parts when supported so they can be streamed and
	// persisted as PartThought entries in conversation history.
	genaiConfig.ThinkingConfig = &genai.ThinkingConfig{
		IncludeThoughts: true,
	}

	return genaiConfig
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

		contents := MessagesToContents(history)
		genaiConfig := c.buildGenaiConfig(config)

		// Use the streaming API: returns iter.Seq2[*GenerateContentResponse, error].
		var accumulatedParts []*genai.Part

		for resp, err := range c.genai.Models.GenerateContentStream(ctx, c.model, contents, genaiConfig) {
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
