package handlers

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"loop/agent"
	"loop/agent/tools"
	"loop/models"
	"loop/store"
	"loop/utils"
)

// ConversationHandler handles conversation REST endpoints.
// Only user-facing endpoints are exposed; internal operations
// (like direct message CRUD) are handled by the agent loop.
type ConversationHandler struct {
	store  store.Store
	client agent.ModelClient
	pm     *tools.ProcessManager
}

func NewConversationHandler(s store.Store, client agent.ModelClient, pm *tools.ProcessManager) *ConversationHandler {
	return &ConversationHandler{store: s, client: client, pm: pm}
}

// RegisterRoutes registers conversation routes on the given mux.
func (h *ConversationHandler) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("POST /conversations", h.Create)
	mux.HandleFunc("GET /conversations/{id}", h.Get)
	mux.HandleFunc("GET /workspaces/{wsID}/conversations", h.ListByWorkspace)
	mux.HandleFunc("GET /conversations/{id}/threads", h.ListThreads)
	mux.HandleFunc("POST /conversations/{id}/reply", h.Reply)
}

func (h *ConversationHandler) Create(w http.ResponseWriter, r *http.Request) {
	var conv models.Conversation
	if err := json.NewDecoder(r.Body).Decode(&conv); err != nil {
		utils.WriteError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if conv.ID == "" {
		utils.WriteError(w, http.StatusBadRequest, "conversation id is required")
		return
	}

	if err := h.store.Conversations().Create(r.Context(), &conv); err != nil {
		if strings.Contains(err.Error(), "UNIQUE constraint") {
			utils.WriteError(w, http.StatusConflict, "conversation already exists")
			return
		}
		utils.WriteError(w, http.StatusInternalServerError, err.Error())
		return
	}

	utils.WriteJSON(w, http.StatusCreated, conv)
}

func (h *ConversationHandler) Get(w http.ResponseWriter, r *http.Request) {
	id := models.ConversationID(r.PathValue("id"))
	conv, err := h.store.Conversations().Get(r.Context(), id)
	if err != nil {
		if strings.Contains(err.Error(), "not found") {
			utils.WriteError(w, http.StatusNotFound, err.Error())
			return
		}
		utils.WriteError(w, http.StatusInternalServerError, err.Error())
		return
	}
	utils.WriteJSON(w, http.StatusOK, conv)
}

func (h *ConversationHandler) ListByWorkspace(w http.ResponseWriter, r *http.Request) {
	wsID := models.WorkspaceID(r.PathValue("wsID"))
	convs, err := h.store.Conversations().ListByWorkspace(r.Context(), wsID)
	if err != nil {
		utils.WriteError(w, http.StatusInternalServerError, err.Error())
		return
	}
	utils.WriteJSON(w, http.StatusOK, convs)
}

func (h *ConversationHandler) ListThreads(w http.ResponseWriter, r *http.Request) {
	id := models.ConversationID(r.PathValue("id"))
	threads, err := h.store.Conversations().ListThreads(r.Context(), id)
	if err != nil {
		utils.WriteError(w, http.StatusInternalServerError, err.Error())
		return
	}
	utils.WriteJSON(w, http.StatusOK, threads)
}

// replyRequest is the JSON body for the Reply endpoint.
type replyRequest struct {
	Message      string `json:"message"`
	SystemPrompt string `json:"system_prompt,omitempty"`
}

// Reply handles user messages and streams the agent's response using SSE.
// This is the primary user-facing endpoint for interacting with the agent.
//
// Request: POST /conversations/{id}/reply
// Body:    {"message": "user text", "system_prompt": "optional"}
// Response: text/event-stream (SSE)
func (h *ConversationHandler) Reply(w http.ResponseWriter, r *http.Request) {
	convID := models.ConversationID(r.PathValue("id"))

	var req replyRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		utils.WriteError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.Message == "" {
		utils.WriteError(w, http.StatusBadRequest, "message is required")
		return
	}

	// Load the conversation.
	conv, err := h.store.Conversations().Get(r.Context(), convID)
	if err != nil {
		if strings.Contains(err.Error(), "not found") {
			utils.WriteError(w, http.StatusNotFound, err.Error())
			return
		}
		utils.WriteError(w, http.StatusInternalServerError, err.Error())
		return
	}

	// Load the workspace.
	ws, err := h.store.Workspaces().Get(r.Context(), conv.WorkspaceID)
	if err != nil {
		utils.WriteError(w, http.StatusInternalServerError, err.Error())
		return
	}

	// Build the base tool list (without spawn_thread/await_thread initially).
	baseTools := []*agent.ToolDef{
		tools.NewShellTool(),
		tools.NewExecCommandTool(h.pm),
		tools.NewWriteStdinTool(h.pm),
		tools.NewApplyPatchTool(),
		tools.NewReadFileTool(),
		tools.NewListDirTool(),
		tools.NewGrepFilesTool(),
	}

	// spawn_thread passes the full tool list to child sessions so they have
	// the same capabilities as the parent (including spawn_thread for nesting).
	// We assemble the full list first, then construct spawn_thread with it.
	agentTools := append(baseTools,
		tools.NewSpawnThreadTool(h.store, h.client, ws, conv, baseTools, req.SystemPrompt, 0),
		tools.NewAwaitThreadTool(h.store),
	)

	// Create agent session with all tools (depth=0 for root HTTP sessions).
	session := agent.NewSession(
		h.store,
		h.client,
		ws,
		conv,
		req.SystemPrompt,
		agentTools,
		0,
	)

	// Start the turn.
	events, cancel, err := session.HandleUserMessage(r.Context(), req.Message)
	if err != nil {
		utils.WriteError(w, http.StatusInternalServerError, err.Error())
		return
	}
	defer cancel()

	// Set SSE headers.
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no") // Disable nginx buffering

	flusher, ok := w.(http.Flusher)
	if !ok {
		utils.WriteError(w, http.StatusInternalServerError, "streaming not supported")
		return
	}

	// Stream events to the client.
	for event := range events {
		data, err := json.Marshal(event)
		if err != nil {
			continue
		}

		fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event.Kind, data)
		flusher.Flush()

		// Stop streaming on error or turn complete.
		if event.Kind == agent.EventTurnComplete || event.Kind == agent.EventError {
			break
		}
	}
}
