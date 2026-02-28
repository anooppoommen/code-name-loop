package agent

import "testing"

func TestBuildGenaiConfig_IncludeThoughtsWhenNilConfig(t *testing.T) {
	c := &Client{}
	cfg := c.buildGenaiConfig(nil)
	if cfg.ThinkingConfig == nil {
		t.Fatalf("thinking config should be set")
	}
	if !cfg.ThinkingConfig.IncludeThoughts {
		t.Fatalf("IncludeThoughts should be true")
	}
}

func TestBuildGenaiConfig_IncludeThoughtsWhenProvidedConfig(t *testing.T) {
	c := &Client{}
	cfg := c.buildGenaiConfig(&GenerateContentConfig{})
	if cfg.ThinkingConfig == nil {
		t.Fatalf("thinking config should be set")
	}
	if !cfg.ThinkingConfig.IncludeThoughts {
		t.Fatalf("IncludeThoughts should be true")
	}
}
