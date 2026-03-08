package shellparser

import (
	"os"
	"path/filepath"
	"strings"
)

type TargetAccess string

const (
	AccessRead     TargetAccess = "read"
	AccessWrite    TargetAccess = "write"
	AccessDelete   TargetAccess = "delete"
	AccessList     TargetAccess = "list"
	AccessSearch   TargetAccess = "search"
	AccessMetadata TargetAccess = "metadata"
)

type TargetKind string

const (
	KindPath      TargetKind = "path"
	KindFile      TargetKind = "file"
	KindDirectory TargetKind = "directory"
)

type Target struct {
	Command      string
	Raw          string
	Path         string
	Access       TargetAccess
	Kind         TargetKind
	FromRedirect bool
}

type UnknownTarget struct {
	Command string
	Access  TargetAccess
	Reason  string
}

type CommandTargets struct {
	Command *Command
	Targets []Target
	Unknown []UnknownTarget
}

type TargetResolution struct {
	Analysis *Analysis
	Commands []CommandTargets
}

func ResolveTargets(input string, workdir string) (*TargetResolution, error) {
	analysis, err := Analyze(input)
	if err != nil {
		return nil, err
	}
	return ResolveAnalysisTargets(analysis, workdir), nil
}

func ResolveAnalysisTargets(analysis *Analysis, workdir string) *TargetResolution {
	resolution := &TargetResolution{Analysis: analysis}
	if analysis == nil {
		return resolution
	}

	currentWorkdir := workdir
	for _, cmd := range analysis.Commands {
		ct := CommandTargets{Command: cmd}
		resolveRedirectTargets(&ct, currentWorkdir)
		resolveCommandTargets(&ct, currentWorkdir)
		ct.Targets = dedupeTargets(ct.Targets)
		ct.Unknown = dedupeUnknownTargets(ct.Unknown)
		resolution.Commands = append(resolution.Commands, ct)
		currentWorkdir = nextCommandWorkdir(cmd, currentWorkdir)
	}
	return resolution
}

func (r *TargetResolution) TargetsByAccess(accesses ...TargetAccess) []Target {
	if r == nil {
		return nil
	}
	allowed := make(map[TargetAccess]struct{}, len(accesses))
	for _, access := range accesses {
		allowed[access] = struct{}{}
	}
	var out []Target
	for _, cmd := range r.Commands {
		for _, target := range cmd.Targets {
			if _, ok := allowed[target.Access]; ok {
				out = append(out, target)
			}
		}
	}
	return dedupeTargets(out)
}

func (r *TargetResolution) UnknownByAccess(accesses ...TargetAccess) []UnknownTarget {
	if r == nil {
		return nil
	}
	allowed := make(map[TargetAccess]struct{}, len(accesses))
	for _, access := range accesses {
		allowed[access] = struct{}{}
	}
	var out []UnknownTarget
	for _, cmd := range r.Commands {
		for _, unknown := range cmd.Unknown {
			if _, ok := allowed[unknown.Access]; ok {
				out = append(out, unknown)
			}
		}
	}
	return dedupeUnknownTargets(out)
}

type optionArity int

const (
	optionConsumesNothing optionArity = iota
	optionConsumesNext
)

type parsedArgs struct {
	Positionals  []string
	OptionValues map[string][]string
	OptionSet    map[string]bool
}

func resolveCommandTargets(ct *CommandTargets, workdir string) {
	if ct == nil || ct.Command == nil {
		return
	}

	switch strings.ToLower(ct.Command.Name) {
	case "cat":
		resolveCatLike(ct, workdir, AccessRead, nil)
	case "head":
		resolveCatLike(ct, workdir, AccessRead, map[string]optionArity{"-n": optionConsumesNext, "-c": optionConsumesNext, "--bytes": optionConsumesNext, "--lines": optionConsumesNext})
	case "tail":
		resolveCatLike(ct, workdir, AccessRead, map[string]optionArity{"-n": optionConsumesNext, "-c": optionConsumesNext, "--bytes": optionConsumesNext, "--lines": optionConsumesNext})
	case "wc":
		resolveCatLike(ct, workdir, AccessRead, map[string]optionArity{"--files0-from": optionConsumesNext})
	case "stat":
		resolveCatLike(ct, workdir, AccessMetadata, map[string]optionArity{"-f": optionConsumesNext, "-t": optionConsumesNext, "--format": optionConsumesNext, "--printf": optionConsumesNext})
	case "file":
		resolveCatLike(ct, workdir, AccessRead, map[string]optionArity{"-f": optionConsumesNext})
	case "ls":
		resolveLS(ct, workdir)
	case "find":
		resolveFind(ct, workdir)
	case "rg":
		resolveRG(ct, workdir)
	case "grep":
		resolveGrep(ct, workdir)
	case "fd":
		resolveFD(ct, workdir)
	case "git":
		resolveGit(ct, workdir)
	case "go":
		resolveGo(ct, workdir)
	case "node":
		resolveNode(ct, workdir)
	case "npm", "npx":
		resolveNPM(ct, workdir)
	case "pnpm":
		resolvePNPM(ct, workdir)
	case "yarn":
		resolveYarn(ct, workdir)
	case "bun", "bunx":
		resolveBun(ct, workdir)
	case "cargo":
		resolveCargo(ct, workdir)
	case "rustc":
		resolveRustc(ct, workdir)
	case "make", "gmake":
		resolveMake(ct, workdir)
	case "just":
		resolveJust(ct, workdir)
	case "sed":
		resolveSed(ct, workdir)
	case "perl":
		resolvePerl(ct, workdir)
	case "cp":
		resolveCopyLike(ct, workdir)
	case "mv":
		resolveMoveLike(ct, workdir)
	case "rm", "rmdir":
		resolveRemoveLike(ct, workdir)
	case "patch":
		resolvePatch(ct, workdir)
	case "tee":
		resolveTee(ct, workdir)
	case "touch", "truncate", "mkdir", "install":
		resolveDirectWriteCommand(ct, workdir)
	}
}

func resolveRedirectTargets(ct *CommandTargets, workdir string) {
	for _, redir := range ct.Command.Redirects {
		raw := strings.TrimSpace(redir.Target)
		if raw == "" {
			continue
		}
		switch redir.Type {
		case TokenRedirectIn:
			if redir.Heredoc || redir.Operator == "<<<" {
				continue
			}
			addTarget(ct, workdir, raw, AccessRead, KindFile, true)
		case TokenRedirectOut, TokenRedirectAppend, TokenRedirectStderr, TokenRedirectOutAndStderr:
			if isFileDescriptorRedirectTarget(redir.Operator, raw) {
				continue
			}
			addTarget(ct, workdir, raw, AccessWrite, KindFile, true)
		}
	}
}

func resolveCatLike(ct *CommandTargets, workdir string, access TargetAccess, specs map[string]optionArity) {
	parsed := parseArgs(ct.Command.Args[1:], specs)
	for _, path := range parsed.Positionals {
		if path == "-" {
			continue
		}
		addTarget(ct, workdir, path, access, KindFile, false)
	}
}

func resolveLS(ct *CommandTargets, workdir string) {
	parsed := parseArgs(ct.Command.Args[1:], map[string]optionArity{
		"-I":                        optionConsumesNext,
		"--ignore":                  optionConsumesNext,
		"--sort":                    optionConsumesNext,
		"--time-style":              optionConsumesNext,
		"--color":                   optionConsumesNext,
		"--group-directories-first": optionConsumesNothing,
	})
	if len(parsed.Positionals) == 0 {
		addTarget(ct, workdir, ".", AccessList, KindDirectory, false)
		return
	}
	for _, path := range parsed.Positionals {
		addTarget(ct, workdir, path, AccessList, KindPath, false)
	}
}

func resolveFind(ct *CommandTargets, workdir string) {
	args := ct.Command.Args[1:]
	var roots []string
	for _, arg := range args {
		if arg == "--" {
			break
		}
		if strings.HasPrefix(arg, "-") || arg == "(" || arg == ")" || arg == "!" || arg == "," {
			break
		}
		roots = append(roots, arg)
	}
	if len(roots) == 0 {
		roots = []string{"."}
	}
	for _, root := range roots {
		addTarget(ct, workdir, root, AccessSearch, KindDirectory, false)
	}
}

func resolveRG(ct *CommandTargets, workdir string) {
	parsed := parseArgs(ct.Command.Args[1:], map[string]optionArity{
		"-A": optionConsumesNext, "-B": optionConsumesNext, "-C": optionConsumesNext,
		"-e": optionConsumesNext, "-f": optionConsumesNext, "-g": optionConsumesNext,
		"-j": optionConsumesNext, "-m": optionConsumesNext, "-M": optionConsumesNext,
		"-r": optionConsumesNext, "-t": optionConsumesNext, "-T": optionConsumesNext,
		"--after-context": optionConsumesNext, "--before-context": optionConsumesNext, "--color": optionConsumesNext,
		"--colors": optionConsumesNext, "--context": optionConsumesNext, "--encoding": optionConsumesNext,
		"--engine": optionConsumesNext, "--file": optionConsumesNext, "--glob": optionConsumesNext,
		"--ignore-file": optionConsumesNext, "--max-columns": optionConsumesNext, "--max-count": optionConsumesNext,
		"--max-filesize": optionConsumesNext, "--path-separator": optionConsumesNext, "--pre": optionConsumesNext,
		"--regexp": optionConsumesNext, "--replace": optionConsumesNext, "--sort": optionConsumesNext,
		"--sortr": optionConsumesNext, "--type": optionConsumesNext, "--type-not": optionConsumesNext,
	})
	for _, path := range parsed.OptionValues["-f"] {
		addTarget(ct, workdir, path, AccessRead, KindFile, false)
	}
	for _, path := range parsed.OptionValues["--file"] {
		addTarget(ct, workdir, path, AccessRead, KindFile, false)
	}
	for _, path := range parsed.OptionValues["--ignore-file"] {
		addTarget(ct, workdir, path, AccessRead, KindFile, false)
	}

	roots := parsed.Positionals
	if !parsed.OptionSet["-e"] && !parsed.OptionSet["--regexp"] && !parsed.OptionSet["-f"] && !parsed.OptionSet["--file"] && len(roots) > 0 {
		roots = roots[1:]
	}
	if len(roots) == 0 {
		roots = []string{"."}
	}
	for _, root := range roots {
		addTarget(ct, workdir, root, AccessSearch, KindPath, false)
	}
}

func resolveGrep(ct *CommandTargets, workdir string) {
	parsed := parseArgs(ct.Command.Args[1:], map[string]optionArity{
		"-A": optionConsumesNext, "-B": optionConsumesNext, "-C": optionConsumesNext,
		"-D": optionConsumesNext, "-d": optionConsumesNext, "-e": optionConsumesNext,
		"-f": optionConsumesNext, "-m": optionConsumesNext, "--after-context": optionConsumesNext,
		"--before-context": optionConsumesNext, "--binary-files": optionConsumesNext, "--context": optionConsumesNext,
		"--devices": optionConsumesNext, "--directories": optionConsumesNext, "--exclude": optionConsumesNext,
		"--exclude-dir": optionConsumesNext, "--file": optionConsumesNext, "--include": optionConsumesNext,
		"--label": optionConsumesNext, "--regexp": optionConsumesNext,
	})
	for _, path := range parsed.OptionValues["-f"] {
		addTarget(ct, workdir, path, AccessRead, KindFile, false)
	}
	for _, path := range parsed.OptionValues["--file"] {
		addTarget(ct, workdir, path, AccessRead, KindFile, false)
	}

	files := parsed.Positionals
	if !parsed.OptionSet["-e"] && !parsed.OptionSet["--regexp"] && !parsed.OptionSet["-f"] && !parsed.OptionSet["--file"] && len(files) > 0 {
		files = files[1:]
	}
	if len(files) == 0 && (parsed.OptionSet["-r"] || parsed.OptionSet["-R"] || parsed.OptionSet["--recursive"]) {
		files = []string{"."}
	}
	for _, path := range files {
		addTarget(ct, workdir, path, AccessSearch, KindPath, false)
	}
}

func resolveFD(ct *CommandTargets, workdir string) {
	parsed := parseArgs(ct.Command.Args[1:], map[string]optionArity{
		"-c": optionConsumesNext, "-d": optionConsumesNext, "-e": optionConsumesNext,
		"-E": optionConsumesNext, "-g": optionConsumesNothing, "-o": optionConsumesNext,
		"-s": optionConsumesNext, "-t": optionConsumesNext, "-x": optionConsumesNext,
		"--absolute-path": optionConsumesNothing, "--base-directory": optionConsumesNext,
		"--color": optionConsumesNext, "--extension": optionConsumesNext, "--max-depth": optionConsumesNext,
		"--min-depth": optionConsumesNext, "--owner": optionConsumesNext, "--path-separator": optionConsumesNext,
		"--search-path": optionConsumesNext, "--size": optionConsumesNext, "--type": optionConsumesNext,
	})
	roots := parsed.Positionals
	if len(roots) > 0 {
		roots = roots[1:]
	}
	if len(roots) == 0 {
		roots = []string{"."}
	}
	for _, root := range roots {
		addTarget(ct, workdir, root, AccessSearch, KindPath, false)
	}
}

func resolveGit(ct *CommandTargets, workdir string) {
	subcmd, rest := splitGitInvocation(ct.Command.Args[1:])
	switch subcmd {
	case "diff", "status", "ls-files", "log", "show", "checkout", "restore", "add", "rm", "mv":
	default:
		return
	}

	switch subcmd {
	case "show":
		for _, raw := range gitShowTargets(rest) {
			addTarget(ct, workdir, raw, AccessRead, KindPath, false)
		}
	case "diff", "status", "ls-files", "log":
		for _, raw := range gitPathspecTargets(rest) {
			addTarget(ct, workdir, raw, AccessRead, KindPath, false)
		}
	case "checkout", "restore", "add":
		for _, raw := range gitPathspecTargets(rest) {
			addTarget(ct, workdir, raw, AccessWrite, KindPath, false)
		}
	case "rm":
		for _, raw := range gitPathspecTargets(rest) {
			addTarget(ct, workdir, raw, AccessDelete, KindPath, false)
		}
	case "mv":
		paths := gitPathspecTargets(rest)
		if len(paths) >= 2 {
			for _, raw := range paths[:len(paths)-1] {
				addTarget(ct, workdir, raw, AccessDelete, KindPath, false)
			}
			addTarget(ct, workdir, paths[len(paths)-1], AccessWrite, KindPath, false)
		} else if len(paths) > 0 {
			ct.Unknown = append(ct.Unknown, UnknownTarget{Command: ct.Command.Name, Access: AccessWrite, Reason: "git mv destination inferred dynamically"})
		}
	}
}

func resolveGo(ct *CommandTargets, workdir string) {
	subcmd, rest := splitGoInvocation(ct.Command.Args[1:])
	switch subcmd {
	case "build":
		resolveGoBuild(ct, workdir, rest)
	case "test", "run", "vet", "fmt":
		resolveGoReadLike(ct, workdir, rest)
	case "mod":
		resolveGoMod(ct, workdir, rest)
	}
}

func splitGoInvocation(args []string) (string, []string) {
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

func resolveGoBuild(ct *CommandTargets, workdir string, args []string) {
	parsed := parseArgs(args, map[string]optionArity{
		"-o": optionConsumesNext, "-coverprofile": optionConsumesNext,
		"-modfile": optionConsumesNext, "-overlay": optionConsumesNext,
		"-toolexec": optionConsumesNext, "-asmflags": optionConsumesNext,
		"-buildmode": optionConsumesNext, "-compiler": optionConsumesNext,
		"-gcflags": optionConsumesNext, "-gccgoflags": optionConsumesNext,
		"-installsuffix": optionConsumesNext, "-ldflags": optionConsumesNext,
		"-mod": optionConsumesNext, "-pgo": optionConsumesNext,
		"-pkgdir": optionConsumesNext, "-tags": optionConsumesNext,
		"-trimpath": optionConsumesNothing, "-v": optionConsumesNothing,
		"-x": optionConsumesNothing, "-work": optionConsumesNothing,
	})
	for _, path := range parsed.OptionValues["-modfile"] {
		addTarget(ct, workdir, path, AccessRead, KindFile, false)
	}
	for _, path := range parsed.OptionValues["-overlay"] {
		addTarget(ct, workdir, path, AccessRead, KindFile, false)
	}
	for _, path := range parsed.OptionValues["-o"] {
		if path == "/dev/null" {
			addTarget(ct, workdir, path, AccessWrite, KindFile, false)
			continue
		}
		addTarget(ct, workdir, path, AccessWrite, KindPath, false)
	}
	resolveGoPackageOperands(ct, workdir, parsed.Positionals, AccessRead)
	if !parsed.OptionSet["-o"] {
		ct.Unknown = append(ct.Unknown, UnknownTarget{Command: ct.Command.Name, Access: AccessWrite, Reason: "go build may write a default output binary"})
	}
}

func resolveGoReadLike(ct *CommandTargets, workdir string, args []string) {
	parsed := parseArgs(args, map[string]optionArity{
		"-args": optionConsumesNext, "-coverprofile": optionConsumesNext,
		"-modfile": optionConsumesNext, "-overlay": optionConsumesNext,
		"-run": optionConsumesNext, "-bench": optionConsumesNext,
		"-count": optionConsumesNext, "-cpu": optionConsumesNext,
		"-exec": optionConsumesNext, "-json": optionConsumesNothing,
		"-list": optionConsumesNext, "-mod": optionConsumesNext,
		"-shuffle": optionConsumesNext, "-tags": optionConsumesNext,
		"-timeout": optionConsumesNext, "-vet": optionConsumesNext,
	})
	for _, path := range parsed.OptionValues["-modfile"] {
		addTarget(ct, workdir, path, AccessRead, KindFile, false)
	}
	for _, path := range parsed.OptionValues["-overlay"] {
		addTarget(ct, workdir, path, AccessRead, KindFile, false)
	}
	resolveGoPackageOperands(ct, workdir, parsed.Positionals, AccessRead)
}

func resolveGoMod(ct *CommandTargets, workdir string, args []string) {
	if len(args) == 0 {
		return
	}
	subcmd := strings.ToLower(args[0])
	switch subcmd {
	case "tidy", "vendor":
		ct.Unknown = append(ct.Unknown, UnknownTarget{Command: ct.Command.Name, Access: AccessWrite, Reason: "go mod command mutates module files or vendor contents"})
	case "download", "graph", "why", "verify":
		addTarget(ct, workdir, "go.mod", AccessRead, KindFile, false)
		addTarget(ct, workdir, "go.sum", AccessRead, KindFile, false)
	}
}

func resolveGoPackageOperands(ct *CommandTargets, workdir string, operands []string, access TargetAccess) {
	if len(operands) == 0 {
		addTarget(ct, workdir, ".", access, KindDirectory, false)
		return
	}
	for _, operand := range operands {
		if strings.HasPrefix(operand, "-") || operand == "" {
			continue
		}
		if operand == "." || operand == ".." || strings.HasPrefix(operand, "./") || strings.HasPrefix(operand, "../") || strings.HasSuffix(operand, "...") || strings.Contains(operand, "/") {
			addTarget(ct, workdir, operand, access, KindPath, false)
		}
	}
}

func resolveNode(ct *CommandTargets, workdir string) {
	parsed := parseArgs(ct.Command.Args[1:], map[string]optionArity{
		"-e": optionConsumesNext, "--eval": optionConsumesNext,
		"-p": optionConsumesNext, "--print": optionConsumesNext,
		"-r": optionConsumesNext, "--require": optionConsumesNext,
		"--import": optionConsumesNext, "--loader": optionConsumesNext,
		"--test": optionConsumesNothing, "--watch": optionConsumesNothing,
	})
	for _, path := range parsed.OptionValues["-r"] {
		addTarget(ct, workdir, path, AccessRead, KindFile, false)
	}
	for _, path := range parsed.OptionValues["--require"] {
		addTarget(ct, workdir, path, AccessRead, KindFile, false)
	}
	for _, path := range parsed.OptionValues["--import"] {
		addTarget(ct, workdir, path, AccessRead, KindFile, false)
	}
	for _, path := range parsed.OptionValues["--loader"] {
		addTarget(ct, workdir, path, AccessRead, KindFile, false)
	}
	if len(parsed.Positionals) == 0 {
		return
	}
	for i, path := range parsed.Positionals {
		if i == 0 && isLikelyScriptPath(path) {
			addTarget(ct, workdir, path, AccessRead, KindFile, false)
			continue
		}
		if parsed.OptionSet["--test"] && looksLikeStaticPathOperand(path) {
			addTarget(ct, workdir, path, AccessRead, KindPath, false)
		}
	}
}

func resolveNPM(ct *CommandTargets, workdir string) {
	resolvePackageManager(ct, packageManagerSpec{
		defaultManifest: "package.json",
		lockfiles:       []string{"package-lock.json", "npm-shrinkwrap.json"},
		workdirFlags: map[string]optionArity{
			"--prefix": optionConsumesNext,
			"-C":       optionConsumesNext,
		},
		npxLike: strings.EqualFold(ct.Command.Name, "npx"),
	}, workdir)
}

func resolvePNPM(ct *CommandTargets, workdir string) {
	resolvePackageManager(ct, packageManagerSpec{
		defaultManifest: "package.json",
		lockfiles:       []string{"pnpm-lock.yaml"},
		workdirFlags: map[string]optionArity{
			"--dir": optionConsumesNext,
			"-C":    optionConsumesNext,
		},
	}, workdir)
}

func resolveYarn(ct *CommandTargets, workdir string) {
	resolvePackageManager(ct, packageManagerSpec{
		defaultManifest: "package.json",
		lockfiles:       []string{"yarn.lock"},
		workdirFlags: map[string]optionArity{
			"--cwd": optionConsumesNext,
		},
	}, workdir)
}

func resolveBun(ct *CommandTargets, workdir string) {
	if strings.EqualFold(ct.Command.Name, "bunx") {
		ct.Unknown = append(ct.Unknown, UnknownTarget{Command: ct.Command.Name, Access: AccessRead, Reason: "bunx resolves and executes packages dynamically"})
		return
	}

	toolWorkdir, args := extractLeadingWorkdirFlags(ct.Command.Args[1:], workdir, map[string]optionArity{
		"--cwd": optionConsumesNext,
		"-C":    optionConsumesNext,
	})
	subcmd, rest := splitSubcommand(args)
	switch subcmd {
	case "run":
		resolvePackageManagerRunLike(ct, toolWorkdir, rest, "package.json", []string{"bun.lockb", "bun.lock"}, true)
	case "build":
		resolveBunBuild(ct, toolWorkdir, rest)
	case "test":
		resolveBunTest(ct, toolWorkdir, rest)
	case "install", "add", "remove", "update", "upgrade", "link", "unlink", "pm":
		addManifestTargets(ct, toolWorkdir, "package.json", []string{"bun.lockb", "bun.lock"}, AccessRead)
		ct.Unknown = append(ct.Unknown, UnknownTarget{Command: ct.Command.Name, Access: AccessWrite, Reason: "bun dependency management mutates manifests, lockfiles, or install state"})
	case "x":
		ct.Unknown = append(ct.Unknown, UnknownTarget{Command: ct.Command.Name, Access: AccessRead, Reason: "bun x resolves and executes packages dynamically"})
	case "create", "init":
		ct.Unknown = append(ct.Unknown, UnknownTarget{Command: ct.Command.Name, Access: AccessWrite, Reason: "bun project scaffolding writes files dynamically"})
	default:
		// Support `bun script.ts` and similar direct execution.
		if subcmd == "" && len(args) > 0 && isLikelyScriptPath(args[0]) {
			addTarget(ct, toolWorkdir, args[0], AccessRead, KindFile, false)
		}
	}
}

func resolveBunBuild(ct *CommandTargets, workdir string, args []string) {
	parsed := parseArgs(args, map[string]optionArity{
		"--outfile":   optionConsumesNext,
		"--outdir":    optionConsumesNext,
		"--target":    optionConsumesNext,
		"--format":    optionConsumesNext,
		"--splitting": optionConsumesNothing,
		"--minify":    optionConsumesNothing,
	})
	for _, path := range parsed.Positionals {
		if looksLikeStaticPathOperand(path) {
			addTarget(ct, workdir, path, AccessRead, KindPath, false)
		}
	}
	for _, path := range parsed.OptionValues["--outfile"] {
		addTarget(ct, workdir, path, AccessWrite, KindFile, false)
	}
	for _, path := range parsed.OptionValues["--outdir"] {
		addTarget(ct, workdir, path, AccessWrite, KindDirectory, false)
	}
	if !parsed.OptionSet["--outfile"] && !parsed.OptionSet["--outdir"] {
		ct.Unknown = append(ct.Unknown, UnknownTarget{Command: ct.Command.Name, Access: AccessWrite, Reason: "bun build writes output files based on its bundling configuration"})
	}
}

func resolveBunTest(ct *CommandTargets, workdir string, args []string) {
	addManifestTargets(ct, workdir, "package.json", []string{"bun.lockb", "bun.lock"}, AccessRead)
	parsed := parseArgs(args, map[string]optionArity{
		"--filter":  optionConsumesNext,
		"--timeout": optionConsumesNext,
		"--preload": optionConsumesNext,
	})
	for _, path := range parsed.OptionValues["--preload"] {
		addTarget(ct, workdir, path, AccessRead, KindFile, false)
	}
	for _, path := range parsed.Positionals {
		if looksLikeStaticPathOperand(path) {
			addTarget(ct, workdir, path, AccessRead, KindPath, false)
		}
	}
}

func resolveCargo(ct *CommandTargets, workdir string) {
	toolWorkdir, args := extractLeadingWorkdirFlags(ct.Command.Args[1:], workdir, map[string]optionArity{
		"--manifest-path": optionConsumesNext,
		"--target-dir":    optionConsumesNext,
	})
	subcmd, rest := splitSubcommand(args)
	manifestPath := firstOptionValue(args, "--manifest-path")
	targetDir := firstOptionValue(args, "--target-dir")
	if manifestPath == "" {
		addTarget(ct, toolWorkdir, "Cargo.toml", AccessRead, KindFile, false)
		addTarget(ct, toolWorkdir, "Cargo.lock", AccessRead, KindFile, false)
	} else {
		addTarget(ct, toolWorkdir, manifestPath, AccessRead, KindFile, false)
		lockfile := filepath.Join(filepath.Dir(manifestPath), "Cargo.lock")
		addTarget(ct, toolWorkdir, lockfile, AccessRead, KindFile, false)
	}
	if targetDir != "" {
		addTarget(ct, toolWorkdir, targetDir, AccessWrite, KindDirectory, false)
	}

	switch subcmd {
	case "build", "check", "run", "test", "bench", "clippy", "doc", "rustc":
		if targetDir == "" {
			addTarget(ct, toolWorkdir, "target", AccessWrite, KindDirectory, false)
		}
	case "fmt", "fix":
		ct.Unknown = append(ct.Unknown, UnknownTarget{Command: ct.Command.Name, Access: AccessWrite, Reason: "cargo formatting or fix commands can rewrite source files"})
	case "clean":
		if targetDir == "" {
			addTarget(ct, toolWorkdir, "target", AccessDelete, KindDirectory, false)
		} else {
			addTarget(ct, toolWorkdir, targetDir, AccessDelete, KindDirectory, false)
		}
	case "metadata", "tree":
		addTarget(ct, toolWorkdir, ".", AccessList, KindDirectory, false)
	case "add", "remove", "update", "generate-lockfile", "vendor", "fetch", "install":
		ct.Unknown = append(ct.Unknown, UnknownTarget{Command: ct.Command.Name, Access: AccessWrite, Reason: "cargo dependency or installation commands mutate manifests, lockfiles, caches, or vendor state"})
	}

	parsed := parseArgs(rest, map[string]optionArity{
		"--manifest-path": optionConsumesNext,
		"--target-dir":    optionConsumesNext,
	})
	for _, path := range parsed.Positionals {
		if looksLikeStaticPathOperand(path) {
			addTarget(ct, toolWorkdir, path, AccessRead, KindPath, false)
		}
	}
}

func resolveRustc(ct *CommandTargets, workdir string) {
	parsed := parseArgs(ct.Command.Args[1:], map[string]optionArity{
		"-o":           optionConsumesNext,
		"--out-dir":    optionConsumesNext,
		"--emit":       optionConsumesNext,
		"--extern":     optionConsumesNext,
		"--cfg":        optionConsumesNext,
		"--crate-name": optionConsumesNext,
	})
	for _, path := range parsed.OptionValues["-o"] {
		addTarget(ct, workdir, path, AccessWrite, KindFile, false)
	}
	for _, path := range parsed.OptionValues["--out-dir"] {
		addTarget(ct, workdir, path, AccessWrite, KindDirectory, false)
	}
	for _, emit := range parsed.OptionValues["--emit"] {
		for _, path := range rustcEmitTargets(emit) {
			addTarget(ct, workdir, path, AccessWrite, KindFile, false)
		}
	}
	for _, raw := range parsed.Positionals {
		if isLikelyRustSource(raw) {
			addTarget(ct, workdir, raw, AccessRead, KindFile, false)
		}
	}
}

func resolveMake(ct *CommandTargets, workdir string) {
	toolWorkdir, args := extractLeadingWorkdirFlags(ct.Command.Args[1:], workdir, map[string]optionArity{
		"-C":     optionConsumesNext,
		"-f":     optionConsumesNext,
		"--file": optionConsumesNext,
	})
	parsed := parseArgs(args, map[string]optionArity{
		"-f":          optionConsumesNext,
		"--file":      optionConsumesNext,
		"-C":          optionConsumesNext,
		"--jobs":      optionConsumesNext,
		"-j":          optionConsumesNext,
		"--directory": optionConsumesNext,
	})
	if len(parsed.OptionValues["-f"]) == 0 && len(parsed.OptionValues["--file"]) == 0 {
		addTarget(ct, toolWorkdir, "Makefile", AccessRead, KindFile, false)
		addTarget(ct, toolWorkdir, "makefile", AccessRead, KindFile, false)
		addTarget(ct, toolWorkdir, "GNUmakefile", AccessRead, KindFile, false)
	}
	for _, path := range parsed.OptionValues["-f"] {
		addTarget(ct, toolWorkdir, path, AccessRead, KindFile, false)
	}
	for _, path := range parsed.OptionValues["--file"] {
		addTarget(ct, toolWorkdir, path, AccessRead, KindFile, false)
	}
	classifyTaskRunnerGoals(ct, toolWorkdir, parsed.Positionals)
}

func resolveJust(ct *CommandTargets, workdir string) {
	toolWorkdir, args := extractLeadingWorkdirFlags(ct.Command.Args[1:], workdir, map[string]optionArity{
		"--justfile":          optionConsumesNext,
		"-f":                  optionConsumesNext,
		"--working-directory": optionConsumesNext,
		"-d":                  optionConsumesNext,
	})
	parsed := parseArgs(args, map[string]optionArity{
		"--justfile":          optionConsumesNext,
		"-f":                  optionConsumesNext,
		"--working-directory": optionConsumesNext,
		"-d":                  optionConsumesNext,
	})
	if len(parsed.OptionValues["--justfile"]) == 0 && len(parsed.OptionValues["-f"]) == 0 {
		addTarget(ct, toolWorkdir, "justfile", AccessRead, KindFile, false)
		addTarget(ct, toolWorkdir, ".justfile", AccessRead, KindFile, false)
	}
	for _, path := range parsed.OptionValues["--justfile"] {
		addTarget(ct, toolWorkdir, path, AccessRead, KindFile, false)
	}
	for _, path := range parsed.OptionValues["-f"] {
		addTarget(ct, toolWorkdir, path, AccessRead, KindFile, false)
	}
	classifyTaskRunnerGoals(ct, toolWorkdir, parsed.Positionals)
}

type packageManagerSpec struct {
	defaultManifest string
	lockfiles       []string
	workdirFlags    map[string]optionArity
	npxLike         bool
}

func resolvePackageManager(ct *CommandTargets, spec packageManagerSpec, workdir string) {
	toolWorkdir, args := extractLeadingWorkdirFlags(ct.Command.Args[1:], workdir, spec.workdirFlags)
	subcmd, rest := splitSubcommand(args)
	if spec.npxLike {
		subcmd = "exec"
		rest = args
	}

	switch subcmd {
	case "run", "run-script":
		resolvePackageManagerRunLike(ct, toolWorkdir, rest, spec.defaultManifest, spec.lockfiles, false)
	case "build", "test", "start", "dev", "serve", "preview", "lint", "typecheck", "check", "format", "fmt":
		resolvePackageManagerScriptByName(ct, toolWorkdir, subcmd, spec.defaultManifest, spec.lockfiles)
	case "install", "ci", "add", "remove", "rm", "update", "upgrade", "link", "unlink", "dedupe", "prune", "rebuild", "publish", "pack", "version", "init":
		addManifestTargets(ct, toolWorkdir, spec.defaultManifest, spec.lockfiles, AccessRead)
		ct.Unknown = append(ct.Unknown, UnknownTarget{Command: ct.Command.Name, Access: AccessWrite, Reason: "package manager command mutates manifests, lockfiles, dependencies, or build outputs"})
	case "list", "ls", "outdated", "why", "query":
		addManifestTargets(ct, toolWorkdir, spec.defaultManifest, spec.lockfiles, AccessRead)
		addTarget(ct, toolWorkdir, ".", AccessList, KindDirectory, false)
	case "exec", "dlx", "create":
		addManifestTargets(ct, toolWorkdir, spec.defaultManifest, spec.lockfiles, AccessRead)
		ct.Unknown = append(ct.Unknown, UnknownTarget{Command: ct.Command.Name, Access: AccessRead, Reason: "package manager command resolves or executes packages dynamically"})
	default:
		if subcmd != "" {
			resolvePackageManagerScriptByName(ct, toolWorkdir, subcmd, spec.defaultManifest, spec.lockfiles)
		}
	}
}

func resolvePackageManagerRunLike(ct *CommandTargets, workdir string, args []string, manifest string, lockfiles []string, bunRun bool) {
	addManifestTargets(ct, workdir, manifest, lockfiles, AccessRead)
	if len(args) == 0 {
		return
	}
	script := firstNonFlagArg(args)
	if script == "" && bunRun {
		if len(args) > 0 && isLikelyScriptPath(args[0]) {
			addTarget(ct, workdir, args[0], AccessRead, KindFile, false)
		}
		return
	}
	if script != "" {
		resolvePackageManagerScriptByName(ct, workdir, script, manifest, lockfiles)
	}
}

func resolvePackageManagerScriptByName(ct *CommandTargets, workdir string, script string, manifest string, lockfiles []string) {
	addManifestTargets(ct, workdir, manifest, lockfiles, AccessRead)
	switch classifyScriptIntent(script) {
	case AccessWrite:
		ct.Unknown = append(ct.Unknown, UnknownTarget{Command: ct.Command.Name, Access: AccessWrite, Reason: "script name indicates it likely writes build artifacts or mutates project files"})
	case AccessRead:
		ct.Unknown = append(ct.Unknown, UnknownTarget{Command: ct.Command.Name, Access: AccessRead, Reason: "script execution reads project files and configuration"})
	case AccessList:
		addTarget(ct, workdir, ".", AccessList, KindDirectory, false)
	}
}

func addManifestTargets(ct *CommandTargets, workdir string, manifest string, lockfiles []string, access TargetAccess) {
	if manifest != "" {
		addTarget(ct, workdir, manifest, access, KindFile, false)
	}
	for _, lockfile := range lockfiles {
		addTarget(ct, workdir, lockfile, access, KindFile, false)
	}
}

func classifyTaskRunnerGoals(ct *CommandTargets, workdir string, goals []string) {
	if len(goals) == 0 {
		ct.Unknown = append(ct.Unknown, UnknownTarget{Command: ct.Command.Name, Access: AccessRead, Reason: "task runners evaluate project recipes and inputs dynamically"})
		return
	}
	for _, goal := range goals {
		switch classifyScriptIntent(goal) {
		case AccessWrite:
			ct.Unknown = append(ct.Unknown, UnknownTarget{Command: ct.Command.Name, Access: AccessWrite, Reason: "task recipe name indicates it likely writes or deletes project outputs"})
		case AccessRead:
			ct.Unknown = append(ct.Unknown, UnknownTarget{Command: ct.Command.Name, Access: AccessRead, Reason: "task recipe name indicates it reads project inputs"})
		case AccessList:
			addTarget(ct, workdir, ".", AccessList, KindDirectory, false)
		default:
			ct.Unknown = append(ct.Unknown, UnknownTarget{Command: ct.Command.Name, Access: AccessRead, Reason: "task runner recipes are resolved dynamically from project configuration"})
		}
	}
}

func classifyScriptIntent(name string) TargetAccess {
	normalized := strings.ToLower(strings.TrimSpace(name))
	switch {
	case normalized == "", normalized == "run":
		return ""
	case strings.Contains(normalized, "build"),
		strings.Contains(normalized, "bundle"),
		strings.Contains(normalized, "compile"),
		strings.Contains(normalized, "generate"),
		strings.Contains(normalized, "dist"),
		strings.Contains(normalized, "release"),
		strings.Contains(normalized, "deploy"),
		strings.Contains(normalized, "pack"),
		strings.Contains(normalized, "format"),
		strings.Contains(normalized, "fmt"),
		strings.Contains(normalized, "fix"),
		strings.Contains(normalized, "install"),
		strings.Contains(normalized, "clean"),
		strings.Contains(normalized, "vendor"):
		return AccessWrite
	case normalized == "list" || normalized == "ls" || strings.Contains(normalized, "query") || strings.Contains(normalized, "outdated"):
		return AccessList
	case strings.Contains(normalized, "test"),
		strings.Contains(normalized, "lint"),
		strings.Contains(normalized, "check"),
		strings.Contains(normalized, "typecheck"),
		strings.Contains(normalized, "dev"),
		strings.Contains(normalized, "start"),
		strings.Contains(normalized, "serve"),
		strings.Contains(normalized, "preview"),
		strings.Contains(normalized, "bench"),
		strings.Contains(normalized, "doc"),
		strings.Contains(normalized, "status"):
		return AccessRead
	default:
		return ""
	}
}

func extractLeadingWorkdirFlags(args []string, workdir string, specs map[string]optionArity) (string, []string) {
	currentWorkdir := workdir
	remaining := make([]string, 0, len(args))
	for i := 0; i < len(args); i++ {
		arg := args[i]
		name, value, ok := matchOptionWithValue(arg, specs)
		if ok {
			if value == "" && specs[name] == optionConsumesNext && i+1 < len(args) {
				i++
				value = args[i]
			}
			if isWorkdirFlag(name) && value != "" {
				currentWorkdir = normalizeTargetPath(value, currentWorkdir)
			}
			remaining = append(remaining, arg)
			if value != "" && specs[name] == optionConsumesNext && arg == name {
				remaining = append(remaining, value)
			}
			continue
		}
		remaining = append(remaining, arg)
	}
	return currentWorkdir, remaining
}

func isWorkdirFlag(name string) bool {
	switch name {
	case "-C", "--cwd", "--prefix", "--dir", "--directory", "--working-directory":
		return true
	default:
		return false
	}
}

func splitSubcommand(args []string) (string, []string) {
	for i := 0; i < len(args); i++ {
		arg := args[i]
		if arg == "--" {
			break
		}
		if strings.HasPrefix(arg, "-") {
			if optionLikelyConsumesValue(arg) && i+1 < len(args) && !strings.HasPrefix(args[i+1], "-") {
				i++
			}
			continue
		}
		return strings.ToLower(arg), args[i+1:]
	}
	return "", nil
}

func optionLikelyConsumesValue(arg string) bool {
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

func firstNonFlagArg(args []string) string {
	for i := 0; i < len(args); i++ {
		if args[i] == "--" {
			if i+1 < len(args) {
				return args[i+1]
			}
			return ""
		}
		if strings.HasPrefix(args[i], "-") {
			if optionLikelyConsumesValue(args[i]) && i+1 < len(args) && !strings.HasPrefix(args[i+1], "-") {
				i++
			}
			continue
		}
		return args[i]
	}
	return ""
}

func firstOptionValue(args []string, name string) string {
	for i := 0; i < len(args); i++ {
		arg := args[i]
		if arg == name && i+1 < len(args) {
			return args[i+1]
		}
		if strings.HasPrefix(arg, name+"=") {
			return strings.TrimPrefix(arg, name+"=")
		}
	}
	return ""
}

func rustcEmitTargets(value string) []string {
	var targets []string
	for _, part := range strings.Split(value, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		if idx := strings.Index(part, "="); idx >= 0 && idx < len(part)-1 {
			targets = append(targets, part[idx+1:])
		}
	}
	return targets
}

func isLikelyScriptPath(raw string) bool {
	if raw == "" {
		return false
	}
	ext := strings.ToLower(filepath.Ext(raw))
	switch ext {
	case ".js", ".cjs", ".mjs", ".ts", ".cts", ".mts", ".tsx":
		return true
	default:
		return looksLikeStaticPathOperand(raw)
	}
}

func isLikelyRustSource(raw string) bool {
	return strings.EqualFold(filepath.Ext(raw), ".rs")
}

func resolveSed(ct *CommandTargets, workdir string) {
	parsed := parseArgs(ct.Command.Args[1:], map[string]optionArity{
		"-e": optionConsumesNext, "-f": optionConsumesNext, "-i": optionConsumesNext,
		"-l": optionConsumesNext, "--expression": optionConsumesNext, "--file": optionConsumesNext,
		"--in-place": optionConsumesNext, "--line-length": optionConsumesNext,
	})
	for _, path := range parsed.OptionValues["-f"] {
		addTarget(ct, workdir, path, AccessRead, KindFile, false)
	}
	for _, path := range parsed.OptionValues["--file"] {
		addTarget(ct, workdir, path, AccessRead, KindFile, false)
	}

	files := parsed.Positionals
	if !parsed.OptionSet["-e"] && !parsed.OptionSet["--expression"] && !parsed.OptionSet["-f"] && !parsed.OptionSet["--file"] && len(files) > 0 {
		files = files[1:]
	}
	access := AccessRead
	if parsed.OptionSet["-i"] || parsed.OptionSet["--in-place"] {
		access = AccessWrite
	}
	for _, path := range files {
		addTarget(ct, workdir, path, access, KindFile, false)
	}
}

func resolvePerl(ct *CommandTargets, workdir string) {
	parsed := parseArgs(ct.Command.Args[1:], map[string]optionArity{
		"-0": optionConsumesNext, "-C": optionConsumesNext, "-F": optionConsumesNext,
		"-I": optionConsumesNext, "-M": optionConsumesNext, "-m": optionConsumesNext,
		"-e": optionConsumesNext, "-i": optionConsumesNext,
	})
	files := parsed.Positionals
	if !parsed.OptionSet["-e"] && len(files) > 0 {
		files = files[1:]
	}
	access := AccessRead
	for _, raw := range ct.Command.Args[1:] {
		if strings.HasPrefix(raw, "-") && strings.Contains(raw, "i") && strings.Contains(raw, "p") {
			access = AccessWrite
			break
		}
	}
	if parsed.OptionSet["-i"] {
		access = AccessWrite
	}
	for _, path := range files {
		addTarget(ct, workdir, path, access, KindFile, false)
	}
}

func resolveCopyLike(ct *CommandTargets, workdir string) {
	parsed := parseArgs(ct.Command.Args[1:], map[string]optionArity{
		"-S": optionConsumesNext, "-t": optionConsumesNext, "--target-directory": optionConsumesNext,
	})
	sources := parsed.Positionals
	if len(parsed.OptionValues["-t"]) > 0 {
		for _, src := range sources {
			addTarget(ct, workdir, src, AccessRead, KindPath, false)
		}
		for _, dest := range parsed.OptionValues["-t"] {
			addTarget(ct, workdir, dest, AccessWrite, KindDirectory, false)
		}
		for _, dest := range parsed.OptionValues["--target-directory"] {
			addTarget(ct, workdir, dest, AccessWrite, KindDirectory, false)
		}
		return
	}
	if len(sources) < 2 {
		ct.Unknown = append(ct.Unknown, UnknownTarget{Command: ct.Command.Name, Access: AccessWrite, Reason: "copy destination could not be determined"})
		return
	}
	for _, src := range sources[:len(sources)-1] {
		addTarget(ct, workdir, src, AccessRead, KindPath, false)
	}
	addTarget(ct, workdir, sources[len(sources)-1], AccessWrite, KindPath, false)
}

func resolveMoveLike(ct *CommandTargets, workdir string) {
	parsed := parseArgs(ct.Command.Args[1:], map[string]optionArity{
		"-S": optionConsumesNext, "-t": optionConsumesNext, "--target-directory": optionConsumesNext,
	})
	sources := parsed.Positionals
	if len(parsed.OptionValues["-t"]) > 0 || len(parsed.OptionValues["--target-directory"]) > 0 {
		for _, src := range sources {
			addTarget(ct, workdir, src, AccessDelete, KindPath, false)
		}
		for _, dest := range parsed.OptionValues["-t"] {
			addTarget(ct, workdir, dest, AccessWrite, KindDirectory, false)
		}
		for _, dest := range parsed.OptionValues["--target-directory"] {
			addTarget(ct, workdir, dest, AccessWrite, KindDirectory, false)
		}
		return
	}
	if len(sources) < 2 {
		ct.Unknown = append(ct.Unknown, UnknownTarget{Command: ct.Command.Name, Access: AccessWrite, Reason: "move destination could not be determined"})
		return
	}
	for _, src := range sources[:len(sources)-1] {
		addTarget(ct, workdir, src, AccessDelete, KindPath, false)
	}
	addTarget(ct, workdir, sources[len(sources)-1], AccessWrite, KindPath, false)
}

func resolveRemoveLike(ct *CommandTargets, workdir string) {
	parsed := parseArgs(ct.Command.Args[1:], map[string]optionArity{})
	for _, path := range parsed.Positionals {
		addTarget(ct, workdir, path, AccessDelete, KindPath, false)
	}
}

func resolvePatch(ct *CommandTargets, workdir string) {
	parsed := parseArgs(ct.Command.Args[1:], map[string]optionArity{
		"-d": optionConsumesNext, "-i": optionConsumesNext, "-o": optionConsumesNext,
		"-p": optionConsumesNext, "--directory": optionConsumesNext, "--input": optionConsumesNext,
		"--output": optionConsumesNext, "--strip": optionConsumesNext,
	})
	for _, path := range parsed.OptionValues["-i"] {
		addTarget(ct, workdir, path, AccessRead, KindFile, false)
	}
	for _, path := range parsed.OptionValues["--input"] {
		addTarget(ct, workdir, path, AccessRead, KindFile, false)
	}
	for _, path := range parsed.OptionValues["-o"] {
		addTarget(ct, workdir, path, AccessWrite, KindFile, false)
	}
	for _, path := range parsed.OptionValues["--output"] {
		addTarget(ct, workdir, path, AccessWrite, KindFile, false)
	}
	ct.Unknown = append(ct.Unknown, UnknownTarget{Command: ct.Command.Name, Access: AccessWrite, Reason: "patch contents determine the files being modified"})
}

func resolveTee(ct *CommandTargets, workdir string) {
	parsed := parseArgs(ct.Command.Args[1:], map[string]optionArity{})
	for _, path := range parsed.Positionals {
		addTarget(ct, workdir, path, AccessWrite, KindFile, false)
	}
}

func resolveDirectWriteCommand(ct *CommandTargets, workdir string) {
	parsed := parseArgs(ct.Command.Args[1:], map[string]optionArity{
		"-d": optionConsumesNext, "-g": optionConsumesNext, "-m": optionConsumesNext,
		"-o": optionConsumesNext, "-t": optionConsumesNext, "-T": optionConsumesNext,
	})
	for _, path := range parsed.Positionals {
		addTarget(ct, workdir, path, AccessWrite, KindPath, false)
	}
}

func parseArgs(args []string, specs map[string]optionArity) parsedArgs {
	result := parsedArgs{
		OptionValues: make(map[string][]string),
		OptionSet:    make(map[string]bool),
	}
	for i := 0; i < len(args); i++ {
		arg := args[i]
		if arg == "--" {
			result.Positionals = append(result.Positionals, args[i+1:]...)
			break
		}
		if name, value, ok := matchOptionWithValue(arg, specs); ok {
			result.OptionSet[name] = true
			if value != "" || specs[name] == optionConsumesNext {
				result.OptionValues[name] = append(result.OptionValues[name], value)
			}
			if value == "" && specs[name] == optionConsumesNext && i+1 < len(args) {
				i++
				result.OptionValues[name] = append(result.OptionValues[name], args[i])
			}
			continue
		}
		if strings.HasPrefix(arg, "-") && arg != "-" {
			result.OptionSet[arg] = true
			continue
		}
		result.Positionals = append(result.Positionals, arg)
	}
	return result
}

func matchOptionWithValue(arg string, specs map[string]optionArity) (string, string, bool) {
	for name, arity := range specs {
		if arity != optionConsumesNext {
			if arg == name {
				return name, "", true
			}
			continue
		}
		if arg == name {
			return name, "", true
		}
		if strings.HasPrefix(name, "--") && strings.HasPrefix(arg, name+"=") {
			return name, strings.TrimPrefix(arg, name+"="), true
		}
		if len(name) == 2 && strings.HasPrefix(name, "-") && !strings.HasPrefix(name, "--") && strings.HasPrefix(arg, name) && len(arg) > len(name) {
			return name, arg[len(name):], true
		}
	}
	return "", "", false
}

func addTarget(ct *CommandTargets, workdir string, raw string, access TargetAccess, kind TargetKind, fromRedirect bool) {
	raw = sanitizeTargetRaw(raw)
	if raw == "" || raw == "-" || !isStaticTarget(raw) {
		return
	}
	path := normalizeTargetPath(raw, workdir)
	ct.Targets = append(ct.Targets, Target{
		Command:      strings.ToLower(ct.Command.Name),
		Raw:          raw,
		Path:         path,
		Access:       access,
		Kind:         inferTargetKind(raw, path, kind),
		FromRedirect: fromRedirect,
	})
}

func nextCommandWorkdir(cmd *Command, workdir string) string {
	if cmd == nil || !strings.EqualFold(cmd.Name, "cd") {
		return workdir
	}
	parsed := parseArgs(cmd.Args[1:], map[string]optionArity{
		"-P": optionConsumesNothing,
		"-L": optionConsumesNothing,
	})
	if len(parsed.Positionals) == 0 {
		return workdir
	}
	target := parsed.Positionals[0]
	if !isStaticTarget(target) {
		return workdir
	}
	return normalizeTargetPath(target, workdir)
}

func sanitizeTargetRaw(raw string) string {
	trimmed := strings.TrimSpace(raw)
	trimmed = strings.Trim(trimmed, `"'`)
	return trimmed
}

func isStaticTarget(raw string) bool {
	if raw == "" || raw == "-" {
		return false
	}
	if strings.ContainsAny(raw, "*?[]{}") {
		return false
	}
	if strings.Contains(raw, "$(") || strings.Contains(raw, "`") || strings.Contains(raw, "${") {
		return false
	}
	if strings.Contains(raw, "://") {
		return false
	}
	return true
}

func normalizeTargetPath(raw string, workdir string) string {
	if raw == "" {
		return ""
	}
	if filepath.IsAbs(raw) {
		return filepath.Clean(raw)
	}
	if workdir == "" {
		return filepath.Clean(raw)
	}
	return filepath.Clean(filepath.Join(workdir, raw))
}

func inferTargetKind(raw string, path string, hint TargetKind) TargetKind {
	if hint == KindFile || hint == KindDirectory {
		return hint
	}
	if strings.HasSuffix(raw, "/") || raw == "." || raw == ".." {
		return KindDirectory
	}
	if path != "" {
		if info, err := os.Stat(path); err == nil {
			if info.IsDir() {
				return KindDirectory
			}
			return KindFile
		}
	}
	return KindPath
}

func splitGitInvocation(args []string) (string, []string) {
	for i := 0; i < len(args); i++ {
		arg := args[i]
		switch {
		case arg == "-C" || arg == "-c" || arg == "--git-dir" || arg == "--work-tree" || arg == "--namespace":
			i++
		case strings.HasPrefix(arg, "-C") && len(arg) > 2:
		case strings.HasPrefix(arg, "-c") && len(arg) > 2:
		case strings.HasPrefix(arg, "--git-dir="), strings.HasPrefix(arg, "--work-tree="), strings.HasPrefix(arg, "--namespace="):
		case strings.HasPrefix(arg, "-"):
		default:
			return strings.ToLower(arg), args[i+1:]
		}
	}
	return "", nil
}

func gitPathspecTargets(args []string) []string {
	if idx := indexOfArg(args, "--"); idx >= 0 {
		return cleanGitTargets(args[idx+1:])
	}
	var targets []string
	for _, arg := range args {
		if looksLikeStaticPathOperand(arg) {
			targets = append(targets, arg)
		}
	}
	return cleanGitTargets(targets)
}

func gitShowTargets(args []string) []string {
	var targets []string
	for _, arg := range args {
		if idx := strings.Index(arg, ":"); idx > 0 && idx < len(arg)-1 {
			candidate := arg[idx+1:]
			if looksLikeStaticPathOperand(candidate) {
				targets = append(targets, candidate)
			}
			continue
		}
		if looksLikeStaticPathOperand(arg) {
			targets = append(targets, arg)
		}
	}
	return cleanGitTargets(targets)
}

func cleanGitTargets(args []string) []string {
	var out []string
	for _, arg := range args {
		switch arg {
		case "", ".", "..", "-":
			out = append(out, arg)
		default:
			if looksLikeStaticPathOperand(arg) {
				out = append(out, arg)
			}
		}
	}
	return dedupeStrings(out)
}

func looksLikeStaticPathOperand(arg string) bool {
	if !isStaticTarget(arg) {
		return false
	}
	if strings.HasPrefix(arg, "./") || strings.HasPrefix(arg, "../") || strings.HasPrefix(arg, "/") || strings.HasPrefix(arg, "~/") {
		return true
	}
	if strings.Contains(arg, "/") {
		return true
	}
	if arg == "." || arg == ".." {
		return true
	}
	return filepath.Ext(arg) != ""
}

func isFileDescriptorRedirectTarget(operator string, raw string) bool {
	if operator != ">&" && operator != "<&" {
		return false
	}
	if raw == "-" {
		return true
	}
	for _, r := range raw {
		if r < '0' || r > '9' {
			return false
		}
	}
	return raw != ""
}

func indexOfArg(args []string, needle string) int {
	for i, arg := range args {
		if arg == needle {
			return i
		}
	}
	return -1
}

func dedupeTargets(in []Target) []Target {
	seen := make(map[string]struct{}, len(in))
	out := make([]Target, 0, len(in))
	for _, target := range in {
		key := strings.Join([]string{target.Command, string(target.Access), string(target.Kind), target.Raw, target.Path}, "\x00")
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, target)
	}
	return out
}

func dedupeUnknownTargets(in []UnknownTarget) []UnknownTarget {
	seen := make(map[string]struct{}, len(in))
	out := make([]UnknownTarget, 0, len(in))
	for _, unknown := range in {
		key := strings.Join([]string{unknown.Command, string(unknown.Access), unknown.Reason}, "\x00")
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, unknown)
	}
	return out
}

func dedupeStrings(in []string) []string {
	seen := make(map[string]struct{}, len(in))
	out := make([]string, 0, len(in))
	for _, s := range in {
		if _, ok := seen[s]; ok {
			continue
		}
		seen[s] = struct{}{}
		out = append(out, s)
	}
	return out
}
