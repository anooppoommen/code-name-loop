package shellparser

import (
	"bytes"
	"fmt"
	"strings"

	"mvdan.cc/sh/v3/syntax"
)

// TokenType classifies redirects in a parsed shell command.
type TokenType int

const (
	TokenWord TokenType = iota
	TokenPipe
	TokenAnd
	TokenOr
	TokenSemi
	TokenRedirectIn
	TokenRedirectOut
	TokenRedirectAppend
	TokenRedirectStderr
	TokenRedirectOutAndStderr
	TokenEOF
	TokenError
)

type ArgumentKind string

const (
	ArgumentCommandName      ArgumentKind = "command_name"
	ArgumentOption           ArgumentKind = "option"
	ArgumentOptionValue      ArgumentKind = "option_value"
	ArgumentOptionTerminator ArgumentKind = "option_terminator"
	ArgumentPositional       ArgumentKind = "positional"
)

type Option struct {
	Raw      string
	Name     string
	Value    string
	HasValue bool
}

type Argument struct {
	Raw       string
	Kind      ArgumentKind
	Option    string
	ValueFrom string
}

type Redirect struct {
	Type           TokenType
	Operator       string
	Target         string
	FileDescriptor string
	Heredoc        bool
	HeredocBody    string
}

type Substitution struct {
	Raw        string
	Backquoted bool
	Commands   []*Command
}

// Command represents a single executable shell command with classified args.
type Command struct {
	Raw           string
	Env           []string
	Name          string
	Args          []string
	Arguments     []Argument
	Options       []Option
	Positionals   []string
	Redirects     []Redirect
	ChainOperator string
	Background    bool
	Negated       bool
	Substitutions []Substitution
}

// Analysis is a normalized view of a shell command line.
type Analysis struct {
	Raw                string
	Commands           []*Command
	HasBooleanChains   bool
	HasPipelines       bool
	HasSequentialLists bool
	HasBackground      bool
	HasSubshells       bool
	HasCommandSubst    bool
	HasProcessSubst    bool
	HasParamExpansions bool
	HasExtendedGlobs   bool
	HasHeredocs        bool
}

// Parse parses a shell command line into normalized commands.
func Parse(input string) ([]*Command, error) {
	analysis, err := Analyze(input)
	if err != nil {
		return nil, err
	}
	return analysis.Commands, nil
}

// Analyze parses a shell command line into a structured form suitable for
// policy checks.
func Analyze(input string) (*Analysis, error) {
	if strings.TrimSpace(input) == "" {
		return &Analysis{Raw: input}, nil
	}

	parser := syntax.NewParser(syntax.Variant(syntax.LangBash))
	file, err := parser.Parse(strings.NewReader(input), "")
	if err != nil {
		return nil, fmt.Errorf("parse shell command: %w", err)
	}

	collector := &commandCollector{
		analysis: &Analysis{Raw: input},
		printer:  syntax.NewPrinter(syntax.SingleLine(true)),
	}
	collector.collectStmtList(file.Stmts, "")
	return collector.analysis, nil
}

type commandCollector struct {
	analysis *Analysis
	printer  *syntax.Printer
}

func (c *commandCollector) collectStmtList(stmts []*syntax.Stmt, firstChain string) {
	nextChain := firstChain
	for i, stmt := range stmts {
		if i > 0 && nextChain == ";" {
			c.analysis.HasSequentialLists = true
		}
		c.collectStmt(stmt, nextChain)
		nextChain = ";"
	}
}

func (c *commandCollector) collectStmt(stmt *syntax.Stmt, chain string) {
	if stmt == nil || stmt.Cmd == nil {
		return
	}

	switch x := stmt.Cmd.(type) {
	case *syntax.BinaryCmd:
		op := x.Op.String()
		c.markOperator(op)
		c.collectStmt(x.X, chain)
		c.collectStmt(x.Y, op)
	case *syntax.Subshell:
		c.analysis.HasSubshells = true
		c.collectStmtList(x.Stmts, chain)
	case *syntax.Block:
		c.collectStmtList(x.Stmts, chain)
	case *syntax.CallExpr:
		cmd := c.buildCommand(stmt, x, chain)
		c.analysis.Commands = append(c.analysis.Commands, cmd)
	default:
		c.walkComplexCommand(x)
	}
}

func (c *commandCollector) walkComplexCommand(cmd syntax.Command) {
	if cmd == nil {
		return
	}
	syntax.Walk(cmd, func(node syntax.Node) bool {
		switch x := node.(type) {
		case *syntax.CmdSubst:
			c.analysis.HasCommandSubst = true
			c.collectStmtList(x.Stmts, "")
			return false
		case *syntax.ProcSubst:
			c.analysis.HasProcessSubst = true
			c.collectStmtList(x.Stmts, "")
			return false
		case *syntax.ParamExp:
			c.analysis.HasParamExpansions = true
		case *syntax.ExtGlob:
			c.analysis.HasExtendedGlobs = true
		case *syntax.Subshell:
			c.analysis.HasSubshells = true
		case *syntax.CallExpr:
			// CallExpr instances nested inside complex commands are handled by the
			// parent traversal and should not be added out of context here.
			return false
		}
		return true
	})
}

func (c *commandCollector) buildCommand(stmt *syntax.Stmt, call *syntax.CallExpr, chain string) *Command {
	cmd := &Command{
		Raw:           c.renderNode(stmt),
		ChainOperator: chain,
		Background:    stmt.Background,
		Negated:       stmt.Negated,
	}
	if stmt.Background {
		c.analysis.HasBackground = true
	}

	for _, assign := range call.Assigns {
		cmd.Env = append(cmd.Env, c.renderAssign(assign))
		if assign.Value != nil {
			_, subs := c.wordText(assign.Value)
			cmd.Substitutions = append(cmd.Substitutions, subs...)
		}
	}

	for i, word := range call.Args {
		value, subs := c.wordText(word)
		cmd.Args = append(cmd.Args, value)
		cmd.Substitutions = append(cmd.Substitutions, subs...)
		if i == 0 {
			cmd.Name = value
		}
	}

	for _, redir := range stmt.Redirs {
		target, subs := c.wordText(redir.Word)
		cmd.Substitutions = append(cmd.Substitutions, subs...)

		redirect := Redirect{
			Type:           mapRedirectType(redir),
			Operator:       redir.Op.String(),
			Target:         target,
			FileDescriptor: literalValue(redir.N),
		}
		if redir.Hdoc != nil {
			c.analysis.HasHeredocs = true
			redirect.Heredoc = true
			redirect.HeredocBody, _ = c.wordText(redir.Hdoc)
		}
		cmd.Redirects = append(cmd.Redirects, redirect)
	}

	cmd.Arguments, cmd.Options, cmd.Positionals = classifyArgs(cmd.Args)
	return cmd
}

func (c *commandCollector) markOperator(op string) {
	switch op {
	case "|", "|&":
		c.analysis.HasPipelines = true
	case "&&", "||":
		c.analysis.HasBooleanChains = true
	case ";":
		c.analysis.HasSequentialLists = true
	}
}

func (c *commandCollector) wordText(word *syntax.Word) (string, []Substitution) {
	if word == nil {
		return "", nil
	}
	return c.wordPartsText(word.Parts)
}

func (c *commandCollector) wordPartsText(parts []syntax.WordPart) (string, []Substitution) {
	var text strings.Builder
	var substitutions []Substitution
	for _, part := range parts {
		partText, partSubs := c.wordPartText(part)
		text.WriteString(partText)
		substitutions = append(substitutions, partSubs...)
	}
	return text.String(), substitutions
}

func (c *commandCollector) wordPartText(part syntax.WordPart) (string, []Substitution) {
	switch x := part.(type) {
	case *syntax.Lit:
		return x.Value, nil
	case *syntax.SglQuoted:
		return x.Value, nil
	case *syntax.DblQuoted:
		return c.wordPartsText(x.Parts)
	case *syntax.ParamExp:
		c.analysis.HasParamExpansions = true
		return c.renderNode(x), nil
	case *syntax.ExtGlob:
		c.analysis.HasExtendedGlobs = true
		return c.renderNode(x), nil
	case *syntax.CmdSubst:
		c.analysis.HasCommandSubst = true
		sub := Substitution{
			Raw:        c.renderNode(x),
			Backquoted: x.Backquotes,
		}
		before := len(c.analysis.Commands)
		c.collectStmtList(x.Stmts, "")
		sub.Commands = append(sub.Commands, c.analysis.Commands[before:]...)
		return sub.Raw, []Substitution{sub}
	case *syntax.ProcSubst:
		c.analysis.HasProcessSubst = true
		sub := Substitution{Raw: c.renderNode(x)}
		before := len(c.analysis.Commands)
		c.collectStmtList(x.Stmts, "")
		sub.Commands = append(sub.Commands, c.analysis.Commands[before:]...)
		return sub.Raw, []Substitution{sub}
	default:
		return c.renderNode(part), nil
	}
}

func (c *commandCollector) renderAssign(assign *syntax.Assign) string {
	if assign == nil {
		return ""
	}
	return c.renderNode(assign)
}

func (c *commandCollector) renderNode(node syntax.Node) string {
	if node == nil {
		return ""
	}
	var buf bytes.Buffer
	if err := c.printer.Print(&buf, node); err != nil {
		return ""
	}
	return strings.TrimSpace(buf.String())
}

func literalValue(lit *syntax.Lit) string {
	if lit == nil {
		return ""
	}
	return lit.Value
}

func classifyArgs(args []string) ([]Argument, []Option, []string) {
	if len(args) == 0 {
		return nil, nil, nil
	}

	var (
		arguments      []Argument
		options        []Option
		positionals    []string
		positionalOnly bool
	)

	for idx, arg := range args {
		switch {
		case idx == 0:
			arguments = append(arguments, Argument{Raw: arg, Kind: ArgumentCommandName})
		case !positionalOnly && arg == "--":
			arguments = append(arguments, Argument{Raw: arg, Kind: ArgumentOptionTerminator})
			positionalOnly = true
		case !positionalOnly:
			opt, isOption := parseOption(arg)
			if opt != nil {
				options = append(options, *opt)
				arguments = append(arguments, Argument{
					Raw:    arg,
					Kind:   ArgumentOption,
					Option: opt.Name,
				})
				if isOption {
					continue
				}
			}
			positionals = append(positionals, arg)
			arguments = append(arguments, Argument{Raw: arg, Kind: ArgumentPositional})
		default:
			positionals = append(positionals, arg)
			arguments = append(arguments, Argument{Raw: arg, Kind: ArgumentPositional})
		}
	}

	return arguments, options, positionals
}

func parseOption(arg string) (*Option, bool) {
	if len(arg) < 2 || arg == "-" || !strings.HasPrefix(arg, "-") {
		return nil, false
	}

	if strings.HasPrefix(arg, "--") {
		opt := &Option{Raw: arg, Name: arg}
		if idx := strings.Index(arg, "="); idx >= 0 {
			opt.Name = arg[:idx]
			opt.Value = arg[idx+1:]
			opt.HasValue = true
			return opt, true
		}
		return opt, true
	}

	opt := &Option{Raw: arg, Name: arg}
	return opt, true
}

func mapRedirectType(redir *syntax.Redirect) TokenType {
	if redir == nil {
		return TokenError
	}

	fd := literalValue(redir.N)
	switch redir.Op.String() {
	case "<", "<<", "<<<", "<&":
		return TokenRedirectIn
	case ">>":
		if fd == "2" {
			return TokenRedirectAppend
		}
		return TokenRedirectAppend
	case "&>", "&>>":
		return TokenRedirectOutAndStderr
	case ">", ">|", ">&":
		if fd == "2" {
			return TokenRedirectStderr
		}
		return TokenRedirectOut
	default:
		return TokenRedirectOut
	}
}
