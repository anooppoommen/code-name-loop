package toolmeta

import (
	"encoding/json"
	"sort"
	"strings"

	"loop/agent/tools/shellparser"
)

type ToolTag string

const (
	TagRead      ToolTag = "read"
	TagDiscovery ToolTag = "discovery"
	TagWrite     ToolTag = "write"
)

func Classify(toolName string, args json.RawMessage) []string {
	tags := classify(canonicalToolName(toolName), args)
	if len(tags) == 0 {
		return nil
	}
	out := make([]string, 0, len(tags))
	for _, tag := range tags {
		out = append(out, string(tag))
	}
	sort.Strings(out)
	return out
}

func classify(toolName string, args json.RawMessage) []ToolTag {
	switch toolName {
	case "read_file":
		return []ToolTag{TagRead}
	case "grep_files", "list_dir":
		return []ToolTag{TagDiscovery}
	case "apply_patch":
		return []ToolTag{TagWrite}
	case "shell", "exec_command":
		return classifyCommandTool(toolName, args)
	case "parallel_tool_use":
		return classifyParallelToolUse(args)
	default:
		return nil
	}
}

func classifyCommandTool(toolName string, args json.RawMessage) []ToolTag {
	var payload map[string]any
	if err := json.Unmarshal(args, &payload); err != nil {
		return nil
	}

	var command string
	switch canonicalToolName(toolName) {
	case "shell":
		command, _ = payload["command"].(string)
	case "exec_command":
		command, _ = payload["cmd"].(string)
	}
	command = strings.TrimSpace(command)
	if command == "" {
		return nil
	}

	resolution, err := shellparser.ResolveTargets(command, "")
	if err != nil {
		return nil
	}

	tagSet := make(map[ToolTag]struct{})
	if len(resolution.TargetsByAccess(shellparser.AccessWrite, shellparser.AccessDelete)) > 0 ||
		len(resolution.UnknownByAccess(shellparser.AccessWrite, shellparser.AccessDelete)) > 0 {
		tagSet[TagWrite] = struct{}{}
	}
	if len(resolution.TargetsByAccess(shellparser.AccessSearch, shellparser.AccessList)) > 0 ||
		len(resolution.UnknownByAccess(shellparser.AccessSearch, shellparser.AccessList)) > 0 {
		tagSet[TagDiscovery] = struct{}{}
	}
	if len(resolution.TargetsByAccess(shellparser.AccessRead, shellparser.AccessMetadata)) > 0 ||
		len(resolution.UnknownByAccess(shellparser.AccessRead, shellparser.AccessMetadata)) > 0 {
		tagSet[TagRead] = struct{}{}
	}

	if len(tagSet) == 0 {
		for _, cmd := range resolution.Analysis.Commands {
			switch strings.ToLower(cmd.Name) {
			case "ls", "find", "tree", "rg", "grep", "fd":
				tagSet[TagDiscovery] = struct{}{}
			case "cat", "head", "tail", "wc", "stat", "file", "git", "node", "npm", "npx", "pnpm", "yarn", "bun", "bunx", "cargo", "rustc", "make", "gmake", "just":
				tagSet[TagRead] = struct{}{}
			case "cp", "mv", "rm", "patch", "tee", "touch", "truncate", "mkdir", "install", "sed", "perl":
				tagSet[TagWrite] = struct{}{}
			}
		}
	}

	return sortedTags(tagSet)
}

func classifyParallelToolUse(args json.RawMessage) []ToolTag {
	var payload struct {
		ToolUses []struct {
			Name       string          `json:"name"`
			Arguments  json.RawMessage `json:"arguments"`
			Recipient  string          `json:"recipient_name"`
			Parameters json.RawMessage `json:"parameters"`
		} `json:"tool_uses"`
	}
	if err := json.Unmarshal(args, &payload); err != nil {
		return nil
	}

	tagSet := make(map[ToolTag]struct{})
	for _, use := range payload.ToolUses {
		name := use.Name
		argPayload := use.Arguments
		if name == "" {
			name = use.Recipient
			argPayload = use.Parameters
		}
		if name == "" {
			continue
		}
		name = canonicalToolName(name)
		for _, tag := range classify(name, argPayload) {
			tagSet[tag] = struct{}{}
		}
	}
	return sortedTags(tagSet)
}

func sortedTags(tagSet map[ToolTag]struct{}) []ToolTag {
	if len(tagSet) == 0 {
		return nil
	}
	tags := make([]ToolTag, 0, len(tagSet))
	for tag := range tagSet {
		tags = append(tags, tag)
	}
	sort.Slice(tags, func(i, j int) bool { return tags[i] < tags[j] })
	return tags
}

func canonicalToolName(raw string) string {
	name := strings.ToLower(strings.TrimSpace(raw))
	if idx := strings.LastIndex(name, ":"); idx >= 0 && idx < len(name)-1 {
		name = name[idx+1:]
	}
	if idx := strings.LastIndex(name, "."); idx >= 0 && idx < len(name)-1 {
		name = name[idx+1:]
	}
	return name
}
