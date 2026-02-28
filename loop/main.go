package main

import (
	"context"
	"fmt"
	"log"
	"net/http"

	"loop/agent"
	"loop/agent/tools"
	"loop/handlers"
	"loop/lib"
	"loop/store/sqlite"
)

func main() {
	// Load configuration from .env / environment variables.
	cfg := LoadConfig()

	// Initialize the SQLite store with WAL mode.
	s, err := sqlite.New(cfg.DBPath)
	if err != nil {
		log.Fatalf("Failed to initialize store: %v", err)
	}
	defer s.Close()

	// Initialize the Gemini API client.
	ctx := context.Background()
	geminiClient, err := agent.NewClient(ctx, cfg.GeminiAPIKey, agent.WithModel(cfg.Model))
	if err != nil {
		log.Fatalf("Failed to initialize Gemini client: %v", err)
	}

	// Initialize the process manager for background tool sessions.
	pm := tools.NewProcessManager()
	defer pm.Cleanup()

	// Create a new ServeMux.
	mux := http.NewServeMux()

	// Register existing routes.
	mux.HandleFunc("GET /", handlers.HandleRoot)
	mux.HandleFunc("GET /health", handlers.HandleHealth)

	// Register domain handlers.
	handlers.NewWorkspaceHandler(s, cfg.Model).RegisterRoutes(mux)
	handlers.NewConversationHandler(s, geminiClient, pm).RegisterRoutes(mux)

	// Apply middleware and start server.
	handler := lib.Logger(mux.ServeHTTP)

	fmt.Printf("Server starting on port %s (db: %s, model: %s)\n", cfg.Port, cfg.DBPath, cfg.Model)
	if err := http.ListenAndServe(cfg.Port, handler); err != nil {
		log.Fatalf("Server failed to start: %v", err)
	}
}
