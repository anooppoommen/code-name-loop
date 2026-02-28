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
func NewReadFileTool() *agent.ToolDef {
	return &agent.ToolDef{
		Declaration: &genai.FunctionDeclaration{
			Name:        "read_file",
			Description: "Reads a local file with 1-indexed line numbers, supporting slice mode.",
			Parameters: &genai.Schema{
				Type: genai.TypeObject,
				Properties: map[string]*genai.Schema{
					"file_path": {
						Type:        genai.TypeString,
						Description: "Absolute path to the file.",
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
		Handler: handleReadFile,
	}
}

func handleReadFile(_ context.Context, args json.RawMessage) (json.RawMessage, error) {
	var a readFileArgs
	if err := json.Unmarshal(args, &a); err != nil {
		return nil, fmt.Errorf("failed to parse arguments: %w", err)
	}

	if a.FilePath == "" {
		return nil, fmt.Errorf("file_path is required")
	}

	if !filepath.IsAbs(a.FilePath) {
		return nil, fmt.Errorf("file_path must be an absolute path")
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

	file, err := os.Open(a.FilePath)
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
