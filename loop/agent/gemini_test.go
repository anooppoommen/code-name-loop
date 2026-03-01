package agent

import (
	"testing"

	"google.golang.org/genai"
)

func TestBuildGenaiConfig_DefaultThinkingWhenNilConfig(t *testing.T) {
	c := &Client{}
	cfg := c.buildGenaiConfig(nil)
	if cfg.ThinkingConfig == nil {
		t.Fatalf("thinking config should be set")
	}
	if !cfg.ThinkingConfig.IncludeThoughts {
		t.Fatalf("IncludeThoughts should be true by default")
	}
	if cfg.ThinkingConfig.ThinkingLevel != genai.ThinkingLevelMedium {
		t.Fatalf("ThinkingLevel should be MEDIUM, got %q", cfg.ThinkingConfig.ThinkingLevel)
	}
}

func TestBuildGenaiConfig_DefaultThinkingWhenProvidedConfig(t *testing.T) {
	c := &Client{}
	cfg := c.buildGenaiConfig(&GenerateContentConfig{})
	if cfg.ThinkingConfig == nil {
		t.Fatalf("thinking config should be set")
	}
	if !cfg.ThinkingConfig.IncludeThoughts {
		t.Fatalf("IncludeThoughts should be true by default")
	}
	if cfg.ThinkingConfig.ThinkingLevel != genai.ThinkingLevelMedium {
		t.Fatalf("ThinkingLevel should be MEDIUM, got %q", cfg.ThinkingConfig.ThinkingLevel)
	}
}

func TestBuildGenaiConfig_UsesOverrides(t *testing.T) {
	c := &Client{}
	includeThoughts := false
	level := genai.ThinkingLevelHigh
	cfg := c.buildGenaiConfig(&GenerateContentConfig{
		IncludeThoughts: &includeThoughts,
		ThinkingLevel:   &level,
	})

	if cfg.ThinkingConfig == nil {
		t.Fatalf("thinking config should be set")
	}
	if cfg.ThinkingConfig.IncludeThoughts {
		t.Fatalf("IncludeThoughts should respect override=false")
	}
	if cfg.ThinkingConfig.ThinkingLevel != genai.ThinkingLevelHigh {
		t.Fatalf("ThinkingLevel should be HIGH, got %q", cfg.ThinkingConfig.ThinkingLevel)
	}
}

func TestParseThinkingLevel(t *testing.T) {
	tests := []struct {
		input   string
		want    genai.ThinkingLevel
		wantErr bool
	}{
		{input: "", want: genai.ThinkingLevelMedium},
		{input: "minimal", want: genai.ThinkingLevelMinimal},
		{input: "low", want: genai.ThinkingLevelLow},
		{input: "medium", want: genai.ThinkingLevelMedium},
		{input: "high", want: genai.ThinkingLevelHigh},
		{input: "HIGH", want: genai.ThinkingLevelHigh},
		{input: "unknown", wantErr: true},
	}

	for _, tc := range tests {
		got, err := ParseThinkingLevel(tc.input)
		if tc.wantErr {
			if err == nil {
				t.Fatalf("expected error for input %q", tc.input)
			}
			continue
		}
		if err != nil {
			t.Fatalf("unexpected error for input %q: %v", tc.input, err)
		}
		if got != tc.want {
			t.Fatalf("ParseThinkingLevel(%q)=%q, want %q", tc.input, got, tc.want)
		}
	}
}

func TestParseModel(t *testing.T) {
	tests := []struct {
		input   string
		want    string
		wantErr bool
	}{
		{input: "", want: DefaultModel},
		{input: "gemini-3.1-pro-preview", want: ModelGemini31ProPreview},
		{input: "Gemini 3.1 Pro Preview", want: ModelGemini31ProPreview},
		{input: "gemini-3-flash-preview", want: ModelGemini3FlashPreview},
		{input: "gemini-3-flash", want: ModelGemini3FlashPreview},
		{input: "gemini 3 flash", want: ModelGemini3FlashPreview},
		{input: "gemini-3-pro-preview", want: ModelGemini3ProPreview},
		{input: "gemini-3-pro", want: ModelGemini3ProPreview},
		{input: "gemini 3 pro", want: ModelGemini3ProPreview},
		{input: "unknown-model", wantErr: true},
	}

	for _, tc := range tests {
		got, err := ParseModel(tc.input)
		if tc.wantErr {
			if err == nil {
				t.Fatalf("expected error for input %q", tc.input)
			}
			continue
		}
		if err != nil {
			t.Fatalf("unexpected error for input %q: %v", tc.input, err)
		}
		if got != tc.want {
			t.Fatalf("ParseModel(%q)=%q, want %q", tc.input, got, tc.want)
		}
	}
}
