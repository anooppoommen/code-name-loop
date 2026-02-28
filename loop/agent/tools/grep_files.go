package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"loop/agent"

	"google.golang.org/genai"
)

const (
	grepDefaultLimit   = 100
	grepMaxLimit       = 2000
	grepCommandTimeout = 30 * time.Second
)

type grepFilesArgs struct {
	Pattern string `json:"pattern"`
	Include string `json:"include,omitempty"`
	Path    string `json:"path,omitempty"`
	Limit   *int   `json:"limit,omitempty"`
}

// NewGrepFilesTool creates the grep_files tool.
func NewGrepFilesTool() *agent.ToolDef {
	return &agent.ToolDef{
		Declaration: &genai.FunctionDeclaration{
			Name:        "grep_files",
			Description: "Finds files whose contents match the pattern and lists them by modification time.",
			Parameters: &genai.Schema{
				Type: genai.TypeObject,
				Properties: map[string]*genai.Schema{
					"pattern": {
						Type:        genai.TypeString,
						Description: "Regular expression pattern to search for.",
					},
					"include": {
						Type:        genai.TypeString,
						Description: `Optional glob that limits which files are searched (e.g. "*.rs" or "*.{ts,tsx}").`,
					},
					"path": {
						Type:        genai.TypeString,
						Description: "Directory or file path to search. Defaults to the session's working directory.",
					},
					"limit": {
						Type:        genai.TypeInteger,
						Description: "Maximum number of file paths to return (defaults to 100).",
					},
				},
				Required: []string{"pattern"},
			},
		},
		Handler: handleGrepFiles,
	}
}

func handleGrepFiles(ctx context.Context, args json.RawMessage) (json.RawMessage, error) {
	var a grepFilesArgs
	if err := json.Unmarshal(args, &a); err != nil {
		return nil, fmt.Errorf("failed to parse arguments: %w", err)
	}

	pattern := strings.TrimSpace(a.Pattern)
	if pattern == "" {
		return nil, fmt.Errorf("pattern must not be empty")
	}

	limit := grepDefaultLimit
	if a.Limit != nil {
		limit = *a.Limit
	}
	if limit < 1 {
		return nil, fmt.Errorf("limit must be greater than zero")
	}
	if limit > grepMaxLimit {
		limit = grepMaxLimit
	}

	searchPath := a.Path
	if searchPath == "" {
		cwd, err := os.Getwd()
		if err != nil {
			return nil, fmt.Errorf("failed to get working directory: %w", err)
		}
		searchPath = cwd
	}

	if !filepath.IsAbs(searchPath) {
		cwd, _ := os.Getwd()
		searchPath = filepath.Join(cwd, searchPath)
	}

	// Verify path exists.
	if _, err := os.Stat(searchPath); err != nil {
		return nil, fmt.Errorf("unable to access %q: %w", searchPath, err)
	}

	include := strings.TrimSpace(a.Include)

	results, err := runRgSearch(ctx, pattern, include, searchPath, limit)
	if err != nil {
		return nil, err
	}

	if len(results) == 0 {
		return json.Marshal(map[string]any{
			"output":  "No matches found.",
			"success": false,
		})
	}

	return json.Marshal(map[string]any{
		"output":  strings.Join(results, "\n"),
		"success": true,
	})
}

func runRgSearch(ctx context.Context, pattern string, include string, searchPath string, limit int) ([]string, error) {
	ctx, cancel := context.WithTimeout(ctx, grepCommandTimeout)
	defer cancel()

	args := []string{
		"--files-with-matches",
		"--sortr=modified",
		"--regexp", pattern,
		"--no-messages",
	}
	if include != "" {
		args = append(args, "--glob", include)
	}
	args = append(args, "--", searchPath)

	cmd := exec.CommandContext(ctx, "rg", args...)
	output, err := cmd.Output()

	if err != nil {
		if ctx.Err() != nil {
			return nil, fmt.Errorf("rg timed out after 30 seconds")
		}
		// Exit code 1 means no matches — that's OK.
		if exitErr, ok := err.(*exec.ExitError); ok && exitErr.ExitCode() == 1 {
			return nil, nil
		}
		// rg not found — try grep fallback.
		if isNotFound(err) {
			return runGrepFallback(ctx, pattern, include, searchPath, limit)
		}
		return nil, fmt.Errorf("rg failed: %w", err)
	}

	return parseSearchResults(output, limit), nil
}

func runGrepFallback(ctx context.Context, pattern string, include string, searchPath string, limit int) ([]string, error) {
	args := []string{"-rl", pattern}
	if include != "" {
		args = append(args, "--include", include)
	}
	args = append(args, searchPath)

	cmd := exec.CommandContext(ctx, "grep", args...)
	output, err := cmd.Output()
	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok && exitErr.ExitCode() == 1 {
			return nil, nil
		}
		return nil, fmt.Errorf("grep failed: %w", err)
	}

	return parseSearchResults(output, limit), nil
}

func parseSearchResults(output []byte, limit int) []string {
	var results []string
	for _, line := range strings.Split(string(output), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		results = append(results, line)
		if len(results) >= limit {
			break
		}
	}
	return results
}

func isNotFound(err error) bool {
	return strings.Contains(err.Error(), "executable file not found") ||
		strings.Contains(err.Error(), "no such file or directory")
}
