package tools

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"loop/agent"
	"loop/models"

	"google.golang.org/genai"
)

const (
	readFileMaxLineLength = 500
	readFileDefaultOffset = 1
	readFileDefaultLimit  = 2000
)

type readFileArgs struct {
	FilePath string `json:"file_path"`
	Offset   *int   `json:"offset,omitempty"`
	Limit    *int   `json:"limit,omitempty"`
}

// NewReadFileTool creates the read_file tool (slice mode).
func NewReadFileTool(ws *models.Workspace) *agent.ToolDef {
	guard := newPathGuard(ws)
	return &agent.ToolDef{
		Declaration: &genai.FunctionDeclaration{
			Name:        "read_file",
			Description: "Reads a local file with 1-indexed line numbers, supporting slice mode. Prefer this over shell cat/sed for direct file inspection.",
			Parameters: &genai.Schema{
				Type: genai.TypeObject,
				Properties: map[string]*genai.Schema{
					"file_path": {
						Type:        genai.TypeString,
						Description: "Absolute path or workspace-relative path to the file.",
					},
					"offset": {
						Type:        genai.TypeInteger,
						Description: "The line number to start reading from. Must be 1 or greater.",
					},
					"limit": {
						Type:        genai.TypeInteger,
						Description: "The maximum number of lines to return.",
					},
				},
				Required: []string{"file_path"},
			},
		},
		Handler: func(ctx context.Context, args json.RawMessage) (json.RawMessage, error) {
			return handleReadFile(ctx, args, guard)
		},
		Intents: []string{
			"Use as the default first choice for reading known files",
			"Use for targeted file reads instead of shell cat/sed",
			"Use offset/limit to keep context tight and token-efficient",
		},
	}
}

func handleReadFile(_ context.Context, args json.RawMessage, guard *pathGuard) (json.RawMessage, error) {
	var a readFileArgs
	if err := json.Unmarshal(args, &a); err != nil {
		return nil, fmt.Errorf("failed to parse arguments: %w", err)
	}

	if a.FilePath == "" {
		return nil, fmt.Errorf("file_path is required")
	}

	filePath := a.FilePath
	if !filepath.IsAbs(filePath) {
		filePath = filepath.Join(guard.workspaceRoot, filePath)
	}

	offset := readFileDefaultOffset
	if a.Offset != nil {
		offset = *a.Offset
	}
	if offset < 1 {
		return nil, fmt.Errorf("offset must be a 1-indexed line number")
	}

	limit := readFileDefaultLimit
	if a.Limit != nil {
		limit = *a.Limit
	}
	if limit < 1 {
		return nil, fmt.Errorf("limit must be greater than zero")
	}

	filePath, err := guard.requireAllowedPath(filePath)
	if err != nil {
		return nil, err
	}

	file, err := os.Open(filePath)
	if err != nil {
		return nil, fmt.Errorf("failed to read file: %w", err)
	}
	defer file.Close()

	scanner := bufio.NewScanner(file)
	// Increase buffer for long lines.
	scanner.Buffer(make([]byte, 64*1024), 1024*1024)

	var collected []string
	lineNum := 0

	for scanner.Scan() {
		lineNum++
		if lineNum < offset {
			continue
		}
		if len(collected) >= limit {
			break
		}

		line := scanner.Text()
		// Strip CR for CRLF files.
		line = strings.TrimRight(line, "\r")
		// Truncate long lines.
		if len(line) > readFileMaxLineLength {
			line = line[:readFileMaxLineLength]
		}

		collected = append(collected, fmt.Sprintf("L%d: %s", lineNum, line))
	}

	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("failed to read file: %w", err)
	}

	if lineNum < offset {
		return nil, fmt.Errorf("offset exceeds file length")
	}

	return json.Marshal(map[string]any{"output": strings.Join(collected, "\n")})
}
