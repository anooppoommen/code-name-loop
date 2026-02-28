package agent

import (
	"encoding/base64"
	"encoding/json"
	"strings"

	"google.golang.org/genai"

	"loop/models"
)

type partEncodeOptions struct {
	includeThoughtPart bool
	includeThoughtText bool
	includeInlineBlob  bool
}

var defaultPartEncodeOptions = partEncodeOptions{
	includeThoughtPart: true,
	includeThoughtText: true,
	includeInlineBlob:  true,
}

// MessagesToContents converts a slice of domain messages into Gemini API
// Content objects, preserving part ordering, thought signatures, and the
// parallel tool-call invariant (all calls before responses).
func MessagesToContents(messages []*models.Message) []*genai.Content {
	return messagesToContentsWithOptions(messages, func(_ int, _ *models.Message) partEncodeOptions {
		return defaultPartEncodeOptions
	})
}

// MessagesToModelContents converts persisted history into model request
// contents with token-efficient pruning:
//   - Thought parts are omitted from upstream payload.
//   - Inline blobs are included only on the tail message.
//
// This keeps required protocol data while avoiding repeated large payloads.
func MessagesToModelContents(messages []*models.Message) []*genai.Content {
	lastIdx := len(messages) - 1
	return messagesToContentsWithOptions(messages, func(idx int, _ *models.Message) partEncodeOptions {
		return partEncodeOptions{
			includeThoughtPart: false,
			includeThoughtText: false,
			includeInlineBlob:  idx == lastIdx,
		}
	})
}

func messagesToContentsWithOptions(messages []*models.Message, partOpts func(idx int, msg *models.Message) partEncodeOptions) []*genai.Content {
	var contents []*genai.Content
	for i, msg := range messages {
		if msg == nil {
			continue
		}

		parts := partsToGenAIWithOptions(msg.Parts, partOpts(i, msg))
		if len(parts) == 0 {
			continue
		}

		content := &genai.Content{
			Role:  senderToRole(msg.SentBy),
			Parts: parts,
		}
		contents = append(contents, content)
	}
	return contents
}

// ContentToMessage converts a Gemini API Content object back to our
// domain Message, preserving all part data including thought signatures.
func ContentToMessage(content *genai.Content) *models.Message {
	msg := &models.Message{
		SentBy: roleToSender(content.Role),
		Parts:  partsFromGenAI(content.Parts),
	}
	return msg
}

// ----- Role mapping -----

func senderToRole(s models.Sender) string {
	switch s {
	case models.SentByUser:
		return "user"
	case models.SentByAgent:
		return "model"
	case models.SentByTool:
		// Tool responses are sent as "user" role in Gemini protocol,
		// but the domain model tracks them as "tool" sender.
		return "user"
	default:
		return "user"
	}
}

func roleToSender(role string) models.Sender {
	switch role {
	case "model":
		return models.SentByAgent
	case "user":
		return models.SentByUser
	default:
		return models.SentByUser
	}
}

// ----- Part conversion: domain → genai -----

func partsToGenAI(parts []models.MessagePart) []*genai.Part {
	return partsToGenAIWithOptions(parts, defaultPartEncodeOptions)
}

func partsToGenAIWithOptions(parts []models.MessagePart, opts partEncodeOptions) []*genai.Part {
	var gparts []*genai.Part
	for _, p := range parts {
		gp := partToGenAIWithOptions(p, opts)
		if gp != nil {
			gparts = append(gparts, gp)
		}
	}
	return gparts
}

func partToGenAI(p models.MessagePart) *genai.Part {
	return partToGenAIWithOptions(p, defaultPartEncodeOptions)
}

func partToGenAIWithOptions(p models.MessagePart, opts partEncodeOptions) *genai.Part {
	var gp *genai.Part

	switch p.Kind {
	case models.PartText:
		if p.Text != nil && strings.TrimSpace(p.Text.Text) != "" {
			gp = genai.NewPartFromText(p.Text.Text)
		}

	case models.PartThought:
		if !opts.includeThoughtPart {
			break
		}
		if p.Thought != nil {
			thoughtText := p.Thought.Text
			if !opts.includeThoughtText {
				thoughtText = ""
			}
			gp = &genai.Part{
				Text:    thoughtText,
				Thought: true,
			}
		}

	case models.PartFunctionCall:
		if p.FunctionCall != nil {
			args := make(map[string]any)
			if len(p.FunctionCall.ArgsJSON) > 0 {
				json.Unmarshal(p.FunctionCall.ArgsJSON, &args)
			}
			gp = &genai.Part{
				FunctionCall: &genai.FunctionCall{
					ID:   p.FunctionCall.CallID,
					Name: p.FunctionCall.Name,
					Args: args,
				},
			}
		}

	case models.PartFunctionResponse:
		if p.FunctionResponse != nil {
			resp := make(map[string]any)
			if len(p.FunctionResponse.ResponseJSON) > 0 {
				json.Unmarshal(p.FunctionResponse.ResponseJSON, &resp)
			}
			gp = &genai.Part{
				FunctionResponse: &genai.FunctionResponse{
					ID:       p.FunctionResponse.CallID,
					Name:     p.FunctionResponse.Name,
					Response: resp,
				},
			}
		}

	case models.PartFileRef:
		if p.FileRef != nil {
			gp = &genai.Part{
				FileData: &genai.FileData{
					FileURI:  p.FileRef.URI,
					MIMEType: p.FileRef.MIMEType,
				},
			}
		}

	case models.PartInlineBlob:
		if !opts.includeInlineBlob {
			break
		}
		if p.InlineBlob != nil && p.InlineBlob.Data != "" {
			b, err := base64.StdEncoding.DecodeString(p.InlineBlob.Data)
			if err == nil {
				gp = &genai.Part{
					InlineData: &genai.Blob{
						MIMEType: p.InlineBlob.MIMEType,
						Data:     b,
					},
				}
			}
		}

	case models.PartExecutableCode:
		if p.ExecutableCode != nil {
			gp = &genai.Part{
				ExecutableCode: &genai.ExecutableCode{
					Language: genai.Language(p.ExecutableCode.Language),
					Code:     p.ExecutableCode.Code,
				},
			}
		}

	case models.PartCodeExecResult:
		if p.CodeExecResult != nil {
			gp = &genai.Part{
				CodeExecutionResult: &genai.CodeExecutionResult{
					Outcome: genai.Outcome(p.CodeExecResult.Outcome),
					Output:  p.CodeExecResult.Output,
				},
			}
		}
	}

	// Preserve thought signature exactly as received — critical for Gemini 3+.
	if gp != nil && len(p.ThoughtSignature) > 0 {
		gp.ThoughtSignature = p.ThoughtSignature
	}

	return gp
}

// ----- Part conversion: genai → domain -----

func partsFromGenAI(gparts []*genai.Part) []models.MessagePart {
	var parts []models.MessagePart
	for _, gp := range gparts {
		if gp == nil || isEmptyGenAIPart(gp) {
			continue
		}
		p := partFromGenAI(gp)
		parts = append(parts, p)
	}
	return parts
}

func partFromGenAI(gp *genai.Part) models.MessagePart {
	mp := models.MessagePart{
		ThoughtSignature: gp.ThoughtSignature,
	}

	switch {
	case gp.FunctionCall != nil:
		mp.Kind = models.PartFunctionCall
		argsJSON, _ := json.Marshal(gp.FunctionCall.Args)
		mp.FunctionCall = &models.FunctionCallPart{
			CallID:   gp.FunctionCall.ID,
			Name:     gp.FunctionCall.Name,
			ArgsJSON: argsJSON,
		}

	case gp.FunctionResponse != nil:
		mp.Kind = models.PartFunctionResponse
		respJSON, _ := json.Marshal(gp.FunctionResponse.Response)
		mp.FunctionResponse = &models.FunctionResponsePart{
			CallID:       gp.FunctionResponse.ID,
			Name:         gp.FunctionResponse.Name,
			ResponseJSON: respJSON,
		}

	case gp.ExecutableCode != nil:
		mp.Kind = models.PartExecutableCode
		mp.ExecutableCode = &models.ExecutableCodePart{
			Language: string(gp.ExecutableCode.Language),
			Code:     gp.ExecutableCode.Code,
		}

	case gp.CodeExecutionResult != nil:
		mp.Kind = models.PartCodeExecResult
		mp.CodeExecResult = &models.CodeExecutionResultPart{
			Outcome: string(gp.CodeExecutionResult.Outcome),
			Output:  gp.CodeExecutionResult.Output,
		}

	case gp.FileData != nil:
		mp.Kind = models.PartFileRef
		mp.FileRef = &models.FileRefPart{
			URI:      gp.FileData.FileURI,
			MIMEType: gp.FileData.MIMEType,
		}

	case gp.InlineData != nil:
		mp.Kind = models.PartInlineBlob
		mp.InlineBlob = &models.InlineBlobPart{
			MIMEType: gp.InlineData.MIMEType,
			Data:     base64.StdEncoding.EncodeToString(gp.InlineData.Data),
		}

	case gp.Thought:
		mp.Kind = models.PartThought
		mp.Thought = &models.ThoughtPart{
			Text: gp.Text,
		}

	default:
		// Default to text for any text-bearing part.
		mp.Kind = models.PartText
		mp.Text = &models.TextPart{
			Text: gp.Text,
		}
	}

	return mp
}

func isEmptyGenAIPart(gp *genai.Part) bool {
	return gp.FunctionCall == nil &&
		gp.FunctionResponse == nil &&
		gp.ExecutableCode == nil &&
		gp.CodeExecutionResult == nil &&
		gp.FileData == nil &&
		gp.InlineData == nil &&
		!gp.Thought &&
		strings.TrimSpace(gp.Text) == ""
}
