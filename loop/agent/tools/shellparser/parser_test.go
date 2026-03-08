package shellparser

import (
	"database/sql"
	"path/filepath"
	"strings"
	"testing"

	_ "github.com/mattn/go-sqlite3"
)

func TestParse(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  []struct {
			name        string
			args        []string
			chain       string
			options     []string
			positionals []string
			redirects   []Redirect
			substRaw    []string
		}
	}{
		{
			name:  "simple command",
			input: "ls -la",
			want: []struct {
				name        string
				args        []string
				chain       string
				options     []string
				positionals []string
				redirects   []Redirect
				substRaw    []string
			}{
				{
					name:    "ls",
					args:    []string{"ls", "-la"},
					options: []string{"-la"},
				},
			},
		},
		{
			name:  "command with quotes",
			input: `rg -i "lifecycle hooks" loop-desktop`,
			want: []struct {
				name        string
				args        []string
				chain       string
				options     []string
				positionals []string
				redirects   []Redirect
				substRaw    []string
			}{
				{
					name:        "rg",
					args:        []string{"rg", "-i", "lifecycle hooks", "loop-desktop"},
					options:     []string{"-i"},
					positionals: []string{"lifecycle hooks", "loop-desktop"},
				},
			},
		},
		{
			name:  "pipeline",
			input: `cat loop-desktop/src/utils/activityTimeline.ts | grep parseToolCommand -A 10`,
			want: []struct {
				name        string
				args        []string
				chain       string
				options     []string
				positionals []string
				redirects   []Redirect
				substRaw    []string
			}{
				{
					name:        "cat",
					args:        []string{"cat", "loop-desktop/src/utils/activityTimeline.ts"},
					positionals: []string{"loop-desktop/src/utils/activityTimeline.ts"},
				},
				{
					name:        "grep",
					args:        []string{"grep", "parseToolCommand", "-A", "10"},
					options:     []string{"-A"},
					positionals: []string{"parseToolCommand", "10"},
					chain:       "|",
				},
			},
		},
		{
			name:  "multiple commands",
			input: "cd loop-desktop && npm run build",
			want: []struct {
				name        string
				args        []string
				chain       string
				options     []string
				positionals []string
				redirects   []Redirect
				substRaw    []string
			}{
				{
					name:        "cd",
					args:        []string{"cd", "loop-desktop"},
					positionals: []string{"loop-desktop"},
				},
				{
					name:        "npm",
					args:        []string{"npm", "run", "build"},
					positionals: []string{"run", "build"},
					chain:       "&&",
				},
			},
		},
		{
			name:  "heredoc and redirection",
			input: "cat << 'EOF' > patch_test.js\nconst a = 1;\nEOF\nnode patch_test.js",
			want: []struct {
				name        string
				args        []string
				chain       string
				options     []string
				positionals []string
				redirects   []Redirect
				substRaw    []string
			}{
				{
					name: "cat",
					args: []string{"cat"},
					redirects: []Redirect{
						{Type: TokenRedirectIn, Operator: "<<", Target: "EOF", Heredoc: true, HeredocBody: "const a = 1;\n"},
						{Type: TokenRedirectOut, Operator: ">", Target: "patch_test.js"},
					},
				},
				{
					name:        "node",
					args:        []string{"node", "patch_test.js"},
					positionals: []string{"patch_test.js"},
					chain:       ";",
				},
			},
		},
		{
			name:  "subshell execution inside command",
			input: "echo $(ls -la)",
			want: []struct {
				name        string
				args        []string
				chain       string
				options     []string
				positionals []string
				redirects   []Redirect
				substRaw    []string
			}{
				{
					name:    "ls",
					args:    []string{"ls", "-la"},
					options: []string{"-la"},
				},
				{
					name:        "echo",
					args:        []string{"echo", "$(ls -la)"},
					positionals: []string{"$(ls -la)"},
					substRaw:    []string{"$(ls -la)"},
				},
			},
		},
		{
			name:  "backtick command substitution",
			input: "rm -rf `find . -name temp`",
			want: []struct {
				name        string
				args        []string
				chain       string
				options     []string
				positionals []string
				redirects   []Redirect
				substRaw    []string
			}{
				{
					name:        "find",
					args:        []string{"find", ".", "-name", "temp"},
					options:     []string{"-name"},
					positionals: []string{".", "temp"},
				},
				{
					name:        "rm",
					args:        []string{"rm", "-rf", "$(find . -name temp)"},
					options:     []string{"-rf"},
					positionals: []string{"$(find . -name temp)"},
					substRaw:    []string{"$(find . -name temp)"},
				},
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := Parse(tt.input)
			if err != nil {
				t.Fatalf("Parse() error = %v", err)
			}
			if len(got) != len(tt.want) {
				t.Fatalf("len(Parse()) = %d, want %d", len(got), len(tt.want))
			}
			for i := range tt.want {
				if got[i].Name != tt.want[i].name {
					t.Fatalf("command[%d].Name = %q, want %q", i, got[i].Name, tt.want[i].name)
				}
				if !equalStrings(got[i].Args, tt.want[i].args) {
					t.Fatalf("command[%d].Args = %#v, want %#v", i, got[i].Args, tt.want[i].args)
				}
				if got[i].ChainOperator != tt.want[i].chain {
					t.Fatalf("command[%d].ChainOperator = %q, want %q", i, got[i].ChainOperator, tt.want[i].chain)
				}
				if !equalStrings(optionNames(got[i].Options), tt.want[i].options) {
					t.Fatalf("command[%d].Options = %#v, want %#v", i, optionNames(got[i].Options), tt.want[i].options)
				}
				if !equalStrings(got[i].Positionals, tt.want[i].positionals) {
					t.Fatalf("command[%d].Positionals = %#v, want %#v", i, got[i].Positionals, tt.want[i].positionals)
				}
				if len(got[i].Redirects) != len(tt.want[i].redirects) {
					t.Fatalf("command[%d].Redirects len = %d, want %d", i, len(got[i].Redirects), len(tt.want[i].redirects))
				}
				for j := range tt.want[i].redirects {
					if got[i].Redirects[j] != tt.want[i].redirects[j] {
						t.Fatalf("command[%d].Redirects[%d] = %#v, want %#v", i, j, got[i].Redirects[j], tt.want[i].redirects[j])
					}
				}
				if !equalStrings(substitutionRaw(got[i].Substitutions), tt.want[i].substRaw) {
					t.Fatalf("command[%d].Substitutions = %#v, want %#v", i, substitutionRaw(got[i].Substitutions), tt.want[i].substRaw)
				}
			}
		})
	}
}

func TestAnalyzeFlags(t *testing.T) {
	analysis, err := Analyze("cat << 'EOF' > /tmp/x\nhello\nEOF\ncd loop && npm run build | tee /tmp/out")
	if err != nil {
		t.Fatalf("Analyze() error = %v", err)
	}
	if !analysis.HasHeredocs {
		t.Fatal("expected heredoc flag")
	}
	if !analysis.HasBooleanChains {
		t.Fatal("expected boolean-chain flag")
	}
	if !analysis.HasPipelines {
		t.Fatal("expected pipeline flag")
	}
}

func TestParseHistoricalCommandsFromLoopDB(t *testing.T) {
	dbPath := filepath.Clean(filepath.Join("..", "..", "..", "loop.db"))
	db, err := sql.Open("sqlite3", dbPath)
	if err != nil {
		t.Skipf("open loop.db: %v", err)
	}
	defer db.Close()

	const query = `
with tool_cmds as (
  select json_extract(json_extract(metadata_json,'$.args'),'$.command') as cmd
  from ui_events
  where kind='tool_start'
    and json_extract(metadata_json,'$.tool_name')='shell'
    and json_valid(json_extract(metadata_json,'$.args'))
  union all
  select json_extract(json_extract(metadata_json,'$.args'),'$.cmd') as cmd
  from ui_events
  where kind='tool_start'
    and json_extract(metadata_json,'$.tool_name')='exec_command'
    and json_valid(json_extract(metadata_json,'$.args'))
)
select cmd
from tool_cmds
where cmd is not null and trim(cmd) <> '';
`

	rows, err := db.Query(query)
	if err != nil {
		t.Fatalf("query historical commands: %v", err)
	}
	defer rows.Close()

	var (
		total           int
		parsed          int
		sawPipeline     bool
		sawBooleanChain bool
		sawHeredoc      bool
		sawCommandSubst bool
	)

	for rows.Next() {
		var cmd string
		if err := rows.Scan(&cmd); err != nil {
			t.Fatalf("scan historical command: %v", err)
		}
		total++
		if strings.Contains(cmd, "(truncated)") {
			continue
		}
		analysis, err := Analyze(cmd)
		if err != nil {
			t.Fatalf("Analyze(%q) error = %v", cmd, err)
		}
		parsed++
		sawPipeline = sawPipeline || analysis.HasPipelines
		sawBooleanChain = sawBooleanChain || analysis.HasBooleanChains
		sawHeredoc = sawHeredoc || analysis.HasHeredocs
		sawCommandSubst = sawCommandSubst || analysis.HasCommandSubst
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("iterate historical commands: %v", err)
	}

	if total < 500 {
		t.Fatalf("expected substantial historical command corpus, got %d commands", total)
	}
	if parsed < 500 {
		t.Fatalf("expected substantial parsed historical command corpus, got %d commands", parsed)
	}
	if !sawPipeline {
		t.Fatal("expected at least one pipeline in historical corpus")
	}
	if !sawBooleanChain {
		t.Fatal("expected at least one boolean chain in historical corpus")
	}
	if !sawHeredoc {
		t.Fatal("expected at least one heredoc in historical corpus")
	}
	if !sawCommandSubst {
		t.Fatal("expected at least one command substitution in historical corpus")
	}
}

func optionNames(opts []Option) []string {
	names := make([]string, 0, len(opts))
	for _, opt := range opts {
		names = append(names, opt.Name)
	}
	return names
}

func substitutionRaw(subs []Substitution) []string {
	raw := make([]string, 0, len(subs))
	for _, sub := range subs {
		raw = append(raw, sub.Raw)
	}
	return raw
}

func equalStrings(got []string, want []string) bool {
	if len(got) != len(want) {
		return false
	}
	for i := range got {
		if got[i] != want[i] {
			return false
		}
	}
	return true
}
