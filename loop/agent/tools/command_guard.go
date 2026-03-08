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

	for _, ct := range resolution.Commands {
		allowDerivedArtifactWrites := commandAllowsDerivedArtifactWrites(ct.Command)

		for _, unknown := range ct.Unknown {
			switch unknown.Access {
			case shellparser.AccessWrite:
				if allowDerivedArtifactWrites {
					continue
				}
				return fmt.Errorf("direct filesystem mutation in shell/exec_command is blocked; use apply_patch directly for workspace edits and do not retry mutation via shell")
			case shellparser.AccessDelete:
				return fmt.Errorf("direct filesystem mutation in shell/exec_command is blocked; use apply_patch directly for workspace edits and do not retry mutation via shell")
			}
		}

		for _, target := range ct.Targets {
			if target.Access != shellparser.AccessWrite && target.Access != shellparser.AccessDelete {
				continue
			}

			candidate := target.Path
			if candidate == "" {
				candidate = sanitizeRedirectTarget(target.Raw)
			}
			if target.FromRedirect {
				sanitized := sanitizeRedirectTarget(target.Raw)
				if sanitized != "" && sanitized[0] == '&' {
					continue
				}
				if sanitized != "" && sanitized[0] != '&' && !isAllowedNonWorkspaceWriteTarget(sanitized) {
					return fmt.Errorf("writing files via shell redirection is blocked; use apply_patch directly for workspace edits and do not retry with shell redirection")
				}
				continue
			}
			if target.Access == shellparser.AccessWrite {
				if candidate != "" && isAllowedNonWorkspaceWriteTarget(candidate) {
					continue
				}
				if allowDerivedArtifactWrites {
					continue
				}
			}
			return fmt.Errorf("direct filesystem mutation in shell/exec_command is blocked; use apply_patch directly for workspace edits and do not retry mutation via shell")
		}
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

func commandAllowsDerivedArtifactWrites(cmd *shellparser.Command) bool {
	if cmd == nil {
		return false
	}

	switch strings.ToLower(strings.TrimSpace(cmd.Name)) {
	case "go":
		subcmd, _ := splitGoSubcommandForPolicy(cmd.Args[1:])
		switch subcmd {
		case "build", "run", "test", "vet":
			return true
		}
	case "cargo":
		subcmd, _ := splitSubcommandForPolicy(cmd.Args[1:])
		switch subcmd {
		case "bench", "build", "check", "clippy", "doc", "run", "rustc", "test":
			return true
		}
	case "npm", "pnpm", "yarn", "bun":
		return packageManagerAllowsDerivedArtifactWrites(cmd.Args[1:])
	case "make", "gmake", "just":
		return taskRunnerAllowsDerivedArtifactWrites(cmd.Args[1:])
	}

	return false
}

func splitGoSubcommandForPolicy(args []string) (string, []string) {
	for i := 0; i < len(args); i++ {
		arg := args[i]
		switch {
		case arg == "-C":
			i++
		case strings.HasPrefix(arg, "-C="):
		case strings.HasPrefix(arg, "-"):
		default:
			return strings.ToLower(arg), args[i+1:]
		}
	}
	return "", nil
}

func splitSubcommandForPolicy(args []string) (string, []string) {
	for i := 0; i < len(args); i++ {
		arg := args[i]
		if arg == "--" {
			break
		}
		if strings.HasPrefix(arg, "-") {
			if optionLikelyConsumesValueForPolicy(arg) && i+1 < len(args) && !strings.HasPrefix(args[i+1], "-") {
				i++
			}
			continue
		}
		return strings.ToLower(arg), args[i+1:]
	}
	return "", nil
}

func firstNonFlagArgForPolicy(args []string) string {
	for i := 0; i < len(args); i++ {
		arg := args[i]
		if arg == "--" {
			if i+1 < len(args) {
				return args[i+1]
			}
			return ""
		}
		if strings.HasPrefix(arg, "-") {
			if optionLikelyConsumesValueForPolicy(arg) && i+1 < len(args) && !strings.HasPrefix(args[i+1], "-") {
				i++
			}
			continue
		}
		return arg
	}
	return ""
}

func optionLikelyConsumesValueForPolicy(arg string) bool {
	if strings.Contains(arg, "=") {
		return false
	}
	switch arg {
	case "-C", "-f", "-d", "-w", "--cwd", "--dir", "--prefix", "--manifest-path", "--target-dir", "--out-dir", "--outfile", "--justfile", "--file":
		return true
	default:
		return false
	}
}

func packageManagerAllowsDerivedArtifactWrites(args []string) bool {
	subcmd, rest := splitSubcommandForPolicy(args)
	switch subcmd {
	case "run", "run-script":
		return nameImpliesDerivedArtifactWrites(firstNonFlagArgForPolicy(rest))
	case "build":
		return true
	default:
		return false
	}
}

func taskRunnerAllowsDerivedArtifactWrites(args []string) bool {
	goals := taskRunnerGoalsForPolicy(args)
	if len(goals) == 0 {
		return false
	}
	for _, goal := range goals {
		if !nameImpliesDerivedArtifactWrites(goal) {
			return false
		}
	}
	return true
}

func taskRunnerGoalsForPolicy(args []string) []string {
	var goals []string
	for i := 0; i < len(args); i++ {
		arg := args[i]
		if arg == "--" {
			goals = append(goals, args[i+1:]...)
			break
		}
		if strings.HasPrefix(arg, "-") {
			if optionLikelyConsumesValueForPolicy(arg) && i+1 < len(args) && !strings.HasPrefix(args[i+1], "-") {
				i++
			}
			continue
		}
		goals = append(goals, arg)
	}
	return goals
}

func nameImpliesDerivedArtifactWrites(name string) bool {
	normalized := strings.ToLower(strings.TrimSpace(name))
	switch {
	case normalized == "":
		return false
	case strings.Contains(normalized, "build"),
		strings.Contains(normalized, "bundle"),
		strings.Contains(normalized, "compile"),
		strings.Contains(normalized, "generate"),
		strings.Contains(normalized, "dist"),
		strings.Contains(normalized, "release"),
		strings.Contains(normalized, "deploy"),
		strings.Contains(normalized, "pack"):
		return true
	default:
		return false
	}
}

func isAllowedNonWorkspaceWriteTarget(path string) bool {
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
