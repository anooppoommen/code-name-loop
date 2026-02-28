package tools

import (
	"fmt"
	"regexp"
	"strings"
)

var (
	mutatingCommandRe = regexp.MustCompile(`(?i)(^|[;&|]\s*)(cp|mv|rm|touch|truncate|install|mkdir)\b`)
	inlineEditRe      = regexp.MustCompile(`(?i)(^|[;&|]\s*)(sed\s+-i|perl\s+-pi)\b`)
	redirectionRe     = regexp.MustCompile(`\s>+?\s*([^\s;|&]+)`)
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
