package handlers

import (
	"context"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"loop/models"
	"loop/utils"
)

const (
	defaultCommandPaletteLimit = 12
	maxCommandPaletteLimit     = 40
)

type commandPaletteSearchResponse struct {
	Query         string                             `json:"query"`
	WorkspaceID   string                             `json:"workspace_id,omitempty"`
	Workspaces    []commandPaletteWorkspaceResult    `json:"workspaces"`
	Conversations []commandPaletteConversationResult `json:"conversations"`
	ActiveTasks   []commandPaletteConversationResult `json:"active_tasks"`
}

type commandPaletteWorkspaceResult struct {
	WorkspaceID       string `json:"workspace_id"`
	WorkspaceName     string `json:"workspace_name"`
	WorkspaceRootPath string `json:"workspace_root_path"`
}

type commandPaletteConversationResult struct {
	WorkspaceID          string    `json:"workspace_id"`
	WorkspaceName        string    `json:"workspace_name"`
	ConversationID       string    `json:"conversation_id"`
	RootConversationID   string    `json:"root_conversation_id"`
	ParentConversationID string    `json:"parent_conversation_id,omitempty"`
	Title                string    `json:"title"`
	IsThread             bool      `json:"is_thread"`
	ThreadStatus         string    `json:"thread_status,omitempty"`
	UpdatedAt            time.Time `json:"updated_at"`
	MatchKind            string    `json:"match_kind"`
	Snippet              string    `json:"snippet,omitempty"`
}

type commandPaletteConversationMatch struct {
	Result    commandPaletteConversationResult
	Score     int
	UpdatedAt time.Time
}

func (h *ConversationHandler) CommandPaletteSearch(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	query := strings.TrimSpace(r.URL.Query().Get("q"))
	normalizedQuery := strings.ToLower(query)
	workspaceFilter := strings.TrimSpace(r.URL.Query().Get("workspace_id"))
	limit := parseCommandPaletteLimit(r.URL.Query().Get("limit"))
	messageSearchEnabled := normalizedQuery != "" && utf8.RuneCountInString(normalizedQuery) >= 2

	workspaces, err := h.store.Workspaces().List(ctx)
	if err != nil {
		utils.WriteError(w, http.StatusInternalServerError, err.Error())
		return
	}

	sort.SliceStable(workspaces, func(i, j int) bool {
		left := strings.ToLower(strings.TrimSpace(workspaces[i].Name))
		right := strings.ToLower(strings.TrimSpace(workspaces[j].Name))
		if left == right {
			return string(workspaces[i].ID) < string(workspaces[j].ID)
		}
		return left < right
	})

	filteredWorkspaces := make([]*models.Workspace, 0, len(workspaces))
	for _, ws := range workspaces {
		if workspaceFilter != "" && ws.ID != models.WorkspaceID(workspaceFilter) {
			continue
		}
		filteredWorkspaces = append(filteredWorkspaces, ws)
	}

	response := commandPaletteSearchResponse{
		Query:         query,
		WorkspaceID:   workspaceFilter,
		Workspaces:    make([]commandPaletteWorkspaceResult, 0),
		Conversations: make([]commandPaletteConversationResult, 0),
		ActiveTasks:   make([]commandPaletteConversationResult, 0),
	}

	if len(filteredWorkspaces) == 0 {
		utils.WriteJSON(w, http.StatusOK, response)
		return
	}

	conversationMatches := make(map[models.ConversationID]commandPaletteConversationMatch)
	activeTaskByID := make(map[models.ConversationID]commandPaletteConversationResult)

	for _, ws := range filteredWorkspaces {
		if normalizedQuery == "" || includesFold(ws.Name, normalizedQuery) || includesFold(ws.RootPath, normalizedQuery) {
			response.Workspaces = append(response.Workspaces, commandPaletteWorkspaceResult{
				WorkspaceID:       string(ws.ID),
				WorkspaceName:     ws.Name,
				WorkspaceRootPath: ws.RootPath,
			})
		}

		convs, err := h.store.Conversations().ListByWorkspace(ctx, ws.ID)
		if err != nil {
			utils.WriteError(w, http.StatusInternalServerError, err.Error())
			return
		}
		sort.SliceStable(convs, func(i, j int) bool {
			if convs[i].UpdatedAt.Equal(convs[j].UpdatedAt) {
				return convs[i].ID < convs[j].ID
			}
			return convs[i].UpdatedAt.After(convs[j].UpdatedAt)
		})

		convByID := make(map[models.ConversationID]*models.Conversation, len(convs))
		rootByID := make(map[models.ConversationID]models.ConversationID, len(convs))
		for _, conv := range convs {
			convByID[conv.ID] = conv
		}

		for _, conv := range convs {
			rootConversationID := resolveRootConversationID(conv.ID, convByID, rootByID)
			baseResult := commandPaletteConversationResult{
				WorkspaceID:          string(ws.ID),
				WorkspaceName:        ws.Name,
				ConversationID:       string(conv.ID),
				RootConversationID:   string(rootConversationID),
				ParentConversationID: string(conv.ParentConversationID),
				Title:                strings.TrimSpace(conv.Title),
				IsThread:             conv.IsThread(),
				ThreadStatus:         string(conv.ThreadStatus),
				UpdatedAt:            conv.UpdatedAt,
			}
			if baseResult.Title == "" {
				baseResult.Title = string(conv.ID)
			}
			if baseResult.RootConversationID == "" {
				baseResult.RootConversationID = baseResult.ConversationID
			}

			if h.isConversationActivelyRunning(ctx, conv) {
				activeTask := baseResult
				activeTask.MatchKind = "running"
				activeTask.Snippet = activeTaskLabel(conv)
				if normalizedQuery == "" ||
					includesFold(activeTask.Title, normalizedQuery) ||
					includesFold(activeTask.Snippet, normalizedQuery) ||
					includesFold(activeTask.WorkspaceName, normalizedQuery) {
					activeTaskByID[conv.ID] = activeTask
				}
			}

			if normalizedQuery == "" {
				if conv.IsThread() {
					continue
				}
				recent := baseResult
				recent.MatchKind = "recent"
				upsertConversationMatch(conversationMatches, conv.ID, commandPaletteConversationMatch{
					Result:    recent,
					Score:     100,
					UpdatedAt: conv.UpdatedAt,
				})
				continue
			}

			if includesFold(baseResult.Title, normalizedQuery) {
				titleResult := baseResult
				titleResult.MatchKind = "title"
				upsertConversationMatch(conversationMatches, conv.ID, commandPaletteConversationMatch{
					Result:    titleResult,
					Score:     scoreTitleMatch(baseResult.Title, normalizedQuery, baseResult.IsThread),
					UpdatedAt: conv.UpdatedAt,
				})
			}

			if !messageSearchEnabled {
				continue
			}
			if snippet, ok := h.findConversationMessageSnippet(ctx, conv.ID, normalizedQuery); ok {
				messageResult := baseResult
				messageResult.MatchKind = "message"
				messageResult.Snippet = snippet
				upsertConversationMatch(conversationMatches, conv.ID, commandPaletteConversationMatch{
					Result:    messageResult,
					Score:     scoreMessageMatch(baseResult.IsThread),
					UpdatedAt: conv.UpdatedAt,
				})
			}
		}
	}

	if len(response.Workspaces) > limit {
		response.Workspaces = response.Workspaces[:limit]
	}

	matchList := make([]commandPaletteConversationMatch, 0, len(conversationMatches))
	for _, match := range conversationMatches {
		matchList = append(matchList, match)
	}
	sort.SliceStable(matchList, func(i, j int) bool {
		if matchList[i].Score == matchList[j].Score {
			if matchList[i].UpdatedAt.Equal(matchList[j].UpdatedAt) {
				return strings.ToLower(matchList[i].Result.Title) < strings.ToLower(matchList[j].Result.Title)
			}
			return matchList[i].UpdatedAt.After(matchList[j].UpdatedAt)
		}
		return matchList[i].Score > matchList[j].Score
	})
	for idx, match := range matchList {
		if idx >= limit {
			break
		}
		response.Conversations = append(response.Conversations, match.Result)
	}

	activeTaskList := make([]commandPaletteConversationResult, 0, len(activeTaskByID))
	for _, task := range activeTaskByID {
		activeTaskList = append(activeTaskList, task)
	}
	sort.SliceStable(activeTaskList, func(i, j int) bool {
		if activeTaskList[i].UpdatedAt.Equal(activeTaskList[j].UpdatedAt) {
			return strings.ToLower(activeTaskList[i].Title) < strings.ToLower(activeTaskList[j].Title)
		}
		return activeTaskList[i].UpdatedAt.After(activeTaskList[j].UpdatedAt)
	})
	if len(activeTaskList) > limit {
		activeTaskList = activeTaskList[:limit]
	}
	response.ActiveTasks = activeTaskList

	utils.WriteJSON(w, http.StatusOK, response)
}

func parseCommandPaletteLimit(raw string) int {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return defaultCommandPaletteLimit
	}
	parsed, err := strconv.Atoi(trimmed)
	if err != nil {
		return defaultCommandPaletteLimit
	}
	if parsed < 1 {
		return defaultCommandPaletteLimit
	}
	if parsed > maxCommandPaletteLimit {
		return maxCommandPaletteLimit
	}
	return parsed
}

func includesFold(haystack string, normalizedNeedle string) bool {
	if normalizedNeedle == "" {
		return true
	}
	return strings.Contains(strings.ToLower(haystack), normalizedNeedle)
}

func scoreTitleMatch(title string, normalizedQuery string, isThread bool) int {
	score := 120
	normalizedTitle := strings.ToLower(strings.TrimSpace(title))
	if strings.HasPrefix(normalizedTitle, normalizedQuery) {
		score += 20
	}
	if isThread {
		score += 2
	}
	return score
}

func scoreMessageMatch(isThread bool) int {
	score := 78
	if isThread {
		score += 4
	}
	return score
}

func resolveRootConversationID(
	conversationID models.ConversationID,
	convByID map[models.ConversationID]*models.Conversation,
	cache map[models.ConversationID]models.ConversationID,
) models.ConversationID {
	if conversationID == "" {
		return ""
	}
	if cached, ok := cache[conversationID]; ok {
		return cached
	}

	seen := make([]models.ConversationID, 0, 4)
	seenSet := make(map[models.ConversationID]struct{}, 4)
	current := conversationID
	for current != "" {
		if cached, ok := cache[current]; ok {
			for _, id := range seen {
				cache[id] = cached
			}
			return cached
		}
		if _, visited := seenSet[current]; visited {
			break
		}
		seenSet[current] = struct{}{}
		seen = append(seen, current)

		conv := convByID[current]
		if conv == nil || conv.ParentConversationID == "" {
			for _, id := range seen {
				cache[id] = current
			}
			return current
		}
		current = conv.ParentConversationID
	}

	for _, id := range seen {
		cache[id] = conversationID
	}
	return conversationID
}

func upsertConversationMatch(
	store map[models.ConversationID]commandPaletteConversationMatch,
	conversationID models.ConversationID,
	candidate commandPaletteConversationMatch,
) {
	existing, ok := store[conversationID]
	if !ok {
		store[conversationID] = candidate
		return
	}
	if candidate.Score > existing.Score {
		store[conversationID] = candidate
		return
	}
	if candidate.Score == existing.Score && candidate.UpdatedAt.After(existing.UpdatedAt) {
		store[conversationID] = candidate
	}
}

func (h *ConversationHandler) findConversationMessageSnippet(
	ctx context.Context,
	conversationID models.ConversationID,
	normalizedQuery string,
) (string, bool) {
	messages, err := h.store.Messages().GetRange(ctx, conversationID, 1, 999999)
	if err != nil || len(messages) == 0 {
		return "", false
	}

	for idx := len(messages) - 1; idx >= 0; idx-- {
		text := messageSearchText(messages[idx])
		if text == "" {
			continue
		}
		if snippet, ok := buildSearchSnippet(text, normalizedQuery, 128); ok {
			return snippet, true
		}
	}
	return "", false
}

func messageSearchText(msg *models.Message) string {
	if msg == nil {
		return ""
	}
	chunks := make([]string, 0, len(msg.Parts))
	for _, part := range msg.Parts {
		switch part.Kind {
		case models.PartText:
			if part.Text != nil && strings.TrimSpace(part.Text.Text) != "" {
				chunks = append(chunks, part.Text.Text)
			}
		case models.PartThought:
			continue
		case models.PartCodeExecResult:
			if part.CodeExecResult != nil && strings.TrimSpace(part.CodeExecResult.Output) != "" {
				chunks = append(chunks, part.CodeExecResult.Output)
			}
		case models.PartExecutableCode:
			if part.ExecutableCode != nil && strings.TrimSpace(part.ExecutableCode.Code) != "" {
				chunks = append(chunks, part.ExecutableCode.Code)
			}
		}
	}
	return strings.TrimSpace(strings.Join(chunks, " "))
}

func buildSearchSnippet(text string, normalizedQuery string, maxRunes int) (string, bool) {
	normalizedText := strings.Join(strings.Fields(strings.TrimSpace(text)), " ")
	if normalizedText == "" || normalizedQuery == "" {
		return "", false
	}

	lower := strings.ToLower(normalizedText)
	byteIdx := strings.Index(lower, normalizedQuery)
	if byteIdx < 0 {
		return "", false
	}

	runes := []rune(normalizedText)
	if len(runes) <= maxRunes {
		return normalizedText, true
	}

	matchStart := utf8.RuneCountInString(normalizedText[:byteIdx])
	matchLength := utf8.RuneCountInString(normalizedQuery)
	if matchLength == 0 {
		matchLength = 1
	}

	start := matchStart - ((maxRunes - matchLength) / 2)
	if start < 0 {
		start = 0
	}
	end := start + maxRunes
	if end > len(runes) {
		end = len(runes)
		start = end - maxRunes
		if start < 0 {
			start = 0
		}
	}

	snippet := string(runes[start:end])
	if start > 0 {
		snippet = "..." + snippet
	}
	if end < len(runes) {
		snippet += "..."
	}
	return snippet, true
}

func (h *ConversationHandler) isConversationActivelyRunning(ctx context.Context, conv *models.Conversation) bool {
	if conv == nil {
		return false
	}
	if conv.ThreadStatus == models.ThreadStatusRunning {
		return true
	}
	if conv.HeadMessageID == "" {
		return false
	}
	head, err := h.store.Messages().Get(ctx, conv.HeadMessageID)
	if err != nil || head == nil {
		return false
	}
	return head.State == models.MessageStateRunning
}

func activeTaskLabel(conv *models.Conversation) string {
	if conv == nil {
		return "Running"
	}
	if conv.IsThread() {
		return "Sub-agent thread running"
	}
	return "Reply stream running"
}
