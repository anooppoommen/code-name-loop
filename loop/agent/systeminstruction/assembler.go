package systeminstruction

import (
	"bytes"
	"embed"
	"encoding/json"
	"fmt"
	"path"
	"strings"
	"sync"
)

//go:embed prompts/variants/*.json
//go:embed prompts/modules/*.md
var promptsFS embed.FS

// Variant represents the expected JSON structure for the prompt config.
type Variant struct {
	ID             string   `json:"id"`
	Name           string   `json:"name"`
	Description    string   `json:"description"`
	Modules        []string `json:"modules"`
	OutputContract []string `json:"outputContract"`
}

var (
	systemPrompt string
	initOnce     sync.Once
)

// Get returns the assembled system instruction text.
func Get() string {
	initOnce.Do(func() {
		systemPrompt = assemble()
	})
	return systemPrompt
}

func assemble() string {
	b, err := promptsFS.ReadFile("prompts/variants/gemini-coding-strict-optimized.v4.json")
	if err != nil {
		panic(fmt.Sprintf("failed to read variant JSON: %v", err))
	}

	var variant Variant
	if err := json.Unmarshal(b, &variant); err != nil {
		panic(fmt.Sprintf("failed to parse variant JSON: %v", err))
	}

	var buf bytes.Buffer

	// Append modules
	for _, modPath := range variant.Modules {
		// Clean the path, e.g., "../modules/identity_and_success_criteria.md"
		// We know they are relative to "prompts/variants", so we join and clean.
		resolved := path.Join("prompts", "variants", modPath)
		resolved = path.Clean(resolved)

		content, err := promptsFS.ReadFile(resolved)
		if err != nil {
			panic(fmt.Sprintf("failed to read module %s (resolved: %s): %v", modPath, resolved, err))
		}

		buf.Write(content)
		buf.WriteString("\n\n")
	}

	// Append output contract
	if len(variant.OutputContract) > 0 {
		buf.WriteString("# Output Contract\n\n")
		for _, contract := range variant.OutputContract {
			buf.WriteString("- " + contract + "\n")
		}
		buf.WriteString("\n")
	}

	return strings.TrimSpace(buf.String())
}
