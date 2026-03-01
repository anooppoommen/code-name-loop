package handlers

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"sort"
	"strings"
	"sync/atomic"
	"time"

	"github.com/google/uuid"

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
	store            store.Store
	client           agent.ModelClient
	pm               *tools.ProcessManager
	commandApprovals *tools.CommandApprovalManager
}

func NewConversationHandler(s store.Store, client agent.ModelClient, pm *tools.ProcessManager) *ConversationHandler {
	return &ConversationHandler{
		store:            s,
		client:           client,
		pm:               pm,
		commandApprovals: tools.NewCommandApprovalManager(),
	}
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
	mux.HandleFunc("GET /command-approvals", h.ListCommandApprovals)
	mux.HandleFunc("POST /command-approvals/{id}/decision", h.ResolveCommandApproval)
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

type resolveCommandApprovalRequest struct {
	Decision string `json:"decision"`
	Message  string `json:"message,omitempty"`
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

func (h *ConversationHandler) ResolveCommandApproval(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimSpace(r.PathValue("id"))
	if id == "" {
		utils.WriteError(w, http.StatusBadRequest, "approval id is required")
		return
	}

	var req resolveCommandApprovalRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		utils.WriteError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	decision, err := tools.ParseCommandApprovalDecision(req.Decision)
	if err != nil {
		utils.WriteError(w, http.StatusBadRequest, err.Error())
		return
	}

	if err := h.commandApprovals.Resolve(id, decision, req.Message); err != nil {
		if errors.Is(err, tools.ErrCommandApprovalNotFound) {
			utils.WriteError(w, http.StatusNotFound, err.Error())
			return
		}
		utils.WriteError(w, http.StatusInternalServerError, err.Error())
		return
	}

	utils.WriteJSON(w, http.StatusOK, map[string]any{
		"id":       id,
		"decision": decision,
		"message":  strings.TrimSpace(req.Message),
	})
}

func (h *ConversationHandler) ListCommandApprovals(w http.ResponseWriter, r *http.Request) {
	conversationID := strings.TrimSpace(r.URL.Query().Get("conversation_id"))
	pending := h.commandApprovals.ListPending(conversationID)
	utils.WriteJSON(w, http.StatusOK, pending)
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
	Message       string       `json:"message"`
	ThinkingLevel string       `json:"thinking_level,omitempty"`
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
	approvalSessionID := uuid.New().String()
	defer h.commandApprovals.ClearSession(approvalSessionID)
	streamStartedAt := time.Now()
	var threadStatusDelivered atomic.Int64
	var threadStatusDropped atomic.Int64
	var threadStatusForced atomic.Int64
	var commandApprovalDropped atomic.Int64

	threadStatusCh := make(chan string, 1024)
	commandApprovalCh := make(chan tools.CommandApprovalRequest, 64)
	emitThreadStatus := func(msg string) {
		if strings.TrimSpace(msg) == "" {
			return
		}
		select {
		case threadStatusCh <- msg:
			threadStatusDelivered.Add(1)
		default:
			// Preserve terminal lifecycle status even if the channel is saturated.
			// This prevents "stuck thinking" UI when high-volume status chatter fills the queue.
			if isTerminalThreadStatus(msg) {
				select {
				case <-threadStatusCh:
				default:
				}
				select {
				case threadStatusCh <- msg:
					threadStatusDelivered.Add(1)
					threadStatusForced.Add(1)
					return
				default:
				}
			}
			dropped := threadStatusDropped.Add(1)
			if dropped == 1 || dropped%25 == 0 {
				log.Printf("[reply] conv=%s dropped thread status updates=%d latest=%q",
					convID, dropped, truncateStatusForLog(msg))
			}
		}
	}
	emitCommandApprovalRequest := func(req tools.CommandApprovalRequest) {
		select {
		case commandApprovalCh <- req:
		default:
			dropped := commandApprovalDropped.Add(1)
			if dropped == 1 || dropped%10 == 0 {
				log.Printf("[reply] conv=%s dropped command approval requests=%d", convID, dropped)
			}
		}
	}
	commandApprovalRequester := tools.CommandApprovalRequesterFunc(
		func(ctx context.Context, req tools.CommandApprovalRequest) (tools.CommandApprovalResolution, error) {
			req.SessionID = approvalSessionID
			req.ConversationID = string(convID)
			return h.commandApprovals.AwaitDecision(ctx, req, emitCommandApprovalRequest)
		},
	)

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
	log.Printf("[reply] start conv=%s thinking=%s message_chars=%d images=%d",
		convID, strings.ToLower(string(thinkingLevel)), len(req.Message), len(req.Images))

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
		tools.NewExecCommandTool(h.pm, ws, commandApprovalRequester),
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
	var eventCount int64
	var keepAliveCount int64

	for {
		// Prioritize turn events so completion/error cannot be starved by
		// high-volume thread status updates.
		select {
		case <-r.Context().Done():
			log.Printf("[reply] client disconnected conv=%s after=%s events=%d keepalives=%d thread_status(delivered=%d dropped=%d forced=%d)",
				convID,
				time.Since(streamStartedAt).Round(time.Millisecond),
				eventCount,
				keepAliveCount,
				threadStatusDelivered.Load(),
				threadStatusDropped.Load(),
				threadStatusForced.Load(),
			)
			return
		case event, ok := <-events:
			if !ok {
				log.Printf("[reply] stream closed conv=%s after=%s events=%d keepalives=%d thread_status(delivered=%d dropped=%d forced=%d)",
					convID,
					time.Since(streamStartedAt).Round(time.Millisecond),
					eventCount,
					keepAliveCount,
					threadStatusDelivered.Load(),
					threadStatusDropped.Load(),
					threadStatusForced.Load(),
				)
				return
			}
			data, err := json.Marshal(event)
			if err != nil {
				continue
			}

			fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event.Kind, data)
			flusher.Flush()
			eventCount++

			// Stop streaming on terminal events.
			if event.Kind == agent.EventTurnComplete || event.Kind == agent.EventError || event.Kind == agent.EventTurnAborted {
				log.Printf("[reply] terminal event conv=%s kind=%s after=%s events=%d keepalives=%d thread_status(delivered=%d dropped=%d forced=%d)",
					convID,
					event.Kind,
					time.Since(streamStartedAt).Round(time.Millisecond),
					eventCount,
					keepAliveCount,
					threadStatusDelivered.Load(),
					threadStatusDropped.Load(),
					threadStatusForced.Load(),
				)
				return
			}
			continue
		default:
		}

		select {
		case <-r.Context().Done():
			log.Printf("[reply] client disconnected conv=%s after=%s events=%d keepalives=%d thread_status(delivered=%d dropped=%d forced=%d)",
				convID,
				time.Since(streamStartedAt).Round(time.Millisecond),
				eventCount,
				keepAliveCount,
				threadStatusDelivered.Load(),
				threadStatusDropped.Load(),
				threadStatusForced.Load(),
			)
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
			eventCount++
		case req := <-commandApprovalCh:
			ev := agent.TurnEvent{
				Kind: agent.EventApprovalRequest,
				ApprovalRequest: &agent.ApprovalRequestEvent{
					ID:             req.ID,
					ConversationID: req.ConversationID,
					ToolName:       req.ToolName,
					Command:        req.Command,
					Workdir:        req.Workdir,
				},
			}
			data, err := json.Marshal(ev)
			if err != nil {
				continue
			}
			fmt.Fprintf(w, "event: %s\ndata: %s\n\n", ev.Kind, data)
			flusher.Flush()
			eventCount++
		case <-ticker.C:
			// SSE comment line keeps proxies/clients alive during long model or tool calls.
			fmt.Fprintf(w, ": keep-alive\n\n")
			flusher.Flush()
			keepAliveCount++
		case event, ok := <-events:
			if !ok {
				log.Printf("[reply] stream closed conv=%s after=%s events=%d keepalives=%d thread_status(delivered=%d dropped=%d forced=%d)",
					convID,
					time.Since(streamStartedAt).Round(time.Millisecond),
					eventCount,
					keepAliveCount,
					threadStatusDelivered.Load(),
					threadStatusDropped.Load(),
					threadStatusForced.Load(),
				)
				return
			}
			data, err := json.Marshal(event)
			if err != nil {
				continue
			}

			fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event.Kind, data)
			flusher.Flush()
			eventCount++

			// Stop streaming on terminal events.
			if event.Kind == agent.EventTurnComplete || event.Kind == agent.EventError || event.Kind == agent.EventTurnAborted {
				log.Printf("[reply] terminal event conv=%s kind=%s after=%s events=%d keepalives=%d thread_status(delivered=%d dropped=%d forced=%d)",
					convID,
					event.Kind,
					time.Since(streamStartedAt).Round(time.Millisecond),
					eventCount,
					keepAliveCount,
					threadStatusDelivered.Load(),
					threadStatusDropped.Load(),
					threadStatusForced.Load(),
				)
				return
			}
		}
	}
}

func isTerminalThreadStatus(msg string) bool {
	normalized := strings.ToLower(strings.TrimSpace(msg))
	if normalized == "" {
		return false
	}
	return strings.Contains(normalized, " completed") ||
		strings.Contains(normalized, " failed") ||
		strings.Contains(normalized, " aborted") ||
		strings.Contains(normalized, "turn complete")
}

func truncateStatusForLog(msg string) string {
	const maxLen = 180
	msg = strings.TrimSpace(msg)
	if len(msg) <= maxLen {
		return msg
	}
	return msg[:maxLen] + "...(truncated)"
}
