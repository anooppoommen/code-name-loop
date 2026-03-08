package tools

import (
	"context"
	"fmt"
	"strings"

	"loop/agent/tools/shellparser"
)

func validateWorkspaceEditPolicy(command string) error {
	cmd := strings.TrimSpace(command)
	if cmd == "" {
		return nil
	}

	analysis, err := shellparser.Analyze(command)
	if err != nil {
		return fmt.Errorf("failed to parse shell command for workspace edit policy: %w", err)
	}
	return validateWorkspaceEditPolicyAnalysis(analysis)
}

func validateWorkspaceEditPolicyAnalysis(analysis *shellparser.Analysis) error {
	if analysis == nil {
		return nil
	}
	resolution := shellparser.ResolveAnalysisTargets(analysis, "")

	for _, c := range analysis.Commands {
		name := strings.ToLower(c.Name)
		switch name {
		case "cp", "mv", "rm", "touch", "truncate", "install", "mkdir", "rmdir", "patch", "tee":
			return fmt.Errorf("direct filesystem mutation in shell/exec_command is blocked; use apply_patch directly for workspace edits and do not retry mutation via shell")
		case "sed":
			for _, opt := range c.Options {
				if opt.Name == "-i" || opt.Name == "--in-place" || strings.HasPrefix(opt.Name, "--in-place=") || strings.HasPrefix(opt.Raw, "-i") {
					return fmt.Errorf("direct filesystem mutation in shell/exec_command is blocked; use apply_patch directly for workspace edits and do not retry mutation via shell")
				}
			}
		case "perl":
			for _, arg := range c.Args {
				if strings.HasPrefix(arg, "-") && strings.Contains(arg, "p") && strings.Contains(arg, "i") {
					return fmt.Errorf("direct filesystem mutation in shell/exec_command is blocked; use apply_patch directly for workspace edits and do not retry mutation via shell")
				}
			}
		case "git":
			if gitCommandMutatesWorkspace(c.Args[1:]) {
				return fmt.Errorf("direct filesystem mutation in shell/exec_command is blocked; use apply_patch directly for workspace edits and do not retry mutation via shell")
			}
		}

	}

	for _, unknown := range resolution.UnknownByAccess(shellparser.AccessWrite, shellparser.AccessDelete) {
		if unknown.Access == shellparser.AccessWrite || unknown.Access == shellparser.AccessDelete {
			return fmt.Errorf("direct filesystem mutation in shell/exec_command is blocked; use apply_patch directly for workspace edits and do not retry mutation via shell")
		}
	}

	for _, target := range resolution.TargetsByAccess(shellparser.AccessWrite, shellparser.AccessDelete) {
		if target.FromRedirect {
			sanitized := sanitizeRedirectTarget(target.Raw)
			if sanitized != "" && sanitized[0] == '&' {
				continue
			}
			if sanitized != "" && sanitized[0] != '&' && !isAllowedRedirectTarget(sanitized) {
				return fmt.Errorf("writing files via shell redirection is blocked; use apply_patch directly for workspace edits and do not retry with shell redirection")
			}
			continue
		}
		return fmt.Errorf("direct filesystem mutation in shell/exec_command is blocked; use apply_patch directly for workspace edits and do not retry mutation via shell")
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

	analysis, err := shellparser.Analyze(command)
	if err != nil {
		return fmt.Errorf("failed to parse shell command for .gitignore policy: %w", err)
	}
	return validateGitIgnoreReadPolicyAnalysis(ctx, analysis, workdir, guard)
}

func validateGitIgnoreReadPolicyAnalysis(
	ctx context.Context,
	analysis *shellparser.Analysis,
	workdir string,
	guard *pathGuard,
) error {
	if analysis == nil {
		return nil
	}
	resolution := shellparser.ResolveAnalysisTargets(analysis, workdir)

	for _, c := range analysis.Commands {
		name := strings.ToLower(c.Name)
		if name == "find" || name == "tree" {
			return fmt.Errorf("command can enumerate .gitignore-excluded paths; use structured tools (list_dir/grep_files/read_file) or rg-based queries that respect .gitignore")
		}
		if name == "ls" {
			for _, opt := range c.Options {
				if strings.Contains(opt.Raw, "R") {
					return fmt.Errorf("command can enumerate .gitignore-excluded paths; use structured tools (list_dir/grep_files/read_file) or rg-based queries that respect .gitignore")
				}
			}
		}
		if name == "rg" || name == "fd" {
			for _, opt := range c.Options {
				if opt.Raw == "--no-ignore" || opt.Raw == "--no-ignore-vcs" || opt.Raw == "--no-ignore-parent" || opt.Raw == "-u" || opt.Raw == "-uu" || opt.Raw == "-uuu" || opt.Raw == "-I" {
					return fmt.Errorf("command disables ignore rules; avoid --no-ignore/-u style flags so .gitignore-excluded paths stay out of model context")
				}
			}
		}
	}

	for _, target := range resolution.TargetsByAccess(shellparser.AccessRead, shellparser.AccessList, shellparser.AccessSearch, shellparser.AccessMetadata) {
		candidate := target.Path
		if candidate == "" {
			candidate = target.Raw
		}
		if candidate == "" {
			continue
		}
		if err := guard.rejectIfGitIgnored(ctx, candidate, false); err != nil {
			return fmt.Errorf("command targets a .gitignore-excluded path (%s); use include_ignored only when the user explicitly asks for ignored files", target.Raw)
		}
	}
	return nil
}

func gitCommandMutatesWorkspace(args []string) bool {
	if len(args) == 0 {
		return false
	}
	switch strings.ToLower(strings.TrimSpace(args[0])) {
	case "apply", "checkout", "restore", "clean", "reset", "commit", "merge", "rebase", "cherry-pick", "stash", "switch", "add", "mv", "rm":
		return true
	default:
		return false
	}
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
