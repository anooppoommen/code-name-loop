package handlers

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"

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
	mux.HandleFunc("PATCH /conversations/{id}", h.Update)
	mux.HandleFunc("DELETE /conversations/{id}", h.Delete)
	mux.HandleFunc("GET /conversations/{id}/messages", h.ListMessages)
	mux.HandleFunc("GET /conversations/{id}/timeline", h.Timeline)
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

type updateConversationRequest struct {
	Title string `json:"title"`
}

func (h *ConversationHandler) Update(w http.ResponseWriter, r *http.Request) {
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

	var req updateConversationRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		utils.WriteError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	conv.Title = req.Title
	if err := h.store.Conversations().Update(r.Context(), conv); err != nil {
		utils.WriteError(w, http.StatusInternalServerError, err.Error())
		return
	}

	utils.WriteJSON(w, http.StatusOK, conv)
}

func (h *ConversationHandler) Delete(w http.ResponseWriter, r *http.Request) {
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

	allConvs, err := h.store.Conversations().ListByWorkspace(r.Context(), conv.WorkspaceID)
	if err != nil {
		utils.WriteError(w, http.StatusInternalServerError, err.Error())
		return
	}

	childrenByParent := make(map[models.ConversationID][]models.ConversationID, len(allConvs))
	for _, row := range allConvs {
		if row.ParentConversationID == "" {
			continue
		}
		childrenByParent[row.ParentConversationID] = append(childrenByParent[row.ParentConversationID], row.ID)
	}

	var deleteOrder []models.ConversationID
	var walk func(models.ConversationID)
	walk = func(parent models.ConversationID) {
		for _, child := range childrenByParent[parent] {
			walk(child)
		}
		deleteOrder = append(deleteOrder, parent)
	}
	walk(id)

	for _, convID := range deleteOrder {
		if err := h.store.Conversations().Delete(r.Context(), convID); err != nil {
			if strings.Contains(err.Error(), "not found") {
				continue
			}
			utils.WriteError(w, http.StatusInternalServerError, err.Error())
			return
		}
	}

	w.WriteHeader(http.StatusNoContent)
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

func (h *ConversationHandler) ListMessages(w http.ResponseWriter, r *http.Request) {
	id := models.ConversationID(r.PathValue("id"))

	if _, err := h.store.Conversations().Get(r.Context(), id); err != nil {
		if strings.Contains(err.Error(), "not found") {
			utils.WriteError(w, http.StatusNotFound, err.Error())
			return
		}
		utils.WriteError(w, http.StatusInternalServerError, err.Error())
		return
	}

	msgs, err := h.store.Messages().GetRange(r.Context(), id, 1, 999999)
	if err != nil {
		utils.WriteError(w, http.StatusInternalServerError, err.Error())
		return
	}
	utils.WriteJSON(w, http.StatusOK, msgs)
}

// timelineItem is a single entry in the unified conversation timeline.
// The Type field discriminates between a models.Message and a models.UIEvent.
type timelineItem struct {
	Type string    `json:"type"` // "message" | "ui_event"
	Time time.Time `json:"time"`
	// Only one of these will be non-nil, matching Type.
	Message *models.Message `json:"message,omitempty"`
	UIEvent *models.UIEvent `json:"ui_event,omitempty"`
}

// Timeline returns a single chronological array of messages and UIEvents for a conversation.
// Items are sorted by their creation timestamp. Because message.seq and ui_event.seq are
// both monotonic within their own tables, this combined sort produces a deterministic view.
func (h *ConversationHandler) Timeline(w http.ResponseWriter, r *http.Request) {
	id := models.ConversationID(r.PathValue("id"))

	if _, err := h.store.Conversations().Get(r.Context(), id); err != nil {
		if strings.Contains(err.Error(), "not found") {
			utils.WriteError(w, http.StatusNotFound, err.Error())
			return
		}
		utils.WriteError(w, http.StatusInternalServerError, err.Error())
		return
	}

	msgs, err := h.store.Messages().GetRange(r.Context(), id, 1, 999999)
	if err != nil {
		utils.WriteError(w, http.StatusInternalServerError, err.Error())
		return
	}

	evts, err := h.store.UIEvents().GetByConversation(r.Context(), id)
	if err != nil {
		utils.WriteError(w, http.StatusInternalServerError, err.Error())
		return
	}

	items := make([]timelineItem, 0, len(msgs)+len(evts))
	for _, m := range msgs {
		items = append(items, timelineItem{Type: "message", Time: m.CreatedAt, Message: m})
	}
	for _, e := range evts {
		items = append(items, timelineItem{Type: "ui_event", Time: e.CreatedAt, UIEvent: e})
	}

	// Sort strictly chronologically. When timestamps are equal (rare, sub-millisecond)
	// messages sort before ui_events to maintain logical causality.
	sort.SliceStable(items, func(i, j int) bool {
		if items[i].Time.Equal(items[j].Time) {
			return items[i].Type < items[j].Type // "message" < "ui_event" lexicographically
		}
		return items[i].Time.Before(items[j].Time)
	})

	utils.WriteJSON(w, http.StatusOK, items)
}

// replyRequest is the JSON body for the Reply endpoint.
type replyRequest struct {
	Message       string `json:"message"`
	ThinkingLevel string `json:"thinking_level,omitempty"`
	Images        []replyImage `json:"images,omitempty"`
}

type replyImage struct {
	MIMEType string `json:"mime_type"`
	Data     string `json:"data"` // base64 encoded
}

// Reply handles user messages and streams the agent's response using SSE.
// This is the primary user-facing endpoint for interacting with the agent.
//
// Request: POST /conversations/{id}/reply
// Body:    {"message": "user text", "thinking_level": "optional minimal|low|medium|high"}
// Response: text/event-stream (SSE)
func (h *ConversationHandler) Reply(w http.ResponseWriter, r *http.Request) {
	convID := models.ConversationID(r.PathValue("id"))
	threadStatusCh := make(chan string, 512)
	emitThreadStatus := func(msg string) {
		if strings.TrimSpace(msg) == "" {
			return
		}
		select {
		case threadStatusCh <- msg:
		default:
			// Drop if client is slow; status updates are best-effort.
		}
	}

	var req replyRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		utils.WriteError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.Message == "" && len(req.Images) == 0 {
		utils.WriteError(w, http.StatusBadRequest, "message is required")
		return
	}
	for i, img := range req.Images {
		if strings.TrimSpace(img.MIMEType) == "" {
			utils.WriteError(w, http.StatusBadRequest, fmt.Sprintf("images[%d].mime_type is required", i))
			return
		}
		if strings.TrimSpace(img.Data) == "" {
			utils.WriteError(w, http.StatusBadRequest, fmt.Sprintf("images[%d].data is required", i))
			return
		}
		if _, err := base64.StdEncoding.DecodeString(img.Data); err != nil {
			utils.WriteError(w, http.StatusBadRequest, fmt.Sprintf("images[%d].data must be valid base64", i))
			return
		}
	}
	thinkingLevel, err := agent.ParseThinkingLevel(req.ThinkingLevel)
	if err != nil {
		utils.WriteError(w, http.StatusBadRequest, err.Error())
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
		tools.NewExecCommandTool(h.pm, ws),
		tools.NewWriteStdinTool(h.pm),
		tools.NewApplyPatchTool(ws),
		tools.NewReadFileTool(ws),
		tools.NewListDirTool(ws),
		tools.NewGrepFilesTool(ws),
		tools.NewUpdatePlanTool(),
		tools.NewRequestUserInputTool(),
	}
	baseTools = append(baseTools, tools.NewParallelToolUseTool(func() []*agent.ToolDef { return baseTools }))

	// spawn_thread passes the full tool list to child sessions so they have
	// the same capabilities as the parent (including spawn_thread for nesting).
	// We assemble the full list first, then construct spawn_thread with it.
	agentTools := append(baseTools,
		tools.NewSpawnThreadTool(h.store, h.client, ws, conv, baseTools, 0, emitThreadStatus),
		tools.NewAwaitThreadTool(h.store, emitThreadStatus),
	)

	// Create agent session with all tools (depth=0 for root HTTP sessions).
	session := agent.NewSession(
		h.store,
		h.client,
		ws,
		conv,
		agentTools,
		0,
	)
	session.ThinkingLevel = strings.ToLower(string(thinkingLevel))
	session.IncludeThoughts = true

	var parts []models.MessagePart
	if req.Message != "" {
		parts = append(parts, models.MessagePart{
			Kind: models.PartText,
			Text: &models.TextPart{Text: req.Message},
		})
	}
	for _, img := range req.Images {
		parts = append(parts, models.MessagePart{
			Kind: models.PartInlineBlob,
			InlineBlob: &models.InlineBlobPart{
				MIMEType: img.MIMEType,
				Data:     img.Data,
			},
		})
	}

	// Start the turn.
	events, cancel, err := session.HandleUserMessage(r.Context(), parts)
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

	// Stream events to the client and emit keepalives while the model/tool loop is busy.
	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()

	for {
		// Prioritize turn events so completion/error cannot be starved by
		// high-volume thread status updates.
		select {
		case <-r.Context().Done():
			return
		case event, ok := <-events:
			if !ok {
				return
			}
			data, err := json.Marshal(event)
			if err != nil {
				continue
			}

			fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event.Kind, data)
			flusher.Flush()

			// Stop streaming on terminal events.
			if event.Kind == agent.EventTurnComplete || event.Kind == agent.EventError || event.Kind == agent.EventTurnAborted {
				return
			}
			continue
		default:
		}

		select {
		case <-r.Context().Done():
			return
		case statusText := <-threadStatusCh:
			ev := agent.TurnEvent{
				Kind: agent.EventStatus,
				Status: &agent.StatusEvent{
					Text: statusText,
				},
			}
			data, err := json.Marshal(ev)
			if err != nil {
				continue
			}
			fmt.Fprintf(w, "event: %s\ndata: %s\n\n", ev.Kind, data)
			flusher.Flush()
		case <-ticker.C:
			// SSE comment line keeps proxies/clients alive during long model or tool calls.
			fmt.Fprintf(w, ": keep-alive\n\n")
			flusher.Flush()
		case event, ok := <-events:
			if !ok {
				return
			}
			data, err := json.Marshal(event)
			if err != nil {
				continue
			}

			fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event.Kind, data)
			flusher.Flush()

			// Stop streaming on terminal events.
			if event.Kind == agent.EventTurnComplete || event.Kind == agent.EventError || event.Kind == agent.EventTurnAborted {
				return
			}
		}
	}
}
