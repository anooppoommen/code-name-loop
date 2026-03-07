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
	systemPrompt   string
	defaultVariant Variant
	initErr        error
	initOnce       sync.Once
)

const defaultVariantFile = "prompts/variants/gemini-coding-strict-optimized.v7.json"

// Get returns the assembled system instruction text.
func Get() string {
	initDefaultVariant()
	if initErr != nil {
		panic(initErr)
	}
	return systemPrompt
}

// DefaultVariant returns metadata for the currently configured default prompt.
func DefaultVariant() Variant {
	initDefaultVariant()
	if initErr != nil {
		panic(initErr)
	}
	return defaultVariant
}

// GetVariant assembles a specific embedded prompt variant.
// The variantPath may be a bare filename present in prompts/variants
// or a full embedded path such as prompts/variants/foo.json.
func GetVariant(variantPath string) (string, error) {
	return assembleVariant(variantPath)
}

// GetVariantMetadata returns the parsed metadata for an embedded prompt variant.
func GetVariantMetadata(variantPath string) (Variant, error) {
	return loadVariant(variantPath)
}

func mustAssemble(variantPath string) string {
	prompt, err := assembleVariant(variantPath)
	if err != nil {
		panic(err)
	}
	return prompt
}

func assembleVariant(variantPath string) (string, error) {
	variant, err := loadVariant(variantPath)
	if err != nil {
		return "", err
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
			return "", fmt.Errorf("failed to read module %s (resolved: %s): %w", modPath, resolved, err)
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

	return strings.TrimSpace(buf.String()), nil
}

func initDefaultVariant() {
	initOnce.Do(func() {
		var err error
		defaultVariant, err = loadVariant(defaultVariantFile)
		if err != nil {
			initErr = err
			return
		}
		systemPrompt, initErr = assembleVariant(defaultVariantFile)
	})
}

func loadVariant(variantPath string) (Variant, error) {
	resolvedVariantPath := resolveVariantPath(variantPath)
	b, err := promptsFS.ReadFile(resolvedVariantPath)
	if err != nil {
		return Variant{}, fmt.Errorf("failed to read variant JSON %s: %w", resolvedVariantPath, err)
	}

	var variant Variant
	if err := json.Unmarshal(b, &variant); err != nil {
		return Variant{}, fmt.Errorf("failed to parse variant JSON %s: %w", resolvedVariantPath, err)
	}
	return variant, nil
}

func resolveVariantPath(variantPath string) string {
	trimmed := strings.TrimSpace(variantPath)
	if trimmed == "" {
		return defaultVariantFile
	}
	if strings.HasPrefix(trimmed, "prompts/variants/") {
		return trimmed
	}
	return path.Join("prompts/variants", trimmed)
}
