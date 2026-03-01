package tools

import (
	"context"
	"fmt"
	"path/filepath"
	"regexp"
	"strings"
)

var (
	mutatingCommandRe = regexp.MustCompile(`(?i)(^|[;&|]\s*)(cp|mv|rm|touch|truncate|install|mkdir)\b`)
	inlineEditRe      = regexp.MustCompile(`(?i)(^|[;&|]\s*)(sed\s+-i|perl\s+-pi)\b`)
	redirectionRe     = regexp.MustCompile(`\s>+?\s*([^\s;|&]+)`)
	// These command forms can surface .gitignore-excluded files in bulk output.
	gitignoreBypassScanRe = regexp.MustCompile(`(?i)(^|[;&|]\s*)(find|tree)\b|(^|[;&|]\s*)ls\b[^|;&\n]*\s-R\b`)
	// These flags disable ignore behavior when used with common recursive search tools.
	gitignoreBypassRgFlagsRe = regexp.MustCompile(`(?i)(^|[;&|]\s*)rg\b[^|;&\n]*(--no-ignore(?:-vcs|-parent)?\b|\s-u{1,3}\b)`)
	gitignoreBypassFdFlagsRe = regexp.MustCompile(`(?i)(^|[;&|]\s*)fd\b[^|;&\n]*(--no-ignore\b|\s-I\b|\s-u{1,3}\b)`)
)

func validateWorkspaceEditPolicy(command string) error {
	cmd := strings.TrimSpace(command)
	if cmd == "" {
		return nil
	}

	if mutatingCommandRe.MatchString(cmd) || inlineEditRe.MatchString(cmd) {
		return fmt.Errorf("direct filesystem mutation in shell/exec_command is blocked; use apply_patch directly for workspace edits and do not retry mutation via shell")
	}

	matches := redirectionRe.FindAllStringSubmatch(cmd, -1)
	for _, m := range matches {
		if len(m) < 2 {
			continue
		}
		target := sanitizeRedirectTarget(m[1])
		if target == "" || target[0] == '&' {
			continue
		}
		if isAllowedRedirectTarget(target) {
			continue
		}
		return fmt.Errorf("writing files via shell redirection is blocked; use apply_patch directly for workspace edits and do not retry with shell redirection")
	}

	return nil
}

func validateGitIgnoreReadPolicy(
	ctx context.Context,
	command string,
	workdir string,
	guard *pathGuard,
) error {
	cmd := strings.TrimSpace(command)
	if cmd == "" {
		return nil
	}
	if guard == nil {
		return nil
	}
	if gitignoreBypassScanRe.MatchString(cmd) {
		return fmt.Errorf("command can enumerate .gitignore-excluded paths; use structured tools (list_dir/grep_files/read_file) or rg-based queries that respect .gitignore")
	}
	if gitignoreBypassRgFlagsRe.MatchString(cmd) || gitignoreBypassFdFlagsRe.MatchString(cmd) {
		return fmt.Errorf("command disables ignore rules; avoid --no-ignore/-u style flags so .gitignore-excluded paths stay out of model context")
	}

	for _, token := range extractPathLikeTokens(cmd) {
		candidate := token
		if !filepath.IsAbs(candidate) {
			candidate = filepath.Join(workdir, candidate)
		}
		if err := guard.rejectIfGitIgnored(ctx, candidate, false); err != nil {
			return fmt.Errorf("command targets a .gitignore-excluded path (%s); use include_ignored only when the user explicitly asks for ignored files", token)
		}
	}
	return nil
}

func extractPathLikeTokens(command string) []string {
	rawTokens := strings.Fields(command)
	if len(rawTokens) == 0 {
		return nil
	}
	tokens := make([]string, 0, len(rawTokens))
	for _, raw := range rawTokens {
		token := strings.TrimSpace(raw)
		token = strings.Trim(token, `"'()[]{},`)
		if token == "" {
			continue
		}
		if strings.HasPrefix(token, "-") || strings.HasPrefix(token, "$") {
			continue
		}
		if strings.ContainsAny(token, "*?[]{}") {
			continue
		}
		if !(filepath.IsAbs(token) || strings.HasPrefix(token, "./") || strings.HasPrefix(token, "../") || strings.Contains(token, "/")) {
			continue
		}
		tokens = append(tokens, token)
	}
	return dedupeStrings(tokens)
}

func sanitizeRedirectTarget(raw string) string {
	trimmed := strings.TrimSpace(raw)
	trimmed = strings.Trim(trimmed, `"'`)
	return trimmed
}

func isAllowedRedirectTarget(path string) bool {
	switch {
	case path == "/dev/null":
		return true
	case strings.HasPrefix(path, "/tmp/"):
		return true
	case strings.HasPrefix(path, "/private/tmp/"):
		return true
	case strings.HasPrefix(path, "/var/folders/"):
		return true
	}
	return false
}
