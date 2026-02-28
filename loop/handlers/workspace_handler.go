package handlers

import (
	"encoding/json"
	"net/http"
	"strings"

	"loop/models"
	"loop/store"
	"loop/utils"
)

// WorkspaceHandler handles workspace REST endpoints.
// Only user-facing endpoints are exposed: Create, Get, List.
type WorkspaceHandler struct {
	store store.Store
}

func NewWorkspaceHandler(s store.Store) *WorkspaceHandler {
	return &WorkspaceHandler{store: s}
}

// RegisterRoutes registers workspace routes on the given mux.
func (h *WorkspaceHandler) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("POST /workspaces", h.Create)
	mux.HandleFunc("GET /workspaces", h.List)
	mux.HandleFunc("GET /workspaces/{id}", h.Get)
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
