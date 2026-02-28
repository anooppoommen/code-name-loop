package agent

import (
	"context"

	"loop/models"
)

// ModelClient is the interface used by Session/Turn to interact with the
// language model. It abstracts the streaming API so sessions can be
// tested with mock implementations.
type ModelClient interface {
	// StreamMessage sends conversation history to the model and returns
	// a channel of TurnEvents (deltas, message done, errors).
	StreamMessage(ctx context.Context, history []*models.Message, config *GenerateContentConfig) <-chan TurnEvent
}
