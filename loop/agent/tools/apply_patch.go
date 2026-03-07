package tools

import (
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

type applyPatchArgs struct {
	Input string `json:"input"`
}

// NewApplyPatchTool creates the apply_patch tool.
func NewApplyPatchTool(ws *models.Workspace) *agent.ToolDef {
	guard := newPathGuard(ws)
	return &agent.ToolDef{
		Declaration: &genai.FunctionDeclaration{
			Name: "apply_patch",
			Description: `Use apply_patch for all workspace file edits (create/update/delete/rename). Do not create temporary patch files or helper scripts via shell/exec_command.

The patch format:

*** Begin Patch
[ one or more file sections ]
*** End Patch

File operations:

*** Add File: <path> - create a new file. Every following line is a + line (the initial contents).
*** Delete File: <path> - remove an existing file. Nothing follows.
*** Update File: <path> - patch an existing file in place.

Optionally followed by *** Move to: <new path> for renames.
Then one or more "hunks", each introduced by @@ (optionally followed by context).
Within a hunk each line starts with:
  (space) context line
  - line to remove
  + line to add

Example:

*** Begin Patch
*** Add File: hello.txt
+Hello world
*** Update File: src/app.py
@@ def greet():
-print("Hi")
+print("Hello, world!")
*** Delete File: obsolete.txt
*** End Patch

Important:
- You must include a header with your intended action (Add/Delete/Update)
- You must prefix new lines with + even when creating a new file
- File references should be relative to the working directory`,
			Parameters: &genai.Schema{
				Type: genai.TypeObject,
				Properties: map[string]*genai.Schema{
					"input": {
						Type:        genai.TypeString,
						Description: "The entire contents of the apply_patch command.",
					},
				},
				Required: []string{"input"},
			},
		},
		Handler: func(ctx context.Context, args json.RawMessage) (json.RawMessage, error) {
			return handleApplyPatch(ctx, args, guard)
		},
		Intents: []string{
			"When creating, deleting or updating a file reach for this tool only",
			"Use this as the default and only mechanism for workspace file modifications",
			"Prefer a single precise patch once the target lines are identified",
			"Do not stage edits through temporary .diff/.py/.js files or shell redirection",
		},
	}
}

func handleApplyPatch(_ context.Context, args json.RawMessage, guard *pathGuard) (json.RawMessage, error) {
	var a applyPatchArgs
	if err := json.Unmarshal(args, &a); err != nil {
		return nil, fmt.Errorf("failed to parse arguments: %w", err)
	}

	input := strings.TrimSpace(a.Input)
	if input == "" {
		return nil, fmt.Errorf("patch input must not be empty")
	}

	cwd := guard.workspaceRoot
	if strings.TrimSpace(cwd) == "" {
		return nil, fmt.Errorf("workspace root path is required")
	}

	result, err := applyPatch(cwd, input, guard)
	if err != nil {
		return json.Marshal(map[string]any{"error": err.Error()})
	}

	return json.Marshal(map[string]any{"output": result})
}

// ApplyPatchWorkspace exposes the patch engine directly for backend use.
func ApplyPatchWorkspace(ws *models.Workspace, patch string) (string, error) {
	return applyPatch(ws.RootPath, patch, newPathGuard(ws))
}

// PlannedFileWrite describes a file write that has been validated and is ready to apply.
type PlannedFileWrite struct {
	AbsPath string
	Content []byte
}

// PlannedFileDelete describes a file deletion that has been validated and is ready to apply.
type PlannedFileDelete struct {
	AbsPath       string
	IgnoreMissing bool
}

// PlannedWorkspaceChange describes a validated filesystem mutation.
type PlannedWorkspaceChange struct {
	Writes  []PlannedFileWrite
	Deletes []PlannedFileDelete
	Summary string
}

// ResolveWorkspacePath resolves a relative path inside the workspace using the patch guard rules.
func ResolveWorkspacePath(ws *models.Workspace, path string) (string, error) {
	if ws == nil {
		return "", fmt.Errorf("workspace is required")
	}
	return resolvePath(ws.RootPath, path, newPathGuard(ws))
}

// PlanPatchWorkspace validates a patch and returns the filesystem changes needed to apply it.
func PlanPatchWorkspace(ws *models.Workspace, patch string) ([]PlannedWorkspaceChange, error) {
	if ws == nil {
		return nil, fmt.Errorf("workspace is required")
	}
	return planPatch(ws.RootPath, patch, newPathGuard(ws))
}

// ApplyPlannedWorkspaceChanges executes a validated set of workspace mutations.
func ApplyPlannedWorkspaceChanges(changes []PlannedWorkspaceChange) (string, error) {
	var summaryParts []string

	for _, change := range changes {
		for _, write := range change.Writes {
			if err := os.MkdirAll(filepath.Dir(write.AbsPath), 0o755); err != nil {
				return "", fmt.Errorf("failed to create directories for %s: %w", write.AbsPath, err)
			}
			if err := os.WriteFile(write.AbsPath, write.Content, 0o644); err != nil {
				return "", fmt.Errorf("failed to write file %s: %w", write.AbsPath, err)
			}
		}

		for _, del := range change.Deletes {
			if err := os.Remove(del.AbsPath); err != nil {
				if del.IgnoreMissing && os.IsNotExist(err) {
					continue
				}
				return "", fmt.Errorf("failed to delete file %s: %w", del.AbsPath, err)
			}
		}

		if strings.TrimSpace(change.Summary) != "" {
			summaryParts = append(summaryParts, change.Summary)
		}
	}

	if len(summaryParts) == 0 {
		return "No changes applied.", nil
	}
	return strings.Join(summaryParts, "\n"), nil
}

// applyPatch parses and applies a patch, returning a summary of changes.
func applyPatch(cwd string, input string, guard *pathGuard) (string, error) {
	changes, err := planPatch(cwd, input, guard)
	if err != nil {
		return "", err
	}
	return ApplyPlannedWorkspaceChanges(changes)
}

func planPatch(cwd string, input string, guard *pathGuard) ([]PlannedWorkspaceChange, error) {
	lines := strings.Split(input, "\n")

	// Validate envelope.
	if len(lines) < 2 {
		return nil, fmt.Errorf("patch must contain *** Begin Patch and *** End Patch")
	}

	firstLine := strings.TrimSpace(lines[0])
	if firstLine != "*** Begin Patch" {
		return nil, fmt.Errorf("patch must start with '*** Begin Patch', got: %q", firstLine)
	}

	// Find *** End Patch.
	endIdx := -1
	for i := len(lines) - 1; i >= 0; i-- {
		if strings.TrimSpace(lines[i]) == "*** End Patch" {
			endIdx = i
			break
		}
	}
	if endIdx < 0 {
		return nil, fmt.Errorf("patch must end with '*** End Patch'")
	}

	body := lines[1:endIdx]

	var changes []PlannedWorkspaceChange
	i := 0
	for i < len(body) {
		line := body[i]
		trimmed := strings.TrimSpace(line)

		if trimmed == "" {
			i++
			continue
		}

		if strings.HasPrefix(trimmed, "*** Add File:") {
			path := strings.TrimSpace(strings.TrimPrefix(trimmed, "*** Add File:"))
			i++
			var contentLines []string
			for i < len(body) && !strings.HasPrefix(strings.TrimSpace(body[i]), "***") {
				l := body[i]
				if strings.HasPrefix(l, "+") {
					contentLines = append(contentLines, l[1:])
				}
				i++
			}
			absPath, err := resolvePath(cwd, path, guard)
			if err != nil {
				return nil, err
			}
			content := strings.Join(contentLines, "\n")
			if len(contentLines) > 0 {
				content += "\n"
			}
			changes = append(changes, PlannedWorkspaceChange{
				Writes:  []PlannedFileWrite{{AbsPath: absPath, Content: []byte(content)}},
				Summary: fmt.Sprintf("Added %s", path),
			})

		} else if strings.HasPrefix(trimmed, "*** Delete File:") {
			path := strings.TrimSpace(strings.TrimPrefix(trimmed, "*** Delete File:"))
			absPath, err := resolvePath(cwd, path, guard)
			if err != nil {
				return nil, err
			}
			changes = append(changes, PlannedWorkspaceChange{
				Deletes: []PlannedFileDelete{{AbsPath: absPath, IgnoreMissing: true}},
				Summary: fmt.Sprintf("Deleted %s", path),
			})
			i++

		} else if strings.HasPrefix(trimmed, "*** Update File:") {
			path := strings.TrimSpace(strings.TrimPrefix(trimmed, "*** Update File:"))
			i++

			// Check for optional Move to.
			var moveTo string
			if i < len(body) && strings.HasPrefix(strings.TrimSpace(body[i]), "*** Move to:") {
				moveTo = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(body[i]), "*** Move to:"))
				i++
			}

			// Collect hunks.
			var hunks []hunk
			for i < len(body) && !strings.HasPrefix(strings.TrimSpace(body[i]), "*** ") {
				if strings.HasPrefix(strings.TrimSpace(body[i]), "@@") {
					headerLine := strings.TrimSpace(body[i])
					header := strings.TrimSpace(strings.TrimPrefix(headerLine, "@@"))
					i++
					var hunkLines []hunkLine
					for i < len(body) {
						hl := body[i]
						trimHL := strings.TrimSpace(hl)
						if strings.HasPrefix(trimHL, "@@") || strings.HasPrefix(trimHL, "*** ") {
							break
						}
						if trimHL == "*** End of File" {
							i++
							break
						}
						if len(hl) > 0 {
							switch hl[0] {
							case ' ':
								hunkLines = append(hunkLines, hunkLine{op: opContext, text: hl[1:]})
							case '-':
								hunkLines = append(hunkLines, hunkLine{op: opRemove, text: hl[1:]})
							case '+':
								hunkLines = append(hunkLines, hunkLine{op: opAdd, text: hl[1:]})
							default:
								// Treat as context if no prefix.
								hunkLines = append(hunkLines, hunkLine{op: opContext, text: hl})
							}
						}
						i++
					}
					hunks = append(hunks, hunk{header: header, lines: hunkLines})
				} else {
					i++
				}
			}

			absPath, err := resolvePath(cwd, path, guard)
			if err != nil {
				return nil, err
			}
			data, err := os.ReadFile(absPath)
			if err != nil {
				return nil, fmt.Errorf("failed to read file %s for update: %w", path, err)
			}

			fileLines := strings.Split(string(data), "\n")
			// Remove trailing empty line from Split if file ends with newline.
			if len(fileLines) > 0 && fileLines[len(fileLines)-1] == "" {
				fileLines = fileLines[:len(fileLines)-1]
			}

			for _, h := range hunks {
				var err error
				fileLines, err = applyHunk(fileLines, h)
				if err != nil {
					return nil, fmt.Errorf("failed to apply hunk to %s: %w", path, err)
				}
			}

			newContent := strings.Join(fileLines, "\n") + "\n"

			if moveTo != "" {
				absMoveTo, err := resolvePath(cwd, moveTo, guard)
				if err != nil {
					return nil, err
				}
				changes = append(changes, PlannedWorkspaceChange{
					Writes:  []PlannedFileWrite{{AbsPath: absMoveTo, Content: []byte(newContent)}},
					Deletes: []PlannedFileDelete{{AbsPath: absPath}},
					Summary: fmt.Sprintf("Updated %s → %s", path, moveTo),
				})
			} else {
				changes = append(changes, PlannedWorkspaceChange{
					Writes:  []PlannedFileWrite{{AbsPath: absPath, Content: []byte(newContent)}},
					Summary: fmt.Sprintf("Updated %s", path),
				})
			}

		} else {
			return nil, fmt.Errorf("unexpected line in patch: %q", trimmed)
		}
	}

	return changes, nil
}

type hunkOp int

const (
	opContext hunkOp = iota
	opRemove
	opAdd
)

type hunkLine struct {
	op   hunkOp
	text string
}

type hunk struct {
	header string
	lines  []hunkLine
}

// applyHunk applies a single hunk to file lines.
// It finds the context/remove lines in the file and applies the changes.
func applyHunk(fileLines []string, h hunk) ([]string, error) {
	// Build the search pattern: context and remove lines in order.
	var searchLines []string
	for _, hl := range h.lines {
		if hl.op == opContext || hl.op == opRemove {
			searchLines = append(searchLines, hl.text)
		}
	}

	if len(searchLines) == 0 {
		// No context/remove lines — pure addition. Append to end.
		for _, hl := range h.lines {
			if hl.op == opAdd {
				fileLines = append(fileLines, hl.text)
			}
		}
		return fileLines, nil
	}

	// Find the best match position.
	matchIdx := findBestMatch(fileLines, searchLines, h.header)
	if matchIdx < 0 {
		return nil, fmt.Errorf("could not find matching location for hunk (context: %q)", searchLines[0])
	}

	// Apply the hunk at matchIdx.
	var result []string
	result = append(result, fileLines[:matchIdx]...)

	searchPos := matchIdx
	for _, hl := range h.lines {
		switch hl.op {
		case opContext:
			if searchPos < len(fileLines) {
				result = append(result, fileLines[searchPos])
				searchPos++
			}
		case opRemove:
			// Skip this line from the file.
			searchPos++
		case opAdd:
			result = append(result, hl.text)
		}
	}

	result = append(result, fileLines[searchPos:]...)
	return result, nil
}

// findBestMatch finds the best position where searchLines match in fileLines.
// If header contains context (e.g., class/function name), it narrows the search.
func findBestMatch(fileLines []string, searchLines []string, header string) int {
	if len(searchLines) == 0 {
		return len(fileLines)
	}

	// If header is provided, find a starting region.
	startFrom := 0
	if header != "" {
		headers := strings.Split(header, "\n")
		for _, h := range headers {
			h = strings.TrimSpace(h)
			if h == "" {
				continue
			}
			// Find first line containing this header text.
			for j := startFrom; j < len(fileLines); j++ {
				if strings.Contains(strings.TrimSpace(fileLines[j]), h) {
					startFrom = j
					break
				}
			}
		}
	}

	// Search for the first line of searchLines starting from startFrom.
	for i := startFrom; i <= len(fileLines)-len(searchLines); i++ {
		if matchesAt(fileLines, i, searchLines) {
			return i
		}
	}

	// Fallback: search from beginning if header-based search failed.
	if startFrom > 0 {
		for i := 0; i < startFrom && i <= len(fileLines)-len(searchLines); i++ {
			if matchesAt(fileLines, i, searchLines) {
				return i
			}
		}
	}

	return -1
}

func matchesAt(fileLines []string, pos int, searchLines []string) bool {
	for k, sl := range searchLines {
		if pos+k >= len(fileLines) {
			return false
		}
		if strings.TrimRight(fileLines[pos+k], " \t") != strings.TrimRight(sl, " \t") {
			return false
		}
	}
	return true
}

func resolvePath(cwd, path string, guard *pathGuard) (string, error) {
	if filepath.IsAbs(path) {
		return guard.requireAllowedPath(path)
	}
	return guard.resolveForPatch(filepath.Join(cwd, path))
}
