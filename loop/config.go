package main

import (
	"log"
	"os"

	"github.com/joho/godotenv"
)

// Config holds the application configuration, loaded from environment variables.
type Config struct {
	// DBPath is the path to the SQLite database file.
	DBPath string
	// Port is the HTTP server listen address (e.g., ":8080").
	Port string
	// GeminiAPIKey is the API key for the Gemini API.
	GeminiAPIKey string
	// Model is the Gemini model to use (e.g., "gemini-3.1-pro-preview").
	Model string
}

// LoadConfig loads configuration from a .env file (if present) and
// environment variables. Environment variables take precedence over .env.
func LoadConfig() *Config {
	// Load .env file if it exists — does not override existing env vars.
	if err := godotenv.Load(); err != nil {
		log.Println("No .env file found, using existing environment variables")
	}

	cfg := &Config{
		DBPath:       getEnvOr("LOOP_DB_PATH", "loop.db"),
		Port:         getEnvOr("LOOP_PORT", ":8080"),
		GeminiAPIKey: os.Getenv("GEMINI_API_KEY"),
		Model:        getEnvOr("LOOP_MODEL", "gemini-3.1-pro-preview"),
	}

	if cfg.GeminiAPIKey == "" {
		log.Fatal("GEMINI_API_KEY environment variable is required")
	}

	return cfg
}

func getEnvOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
