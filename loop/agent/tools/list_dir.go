package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"loop/agent"
	"loop/models"

	"google.golang.org/genai"
)

const (
	listDirDefaultOffset     = 1
	listDirDefaultLimit      = 25
	listDirDefaultDepth      = 2
	listDirMaxEntryLength    = 500
	listDirIndentationSpaces = 2
)

type listDirArgs struct {
	DirPath string `json:"dir_path"`
	Offset  *int   `json:"offset,omitempty"`
	Limit   *int   `json:"limit,omitempty"`
	Depth   *int   `json:"depth,omitempty"`
}

// NewListDirTool creates the list_dir tool.
func NewListDirTool(ws *models.Workspace) *agent.ToolDef {
	guard := newPathGuard(ws)
	return &agent.ToolDef{
		Declaration: &genai.FunctionDeclaration{
			Name:        "list_dir",
			Description: "Lists entries in a local directory with 1-indexed entry numbers and simple type labels. Prefer this over shell ls/find for quick structure inspection.",
			Parameters: &genai.Schema{
				Type: genai.TypeObject,
				Properties: map[string]*genai.Schema{
					"dir_path": {
						Type:        genai.TypeString,
						Description: "Absolute path or workspace-relative path to the directory to list.",
					},
					"offset": {
						Type:        genai.TypeInteger,
						Description: "The entry number to start listing from. Must be 1 or greater.",
					},
					"limit": {
						Type:        genai.TypeInteger,
						Description: "The maximum number of entries to return.",
					},
					"depth": {
						Type:        genai.TypeInteger,
						Description: "The maximum directory depth to traverse. Must be 1 or greater.",
					},
				},
				Required: []string{"dir_path"},
			},
		},
		Handler: func(ctx context.Context, args json.RawMessage) (json.RawMessage, error) {
			return handleListDir(ctx, args, guard)
		},
		Intents: []string{
			"Use as the default first step for directory/repo structure discovery",
			"Use for directory discovery before targeted reads",
			"Prefer depth-limited listing to avoid broad shell scans",
		},
	}
}

type dirEntry struct {
	name        string // Relative path for sorting.
	displayName string // Basename for display.
	depth       int
	kind        dirEntryKind
}

type dirEntryKind int

const (
	kindFile dirEntryKind = iota
	kindDirectory
	kindSymlink
	kindOther
)

func handleListDir(_ context.Context, args json.RawMessage, guard *pathGuard) (json.RawMessage, error) {
	var a listDirArgs
	if err := json.Unmarshal(args, &a); err != nil {
		return nil, fmt.Errorf("failed to parse arguments: %w", err)
	}

	if a.DirPath == "" {
		return nil, fmt.Errorf("dir_path is required")
	}

	dirPath := a.DirPath
	if !filepath.IsAbs(dirPath) {
		dirPath = filepath.Join(guard.workspaceRoot, dirPath)
	}
	dirPath, err := guard.requireAllowedPath(dirPath)
	if err != nil {
		return nil, err
	}

	offset := listDirDefaultOffset
	if a.Offset != nil {
		offset = *a.Offset
	}
	if offset < 1 {
		return nil, fmt.Errorf("offset must be a 1-indexed entry number")
	}

	limit := listDirDefaultLimit
	if a.Limit != nil {
		limit = *a.Limit
	}
	if limit < 1 {
		return nil, fmt.Errorf("limit must be greater than zero")
	}

	depth := listDirDefaultDepth
	if a.Depth != nil {
		depth = *a.Depth
	}
	if depth < 1 {
		return nil, fmt.Errorf("depth must be greater than zero")
	}

	entries, err := collectEntries(dirPath, "", depth)
	if err != nil {
		return nil, err
	}

	if len(entries) == 0 {
		return json.Marshal(map[string]any{"output": fmt.Sprintf("Absolute path: %s", dirPath)})
	}

	// Sort by relative name.
	sort.Slice(entries, func(i, j int) bool {
		return entries[i].name < entries[j].name
	})

	startIdx := offset - 1
	if startIdx >= len(entries) {
		return nil, fmt.Errorf("offset exceeds directory entry count")
	}

	remaining := len(entries) - startIdx
	cappedLimit := limit
	if cappedLimit > remaining {
		cappedLimit = remaining
	}
	endIdx := startIdx + cappedLimit
	selected := entries[startIdx:endIdx]

	var output []string
	output = append(output, fmt.Sprintf("Absolute path: %s", dirPath))

	for _, e := range selected {
		output = append(output, formatEntryLine(e))
	}

	if endIdx < len(entries) {
		output = append(output, fmt.Sprintf("More than %d entries found", cappedLimit))
	}

	return json.Marshal(map[string]any{"output": strings.Join(output, "\n")})
}

func collectEntries(dirPath string, relPrefix string, depth int) ([]dirEntry, error) {
	type queueItem struct {
		dir    string
		prefix string
		depth  int
	}

	var entries []dirEntry
	queue := []queueItem{{dir: dirPath, prefix: relPrefix, depth: depth}}

	for len(queue) > 0 {
		item := queue[0]
		queue = queue[1:]

		dirEntries, err := os.ReadDir(item.dir)
		if err != nil {
			return nil, fmt.Errorf("failed to read directory: %w", err)
		}

		// Sort within this level for consistent ordering.
		sort.Slice(dirEntries, func(i, j int) bool {
			return dirEntries[i].Name() < dirEntries[j].Name()
		})

		for _, de := range dirEntries {
			name := de.Name()
			var relPath string
			if item.prefix == "" {
				relPath = name
			} else {
				relPath = item.prefix + "/" + name
			}

			displayName := name
			if len(displayName) > listDirMaxEntryLength {
				displayName = displayName[:listDirMaxEntryLength]
			}

			displayDepth := 0
			if item.prefix != "" {
				displayDepth = strings.Count(item.prefix, "/") + 1
			}

			sortKey := relPath
			if len(sortKey) > listDirMaxEntryLength {
				sortKey = sortKey[:listDirMaxEntryLength]
			}

			kind := entryKind(de)
			entries = append(entries, dirEntry{
				name:        sortKey,
				displayName: displayName,
				depth:       displayDepth,
				kind:        kind,
			})

			if kind == kindDirectory && item.depth > 1 {
				queue = append(queue, queueItem{
					dir:    filepath.Join(item.dir, name),
					prefix: relPath,
					depth:  item.depth - 1,
				})
			}
		}
	}

	return entries, nil
}

func entryKind(de os.DirEntry) dirEntryKind {
	if de.Type()&os.ModeSymlink != 0 {
		return kindSymlink
	}
	if de.IsDir() {
		return kindDirectory
	}
	if de.Type().IsRegular() {
		return kindFile
	}
	return kindOther
}

func formatEntryLine(e dirEntry) string {
	indent := strings.Repeat(" ", e.depth*listDirIndentationSpaces)
	name := e.displayName
	switch e.kind {
	case kindDirectory:
		name += "/"
	case kindSymlink:
		name += "@"
	case kindOther:
		name += "?"
	}
	return indent + name
}
