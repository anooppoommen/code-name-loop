package handlers

import (
	"context"
	"encoding/json"
	"math"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"

	"loop/models"
	"loop/store"
	"loop/utils"
)

// WorkspaceHandler handles workspace REST endpoints.
// Only user-facing endpoints are exposed: Create, Get, List.
type WorkspaceHandler struct {
	store store.Store
	model string
}

func NewWorkspaceHandler(s store.Store, model string) *WorkspaceHandler {
	return &WorkspaceHandler{store: s, model: model}
}

// RegisterRoutes registers workspace routes on the given mux.
func (h *WorkspaceHandler) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("POST /workspaces", h.Create)
	mux.HandleFunc("GET /workspaces", h.List)
	mux.HandleFunc("GET /workspaces/{id}", h.Get)
	mux.HandleFunc("DELETE /workspaces/{id}", h.Delete)
	mux.HandleFunc("GET /workspaces/{id}/stats", h.Stats)
	mux.HandleFunc("GET /workspaces/{id}/git", h.GitStatus)
	mux.HandleFunc("POST /workspaces/{id}/git/init", h.GitInit)
	mux.HandleFunc("POST /workspaces/{id}/git/checkout", h.GitCheckout)
	mux.HandleFunc("POST /workspaces/{id}/git/push", h.GitPush)
	mux.HandleFunc("POST /workspaces/{id}/git/worktree", h.GitCreateWorktree)
}

func (h *WorkspaceHandler) Stats(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	id := r.PathValue("id")

	ws, err := h.store.Workspaces().Get(ctx, models.WorkspaceID(id))
	branches := []string{}
	if err != nil {
		utils.WriteError(w, http.StatusNotFound, "workspace not found")
		return
	}

	convID := r.URL.Query().Get("conversation_id")
	convModelID := models.ConversationID(convID)

	inputTokens := 0
	outputTokens := 0
	cachedTokens := 0
	latestPromptTokens := 0
	cost := 0.0
	contextLimit := contextWindowLimitForModel(h.model)

	// If a specific conversation is requested, count its tokens
	if convID != "" {
		msgs, err := h.store.Messages().GetRange(ctx, models.ConversationID(convID), 1, 999999)
		if err == nil {
			for _, msg := range msgs {
				if msg.SentBy == models.SentByAgent && msg.Metadata != nil {
					var in, out, cache float64

					if v, ok := msg.Metadata["tokens_input"].(float64); ok {
						in = v
						inputTokens += int(in)
						latestPromptTokens = int(in)
					}
					if v, ok := msg.Metadata["tokens_output"].(float64); ok {
						out = v
						outputTokens += int(out)
					}
					if v, ok := msg.Metadata["tokens_cached"].(float64); ok {
						cache = v
						cachedTokens += int(cache)
					}

					billedIn := in - cache
					if billedIn < 0 {
						billedIn = 0
					}

					if in <= 200000 {
						cost += (billedIn / 1000000.0) * 2.00
						cost += (out / 1000000.0) * 12.00
					} else {
						cost += (billedIn / 1000000.0) * 4.00
						cost += (out / 1000000.0) * 18.00
					}
					cost += (cache / 1000000.0) * 0.20
				}
			}
		}

		// Also get all branches
		listCmd := exec.CommandContext(r.Context(), "git", "branch", "--format=%(refname:short)")
		listCmd.Dir = ws.RootPath
		if lOut, lErr := listCmd.Output(); lErr == nil {
			for _, b := range strings.Split(strings.TrimSpace(string(lOut)), "\n") {
				b = strings.TrimSpace(b)
				if b != "" {
					branches = append(branches, b)
				}
			}
		}
	}

	linesAdded := 0
	linesDeleted := 0
	if convID != "" {
		if added, deleted, err := h.conversationLineStats(ctx, convModelID); err == nil {
			linesAdded = added
			linesDeleted = deleted
		}
	}

	resp := map[string]any{
		"lines_added":          linesAdded,
		"lines_deleted":        linesDeleted,
		"tokens_input":         inputTokens,
		"tokens_output":        outputTokens,
		"tokens_cached":        cachedTokens,
		"latest_prompt_tokens": latestPromptTokens,
		"tokens_total":         inputTokens + outputTokens,
		"context_limit":        contextLimit,
		"context_percent":      contextPercent(latestPromptTokens, contextLimit),
		"model":                h.model,
		"cost":                 cost,
		"branches":             branches,
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}

func (h *WorkspaceHandler) Create(w http.ResponseWriter, r *http.Request) {
	var ws models.Workspace
	if err := json.NewDecoder(r.Body).Decode(&ws); err != nil {
		utils.WriteError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if ws.ID == "" {
		utils.WriteError(w, http.StatusBadRequest, "workspace id is required")
		return
	}

	if err := h.store.Workspaces().Create(r.Context(), &ws); err != nil {
		if strings.Contains(err.Error(), "UNIQUE constraint") {
			utils.WriteError(w, http.StatusConflict, "workspace already exists")
			return
		}
		utils.WriteError(w, http.StatusInternalServerError, err.Error())
		return
	}

	utils.WriteJSON(w, http.StatusCreated, ws)
}

func (h *WorkspaceHandler) Get(w http.ResponseWriter, r *http.Request) {
	id := models.WorkspaceID(r.PathValue("id"))
	ws, err := h.store.Workspaces().Get(r.Context(), id)
	if err != nil {
		if strings.Contains(err.Error(), "not found") {
			utils.WriteError(w, http.StatusNotFound, err.Error())
			return
		}
		utils.WriteError(w, http.StatusInternalServerError, err.Error())
		return
	}
	utils.WriteJSON(w, http.StatusOK, ws)
}

func (h *WorkspaceHandler) List(w http.ResponseWriter, r *http.Request) {
	workspaces, err := h.store.Workspaces().List(r.Context())
	if err != nil {
		utils.WriteError(w, http.StatusInternalServerError, err.Error())
		return
	}
	utils.WriteJSON(w, http.StatusOK, workspaces)
}

func (h *WorkspaceHandler) Delete(w http.ResponseWriter, r *http.Request) {
	id := models.WorkspaceID(r.PathValue("id"))
	if err := h.store.Workspaces().Delete(r.Context(), id); err != nil {
		utils.WriteError(w, http.StatusInternalServerError, err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *WorkspaceHandler) GitStatus(w http.ResponseWriter, r *http.Request) {
	id := models.WorkspaceID(r.PathValue("id"))
	ws, err := h.store.Workspaces().Get(r.Context(), id)
	if err != nil {
		utils.WriteError(w, http.StatusNotFound, "workspace not found")
		return
	}

	cmd := exec.CommandContext(r.Context(), "git", "rev-parse", "--is-inside-work-tree")
	cmd.Dir = ws.RootPath
	err = cmd.Run()
	isInit := err == nil

	branch := ""
	branches := []string{}
	worktrees := []map[string]string{}
	hasCommits := false
	hasUpstreamChanges := false
	if isInit {
		headCmd := exec.CommandContext(r.Context(), "git", "rev-parse", "--verify", "HEAD")
		headCmd.Dir = ws.RootPath
		hasCommits = headCmd.Run() == nil

		bCmd := exec.CommandContext(r.Context(), "git", "branch", "--show-current")
		bCmd.Dir = ws.RootPath
		out, _ := bCmd.Output()
		branch = strings.TrimSpace(string(out))
		if branch == "" {
			// If empty, it might be an empty repo. Let's try to get default branch config.
			dCmd := exec.CommandContext(r.Context(), "git", "config", "--get", "init.defaultBranch")
			dCmd.Dir = ws.RootPath
			dOut, _ := dCmd.Output()
			branch = strings.TrimSpace(string(dOut))
			if branch == "" {
				branch = "main"
			}
		}

		listCmd := exec.CommandContext(r.Context(), "git", "branch", "--format=%(refname:short)")
		listCmd.Dir = ws.RootPath
		if lOut, lErr := listCmd.Output(); lErr == nil {
			for _, b := range strings.Split(strings.TrimSpace(string(lOut)), "\n") {
				b = strings.TrimSpace(b)
				if b != "" {
					branches = append(branches, b)
				}
			}
		}

		wtCmd := exec.CommandContext(r.Context(), "git", "worktree", "list", "--porcelain")
		wtCmd.Dir = ws.RootPath
		if wOut, wErr := wtCmd.Output(); wErr == nil {
			var currentPath string
			for _, line := range strings.Split(string(wOut), "\n") {
				if strings.HasPrefix(line, "worktree ") {
					currentPath = strings.TrimPrefix(line, "worktree ")
				} else if strings.HasPrefix(line, "branch refs/heads/") && currentPath != "" {
					b := strings.TrimPrefix(line, "branch refs/heads/")
					worktrees = append(worktrees, map[string]string{
						"path":   currentPath,
						"branch": b,
					})
				}
			}
		}

		// Check for upstream changes to push
		if hasCommits && branch != "" {
			// First check if there are any remotes
			remoteCmd := exec.CommandContext(r.Context(), "git", "remote")
			remoteCmd.Dir = ws.RootPath
			if rOut, rErr := remoteCmd.Output(); rErr == nil && len(strings.TrimSpace(string(rOut))) > 0 {
				// Check if there are changes to push to origin/<branch>
				pushCmd := exec.CommandContext(r.Context(), "git", "rev-list", "origin/"+branch+"..HEAD")
				pushCmd.Dir = ws.RootPath
				if out, err := pushCmd.Output(); err == nil {
					hasUpstreamChanges = len(strings.TrimSpace(string(out))) > 0
				} else {
					// origin/branch doesn't exist, meaning the whole branch needs to be pushed
					hasUpstreamChanges = true
				}
			}
		}
	}

	utils.WriteJSON(w, http.StatusOK, map[string]any{
		"is_initialized":       isInit,
		"has_commits":          hasCommits,
		"has_upstream_changes": hasUpstreamChanges,
		"branch":               branch,
		"branches":             branches,
		"worktrees":            worktrees,
	})
}

func (h *WorkspaceHandler) GitPush(w http.ResponseWriter, r *http.Request) {
	id := models.WorkspaceID(r.PathValue("id"))
	ws, err := h.store.Workspaces().Get(r.Context(), id)
	if err != nil {
		utils.WriteError(w, http.StatusNotFound, "workspace not found")
		return
	}

	var req struct {
		Branch string `json:"branch"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		utils.WriteError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.Branch == "" {
		utils.WriteError(w, http.StatusBadRequest, "branch name is required")
		return
	}

	cmd := exec.CommandContext(r.Context(), "git", "push", "-u", "origin", req.Branch)
	cmd.Dir = ws.RootPath
	if err := cmd.Run(); err != nil {
		utils.WriteError(w, http.StatusInternalServerError, "failed to push branch")
		return
	}
	w.WriteHeader(http.StatusOK)
}

func (h *WorkspaceHandler) GitCheckout(w http.ResponseWriter, r *http.Request) {
	id := models.WorkspaceID(r.PathValue("id"))
	ws, err := h.store.Workspaces().Get(r.Context(), id)
	if err != nil {
		utils.WriteError(w, http.StatusNotFound, "workspace not found")
		return
	}

	var req struct {
		Branch string `json:"branch"`
		Create bool   `json:"create"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		utils.WriteError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.Branch == "" {
		utils.WriteError(w, http.StatusBadRequest, "branch name is required")
		return
	}

	var cmd *exec.Cmd
	if req.Create {
		cmd = exec.CommandContext(r.Context(), "git", "checkout", "-b", req.Branch)
	} else {
		cmd = exec.CommandContext(r.Context(), "git", "checkout", req.Branch)
	}
	cmd.Dir = ws.RootPath
	if err := cmd.Run(); err != nil {
		utils.WriteError(w, http.StatusInternalServerError, "failed to checkout branch")
		return
	}
	w.WriteHeader(http.StatusOK)
}

var homeDir string

type gitWorktreeRequest struct {
	Path   string `json:"path"`
	Branch string `json:"branch"`
	Base   string `json:"base"`
}

func defaultWorktreePath(workspaceRoot, branch string) string {
	if homeDir == "" {
		homeDir, _ = os.UserHomeDir()
	}
	if homeDir == "" {
		homeDir = "/tmp"
	}

	sanitizedBranch := strings.NewReplacer("/", "-", "\\", "-", " ", "-").Replace(branch)
	repoName := filepath.Base(filepath.Clean(workspaceRoot))
	return filepath.Join(homeDir, ".gemini-loop", "worktrees", repoName, sanitizedBranch)
}

func normalizeWorktreePath(workspaceRoot, requestedPath string) (string, error) {
	trimmed := strings.TrimSpace(requestedPath)
	if trimmed == "" {
		return "", nil
	}
	if filepath.IsAbs(trimmed) {
		return filepath.Clean(trimmed), nil
	}
	return filepath.Abs(filepath.Join(workspaceRoot, trimmed))
}

func gitBranchNameValid(ctx context.Context, repoPath, branch string) bool {
	cmd := exec.CommandContext(ctx, "git", "check-ref-format", "--branch", branch)
	cmd.Dir = repoPath
	return cmd.Run() == nil
}

func (h *WorkspaceHandler) GitCreateWorktree(w http.ResponseWriter, r *http.Request) {
	id := models.WorkspaceID(r.PathValue("id"))
	ws, err := h.store.Workspaces().Get(r.Context(), id)
	if err != nil {
		utils.WriteError(w, http.StatusNotFound, "workspace not found")
		return
	}

	var req gitWorktreeRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		utils.WriteError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	req.Branch = strings.TrimSpace(req.Branch)
	req.Base = strings.TrimSpace(req.Base)
	if req.Branch == "" {
		utils.WriteError(w, http.StatusBadRequest, "branch is required")
		return
	}
	if !gitBranchNameValid(r.Context(), ws.RootPath, req.Branch) {
		utils.WriteError(w, http.StatusBadRequest, "invalid branch name")
		return
	}

	resolvedPath, err := normalizeWorktreePath(ws.RootPath, req.Path)
	if err != nil {
		utils.WriteError(w, http.StatusBadRequest, "invalid worktree path")
		return
	}
	if resolvedPath == "" {
		resolvedPath = defaultWorktreePath(ws.RootPath, req.Branch)
	}
	req.Path = resolvedPath

	if err := os.MkdirAll(filepath.Dir(req.Path), 0o755); err != nil {
		utils.WriteError(w, http.StatusInternalServerError, "failed to prepare worktree directory")
		return
	}

	args := []string{"worktree", "add", "-b", req.Branch, req.Path}
	if req.Base != "" {
		args = append(args, req.Base)
	}

	cmd := exec.CommandContext(r.Context(), "git", args...)
	cmd.Dir = ws.RootPath
	output, err := cmd.CombinedOutput()
	if err != nil {
		message := strings.TrimSpace(string(output))
		if message == "" {
			message = "failed to create worktree"
		}
		utils.WriteError(w, http.StatusInternalServerError, message)
		return
	}

	utils.WriteJSON(w, http.StatusOK, map[string]string{
		"path":   req.Path,
		"branch": req.Branch,
		"base":   req.Base,
	})
}

func (h *WorkspaceHandler) GitInit(w http.ResponseWriter, r *http.Request) {
	id := models.WorkspaceID(r.PathValue("id"))
	ws, err := h.store.Workspaces().Get(r.Context(), id)
	if err != nil {
		utils.WriteError(w, http.StatusNotFound, "workspace not found")
		return
	}

	if err := os.MkdirAll(ws.RootPath, 0755); err != nil {
		utils.WriteError(w, http.StatusInternalServerError, "failed to create workspace directory")
		return
	}
	cmd := exec.CommandContext(r.Context(), "git", "init")
	cmd.Dir = ws.RootPath
	if err := cmd.Run(); err != nil {
		utils.WriteError(w, http.StatusInternalServerError, "failed to initialize git")
		return
	}
	w.WriteHeader(http.StatusOK)
}

func workspaceLineStats(ctx context.Context, rootPath string) (int, int) {
	linesAdded := 0
	linesDeleted := 0

	cmd := exec.CommandContext(ctx, "git", "diff", "HEAD", "--numstat")
	cmd.Dir = rootPath
	out, err := cmd.Output()
	if err != nil {
		return 0, 0
	}

	lines := strings.Split(string(out), "\n")
	for _, line := range lines {
		parts := strings.Fields(line)
		if len(parts) < 2 {
			continue
		}
		if parts[0] != "-" {
			if a, err := strconv.Atoi(parts[0]); err == nil {
				linesAdded += a
			}
		}
		if parts[1] != "-" {
			if d, err := strconv.Atoi(parts[1]); err == nil {
				linesDeleted += d
			}
		}
	}
	return linesAdded, linesDeleted
}

func (h *WorkspaceHandler) conversationLineStats(ctx context.Context, convID models.ConversationID) (int, int, error) {
	evts, err := h.store.UIEvents().GetByConversation(ctx, convID)
	if err != nil {
		return 0, 0, err
	}

	patchByCallID := map[string]string{}
	successByCallID := map[string]bool{}

	for _, evt := range evts {
		if evt == nil || evt.Metadata == nil {
			continue
		}
		toolName, _ := evt.Metadata["tool_name"].(string)
		if toolName != "apply_patch" {
			continue
		}
		callID, _ := evt.Metadata["call_id"].(string)
		if strings.TrimSpace(callID) == "" {
			continue
		}

		switch evt.Kind {
		case models.UIEventKindToolStart:
			rawArgs, _ := evt.Metadata["args"].(string)
			if strings.TrimSpace(rawArgs) == "" {
				continue
			}
			var parsed struct {
				Input string `json:"input"`
			}
			if err := json.Unmarshal([]byte(rawArgs), &parsed); err != nil {
				continue
			}
			if strings.TrimSpace(parsed.Input) == "" {
				continue
			}
			patchByCallID[callID] = parsed.Input
		case models.UIEventKindToolResult:
			success, ok := evt.Metadata["success"].(bool)
			if ok {
				successByCallID[callID] = success
			}
		}
	}

	linesAdded := 0
	linesDeleted := 0
	for callID, patch := range patchByCallID {
		if !successByCallID[callID] {
			continue
		}
		added, deleted := countPatchLineChanges(patch)
		linesAdded += added
		linesDeleted += deleted
	}

	return linesAdded, linesDeleted, nil
}

func countPatchLineChanges(patch string) (int, int) {
	added := 0
	deleted := 0

	for _, line := range strings.Split(patch, "\n") {
		switch {
		case strings.HasPrefix(line, "+++"), strings.HasPrefix(line, "---"):
			continue
		case strings.HasPrefix(line, "+"):
			added++
		case strings.HasPrefix(line, "-"):
			deleted++
		}
	}

	return added, deleted
}

func contextWindowLimitForModel(model string) int {
	normalized := strings.ToLower(strings.TrimSpace(model))
	switch normalized {
	case "gemini-3.1-pro-preview":
		return 1048576
	case "gemini-1.5-pro":
		return 2000000
	default:
		return 2000000
	}
}

func contextPercent(promptTokens int, contextLimit int) float64 {
	if contextLimit <= 0 || promptTokens <= 0 {
		return 0
	}
	return math.Min((float64(promptTokens)/float64(contextLimit))*100, 100)
}
