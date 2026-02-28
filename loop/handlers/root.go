package handlers

import (
	"loop/utils"
	"net/http"
)

// HandleRoot handles requests to the root endpoint.
func HandleRoot(w http.ResponseWriter, r *http.Request) {
	response := map[string]string{
		"message": "Hello, world! This is a simple Go server.",
		"status":  "success",
	}

	utils.WriteJSON(w, http.StatusOK, response)
}

// HandleHealth provides a basic health check endpoint.
func HandleHealth(w http.ResponseWriter, r *http.Request) {
	utils.WriteJSON(w, http.StatusOK, map[string]string{"status": "healthy"})
}
