SHELL := /bin/bash

ROOT_DIR := $(abspath .)
LOOP_DIR := $(ROOT_DIR)/loop
DESKTOP_DIR := $(ROOT_DIR)/loop-desktop
RUN_DIR := $(ROOT_DIR)/.run

LOOP_PORT ?= :8080
LOOP_DB_PATH ?= loop.db
LOOP_HOST ?= localhost

BACKEND_PID_FILE := $(RUN_DIR)/backend.pid
DESKTOP_PID_FILE := $(RUN_DIR)/desktop.pid
BACKEND_LOG := $(RUN_DIR)/backend.log
DESKTOP_LOG := $(RUN_DIR)/desktop.log

.PHONY: help dev backend desktop stop status logs clean

help:
	@echo "Targets:"
	@echo "  make dev      - start Go API + Electron app with cleanup"
	@echo "  make backend  - start Go API only (foreground)"
	@echo "  make desktop  - start Electron app only (foreground)"
	@echo "  make stop     - stop processes started by make dev"
	@echo "  make status   - show process/listener status"
	@echo "  make logs     - tail backend + desktop logs"
	@echo "  make clean    - remove runtime pid/log files"
	@echo ""
	@echo "Config vars (override inline):"
	@echo "  LOOP_PORT=:8080 LOOP_DB_PATH=loop.db LOOP_HOST=localhost"

backend:
	@cd "$(LOOP_DIR)" && LOOP_PORT="$(LOOP_PORT)" LOOP_DB_PATH="$(LOOP_DB_PATH)" go run .

desktop:
	@cd "$(DESKTOP_DIR)" && npm run dev

dev:
	@bash -lc 'set -euo pipefail; \
	mkdir -p "$(RUN_DIR)"; \
	if [ ! -d "$(DESKTOP_DIR)/node_modules" ]; then \
	  echo "[dev] installing desktop dependencies..."; \
	  (cd "$(DESKTOP_DIR)" && npm install); \
	fi; \
	stop_tree() { \
	  local pid="$$1"; \
	  if [ -z "$$pid" ] || ! kill -0 "$$pid" 2>/dev/null; then return 0; fi; \
	  local children; \
	  children=$$(pgrep -P "$$pid" || true); \
	  for child in $$children; do stop_tree "$$child"; done; \
	  kill "$$pid" 2>/dev/null || true; \
	}; \
	cleanup() { \
	  for f in "$(DESKTOP_PID_FILE)" "$(BACKEND_PID_FILE)"; do \
	    if [ -f "$$f" ]; then \
	      pid=$$(cat "$$f" 2>/dev/null || true); \
	      stop_tree "$$pid"; \
	      rm -f "$$f"; \
	    fi; \
	  done; \
	}; \
	trap cleanup EXIT INT TERM; \
	echo "[dev] starting backend (LOOP_PORT=$(LOOP_PORT), LOOP_DB_PATH=$(LOOP_DB_PATH))"; \
	LOOP_PORT_VALUE="$(LOOP_PORT)"; \
	(cd "$(LOOP_DIR)" && LOOP_PORT="$(LOOP_PORT)" LOOP_DB_PATH="$(LOOP_DB_PATH)" go run . >>"$(BACKEND_LOG)" 2>&1) & \
	BACK_PID=$$!; \
	echo "$$BACK_PID" > "$(BACKEND_PID_FILE)"; \
	PORT_NUM="$${LOOP_PORT_VALUE#:}"; \
	for i in $$(seq 1 80); do \
	  if curl -fsS "http://$(LOOP_HOST):$$PORT_NUM/health" >/dev/null 2>&1; then \
	    echo "[dev] backend healthy on http://$(LOOP_HOST):$$PORT_NUM"; \
	    break; \
	  fi; \
	  if ! kill -0 "$$BACK_PID" 2>/dev/null; then \
	    echo "[dev] backend exited early. Check $(BACKEND_LOG)"; \
	    exit 1; \
	  fi; \
	  if [ $$i -eq 80 ]; then \
	    echo "[dev] backend health check timeout. Check $(BACKEND_LOG)"; \
	    exit 1; \
	  fi; \
	  sleep 0.25; \
	done; \
	echo "[dev] starting desktop app"; \
	(cd "$(DESKTOP_DIR)" && npm run dev >>"$(DESKTOP_LOG)" 2>&1) & \
	DESK_PID=$$!; \
	echo "$$DESK_PID" > "$(DESKTOP_PID_FILE)"; \
	echo "[dev] backend pid=$$BACK_PID, desktop pid=$$DESK_PID"; \
	echo "[dev] logs: $(BACKEND_LOG), $(DESKTOP_LOG)"; \
	while true; do \
	  if ! kill -0 "$$BACK_PID" 2>/dev/null; then \
	    echo "[dev] backend exited"; \
	    wait "$$BACK_PID" || true; \
	    exit 1; \
	  fi; \
	  if ! kill -0 "$$DESK_PID" 2>/dev/null; then \
	    echo "[dev] desktop exited"; \
	    wait "$$DESK_PID" || true; \
	    exit 1; \
	  fi; \
	  sleep 1; \
	done'

stop:
	@bash -lc 'set -euo pipefail; \
	stop_tree() { \
	  local pid="$$1"; \
	  if [ -z "$$pid" ] || ! kill -0 "$$pid" 2>/dev/null; then return 0; fi; \
	  local children; \
	  children=$$(pgrep -P "$$pid" || true); \
	  for child in $$children; do stop_tree "$$child"; done; \
	  kill "$$pid" 2>/dev/null || true; \
	}; \
	for f in "$(DESKTOP_PID_FILE)" "$(BACKEND_PID_FILE)"; do \
	  if [ -f "$$f" ]; then \
	    pid=$$(cat "$$f" 2>/dev/null || true); \
	    echo "[stop] stopping pid $$pid from $$f"; \
	    stop_tree "$$pid"; \
	    rm -f "$$f"; \
	  fi; \
	done'

status:
	@echo "[status] pid files:"
	@ls -l "$(RUN_DIR)" 2>/dev/null || true
	@echo ""
	@echo "[status] listeners:"
	@lsof -nP -iTCP:8080 -sTCP:LISTEN || true
	@lsof -nP -iTCP:5173 -sTCP:LISTEN || true
	@echo ""
	@echo "[status] matching processes:"
	@ps -axo pid,ppid,command | rg "go run \\.|/loop$$|electron/main.cjs|vite --|npm run dev" || true

logs:
	@mkdir -p "$(RUN_DIR)"
	@touch "$(BACKEND_LOG)" "$(DESKTOP_LOG)"
	@tail -n 80 -f "$(BACKEND_LOG)" "$(DESKTOP_LOG)"

clean:
	@rm -rf "$(RUN_DIR)"
