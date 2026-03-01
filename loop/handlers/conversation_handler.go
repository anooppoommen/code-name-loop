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
	Type        string    `json:"type"` // "message" | "ui_event"
	Time        time.Time `json:"time"`
	TimelineSeq int64     `json:"timeline_seq,omitempty"`
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
		items = append(items, timelineItem{Type: "message", Time: m.CreatedAt, TimelineSeq: m.TimelineSeq, Message: m})
	}
	for _, e := range evts {
		items = append(items, timelineItem{Type: "ui_event", Time: e.CreatedAt, TimelineSeq: e.TimelineSeq, UIEvent: e})
	}

	// Prefer deterministic global timeline ordering.
	// During migration windows, fallback rows with timeline_seq=0 are sorted by timestamp/type.
	sort.SliceStable(items, func(i, j int) bool {
		if items[i].TimelineSeq > 0 && items[j].TimelineSeq > 0 {
			return items[i].TimelineSeq < items[j].TimelineSeq
		}
		if items[i].TimelineSeq > 0 && items[j].TimelineSeq == 0 {
			return true
		}
		if items[i].TimelineSeq == 0 && items[j].TimelineSeq > 0 {
			return false
		}
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
	var emittedCount atomic.Int64
	var persistedCount atomic.Int64
	var skippedUnknownCount atomic.Int64
	var queueBlockMS atomic.Int64
	var maxQueueDepth atomic.Int64
	var keepAliveCount atomic.Int64

	threadStatusCh := make(chan string, 256)
	commandApprovalCh := make(chan tools.CommandApprovalRequest, 64)

	recordQueueDepth := func(depth int) {
		if depth < 0 {
			return
		}
		d := int64(depth)
		for {
			curr := maxQueueDepth.Load()
			if d <= curr {
				return
			}
			if maxQueueDepth.CompareAndSwap(curr, d) {
				return
			}
		}
	}

	emitThreadStatus := func(msg string) {
		if strings.TrimSpace(msg) == "" {
			return
		}
		started := time.Now()
		select {
		case threadStatusCh <- msg:
			queueBlockMS.Add(time.Since(started).Milliseconds())
			recordQueueDepth(len(threadStatusCh))
		case <-r.Context().Done():
		}
	}

	emitCommandApprovalRequest := func(req tools.CommandApprovalRequest) {
		started := time.Now()
		select {
		case commandApprovalCh <- req:
			queueBlockMS.Add(time.Since(started).Milliseconds())
			recordQueueDepth(len(commandApprovalCh))
		case <-r.Context().Done():
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
	var streamSeq int64
	sendTurnEvent := func(event agent.TurnEvent) error {
		streamSeq++
		event.StreamSeq = streamSeq
		logTurnEvent(convID, event)
		data, err := json.Marshal(event)
		if err != nil {
			return err
		}
		if _, err := fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event.Kind, data); err != nil {
			return err
		}
		flusher.Flush()
		emittedCount.Add(1)
		return nil
	}

	logClose := func(reason string, terminalKind agent.TurnEventKind) {
		log.Printf("[reply] %s conv=%s terminal=%s after=%s emitted=%d persisted=%d keepalives=%d skipped_unknown=%d queue_block_ms=%d max_queue_depth=%d",
			reason,
			convID,
			terminalKind,
			time.Since(streamStartedAt).Round(time.Millisecond),
			emittedCount.Load(),
			persistedCount.Load(),
			keepAliveCount.Load(),
			skippedUnknownCount.Load(),
			queueBlockMS.Load(),
			maxQueueDepth.Load(),
		)
	}

	for {
		select {
		case <-r.Context().Done():
			logClose("client disconnected", "")
			return
		case event, ok := <-events:
			if !ok {
				logClose("stream closed", "")
				return
			}
			if err := sendTurnEvent(event); err != nil {
				log.Printf("[reply] send turn event conv=%s kind=%s: %v", convID, event.Kind, err)
				return
			}
			if event.Kind == agent.EventTurnComplete || event.Kind == agent.EventError || event.Kind == agent.EventTurnAborted {
				logClose("terminal event", event.Kind)
				return
			}
		case statusText := <-threadStatusCh:
			threadStatus := parseThreadStatus(statusText)
			if threadStatus.Phase == "update" && threadStatus.Status == "" {
				skippedUnknownCount.Add(1)
			}
			ev := agent.TurnEvent{
				Kind:         agent.EventThreadStatus,
				ThreadStatus: &threadStatus,
			}
			if err := sendTurnEvent(ev); err != nil {
				log.Printf("[reply] send thread status conv=%s: %v", convID, err)
				return
			}
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

			if err := h.store.UIEvents().Append(r.Context(), &models.UIEvent{
				ConversationID: convID,
				Kind:           models.UIEventKindApprovalRequest,
				Text:           fmt.Sprintf("approval required: %s", strings.TrimSpace(req.Command)),
				Metadata: map[string]any{
					"id":              req.ID,
					"conversation_id": req.ConversationID,
					"tool_name":       req.ToolName,
					"command":         req.Command,
					"workdir":         req.Workdir,
				},
			}); err != nil {
				log.Printf("[reply] persist approval ui event conv=%s req=%s: %v", convID, req.ID, err)
			} else {
				persistedCount.Add(1)
			}

			if err := sendTurnEvent(ev); err != nil {
				log.Printf("[reply] send approval event conv=%s: %v", convID, err)
				return
			}
		case <-ticker.C:
			// SSE comment line keeps proxies/clients alive during long model or tool calls.
			fmt.Fprintf(w, ": keep-alive\n\n")
			flusher.Flush()
			keepAliveCount.Add(1)
		}
	}
}

func parseThreadStatus(raw string) agent.ThreadStatusEvent {
	text := strings.TrimSpace(raw)
	out := agent.ThreadStatusEvent{Text: text}
	if text == "" {
		return out
	}

	if strings.HasPrefix(text, "[thread ") {
		if end := strings.Index(text, "]"); end > len("[thread ") {
			threadID := strings.TrimSpace(text[len("[thread "):end])
			out.ThreadID = threadID
			text = strings.TrimSpace(text[end+1:])
		}
	}

	normalized := strings.ToLower(text)
	switch {
	case strings.Contains(normalized, "spawned"):
		out.Status = "spawned"
		out.Phase = "spawned"
	case strings.Contains(normalized, "started"):
		out.Status = "running"
		out.Phase = "started"
	case strings.Contains(normalized, "running"):
		out.Status = "running"
		out.Phase = "running"
	case strings.Contains(normalized, "completed"), strings.Contains(normalized, "turn complete"):
		out.Status = "completed"
		out.Phase = "completed"
	case strings.Contains(normalized, "failed"):
		out.Status = "failed"
		out.Phase = "failed"
		if idx := strings.Index(text, ":"); idx >= 0 && idx < len(text)-1 {
			out.Error = strings.TrimSpace(text[idx+1:])
		}
	case strings.Contains(normalized, "aborted"):
		out.Status = "aborted"
		out.Phase = "aborted"
	case strings.Contains(normalized, "tool start"):
		out.Status = "running"
		out.Phase = "tool_start"
	case strings.Contains(normalized, "tool done"):
		out.Status = "running"
		out.Phase = "tool_done"
	case strings.Contains(normalized, "tool failed"):
		out.Status = "failed"
		out.Phase = "tool_failed"
	default:
		out.Phase = "update"
	}

	out.Text = strings.TrimSpace(raw)
	return out
}

func logTurnEvent(convID models.ConversationID, event agent.TurnEvent) {
	prefix := fmt.Sprintf("[reply:event] conv=%s seq=%d kind=%s", convID, event.StreamSeq, event.Kind)

	switch event.Kind {
	case agent.EventDelta:
		if event.Delta == nil {
			log.Printf("%s", prefix)
			return
		}
		log.Printf("%s thought=%t chars=%d", prefix, event.Delta.IsThought, len(event.Delta.Text))
	case agent.EventStatus:
		if event.Status == nil {
			log.Printf("%s", prefix)
			return
		}
		log.Printf("%s iteration=%d text=%q", prefix, event.Status.Iteration, truncateForLog(event.Status.Text, 180))
	case agent.EventStateTransition:
		if event.StateTransition == nil {
			log.Printf("%s", prefix)
			return
		}
		log.Printf("%s from=%s to=%s iteration=%d attempt=%d reason=%q",
			prefix,
			event.StateTransition.From,
			event.StateTransition.To,
			event.StateTransition.Iteration,
			event.StateTransition.Attempt,
			truncateForLog(event.StateTransition.Reason, 140),
		)
	case agent.EventModelWaitStarted:
		if event.ModelWaitStarted == nil {
			log.Printf("%s", prefix)
			return
		}
		log.Printf("%s iteration=%d attempt=%d model=%s started_at=%s",
			prefix,
			event.ModelWaitStarted.Iteration,
			event.ModelWaitStarted.Attempt,
			event.ModelWaitStarted.Model,
			event.ModelWaitStarted.StartedAt,
		)
	case agent.EventModelWaitFinished:
		if event.ModelWaitFinished == nil {
			log.Printf("%s", prefix)
			return
		}
		t := event.ModelWaitFinished.Timings
		log.Printf("%s iteration=%d attempt=%d outcome=%s ttft_ms=%d stream_ms=%d total_ms=%d retry_delay_ms=%d error=%q",
			prefix,
			event.ModelWaitFinished.Iteration,
			event.ModelWaitFinished.Attempt,
			event.ModelWaitFinished.Outcome,
			t.WaitForFirstTokenMS,
			t.StreamMS,
			t.TotalMS,
			t.RetryDelayMS,
			truncateForLog(event.ModelWaitFinished.Error, 140),
		)
	case agent.EventRetry:
		if event.Retry == nil {
			log.Printf("%s", prefix)
			return
		}
		log.Printf("%s attempt=%d/%d seconds_remaining=%d delay_seconds=%d message=%q",
			prefix,
			event.Retry.Attempt,
			event.Retry.MaxAttempts,
			event.Retry.SecondsRemaining,
			event.Retry.DelaySeconds,
			truncateForLog(event.Retry.Message, 180),
		)
	case agent.EventToolCallStart:
		if event.ToolCall == nil {
			log.Printf("%s", prefix)
			return
		}
		log.Printf("%s call_id=%s tool=%s args=%q",
			prefix,
			event.ToolCall.CallID,
			event.ToolCall.Name,
			truncateForLog(event.ToolCall.Args, 180),
		)
	case agent.EventToolResult:
		if event.ToolResult == nil {
			log.Printf("%s", prefix)
			return
		}
		log.Printf("%s call_id=%s tool=%s success=%t error=%q",
			prefix,
			event.ToolResult.CallID,
			event.ToolResult.Name,
			event.ToolResult.Success,
			truncateForLog(event.ToolResult.Error, 180),
		)
	case agent.EventApprovalRequest:
		if event.ApprovalRequest == nil {
			log.Printf("%s", prefix)
			return
		}
		log.Printf("%s id=%s tool=%s command=%q workdir=%q",
			prefix,
			event.ApprovalRequest.ID,
			event.ApprovalRequest.ToolName,
			truncateForLog(event.ApprovalRequest.Command, 180),
			truncateForLog(event.ApprovalRequest.Workdir, 120),
		)
	case agent.EventThreadStatus:
		if event.ThreadStatus == nil {
			log.Printf("%s", prefix)
			return
		}
		log.Printf("%s thread_id=%s status=%s phase=%s error=%q text=%q",
			prefix,
			event.ThreadStatus.ThreadID,
			event.ThreadStatus.Status,
			event.ThreadStatus.Phase,
			truncateForLog(event.ThreadStatus.Error, 140),
			truncateForLog(event.ThreadStatus.Text, 180),
		)
	case agent.EventMessageDone:
		log.Printf("%s", prefix)
	case agent.EventTurnStarted, agent.EventTurnComplete, agent.EventTurnAborted:
		log.Printf("%s error=%q", prefix, truncateForLog(event.ErrorText, 140))
	case agent.EventError:
		log.Printf("%s error=%q", prefix, truncateForLog(event.ErrorText, 180))
	default:
		log.Printf("%s", prefix)
	}
}

func truncateForLog(text string, max int) string {
	if max <= 0 || len(text) <= max {
		return text
	}
	return text[:max] + "...(truncated)"
}
