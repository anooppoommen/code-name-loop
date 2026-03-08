package shellparser

import (
	"database/sql"
	"os"
	"path/filepath"
	"strings"
	"testing"

	_ "github.com/mattn/go-sqlite3"
)

func TestResolveTargets(t *testing.T) {
	workdir := t.TempDir()
	mustMkdirAll(t, filepath.Join(workdir, "src"))
	mustMkdirAll(t, filepath.Join(workdir, "scripts"))
	mustMkdirAll(t, filepath.Join(workdir, "loop-desktop", "src"))
	mustMkdirAll(t, filepath.Join(workdir, "rust"))
	mustMkdirAll(t, filepath.Join(workdir, "buildsys"))
	mustWriteFile(t, filepath.Join(workdir, "src", "app.ts"), "export {}")
	mustWriteFile(t, filepath.Join(workdir, "src", "index.ts"), "export {}")
	mustWriteFile(t, filepath.Join(workdir, "src", "main.rs"), "fn main() {}")
	mustWriteFile(t, filepath.Join(workdir, "scripts", "fix-eslint.js"), "console.log('fix')")
	mustWriteFile(t, filepath.Join(workdir, "loop-desktop", "src", "App.tsx"), "export {}")
	mustWriteFile(t, filepath.Join(workdir, "loop-desktop", "package.json"), `{"name":"loop-desktop"}`)
	mustWriteFile(t, filepath.Join(workdir, "loop-desktop", "package-lock.json"), `{"name":"loop-desktop"}`)
	mustWriteFile(t, filepath.Join(workdir, "rust", "Cargo.toml"), "[package]\nname='demo'\nversion='0.1.0'\n")
	mustWriteFile(t, filepath.Join(workdir, "rust", "Cargo.lock"), "# lock")
	mustWriteFile(t, filepath.Join(workdir, "buildsys", "Makefile"), "build:\n\t@echo build\n")

	tests := []struct {
		name        string
		input       string
		wantTargets []Target
		wantUnknown []UnknownTarget
	}{
		{
			name:  "cat file reads file",
			input: "cat src/app.ts",
			wantTargets: []Target{
				{Command: "cat", Raw: "src/app.ts", Path: filepath.Join(workdir, "src", "app.ts"), Access: AccessRead, Kind: KindFile},
			},
		},
		{
			name:  "rg pattern with root",
			input: `rg -i "thinking.*level" loop-desktop`,
			wantTargets: []Target{
				{Command: "rg", Raw: "loop-desktop", Path: filepath.Join(workdir, "loop-desktop"), Access: AccessSearch, Kind: KindDirectory},
			},
		},
		{
			name:  "git diff file path",
			input: "git diff loop-desktop/src/App.tsx",
			wantTargets: []Target{
				{Command: "git", Raw: "loop-desktop/src/App.tsx", Path: filepath.Join(workdir, "loop-desktop", "src", "App.tsx"), Access: AccessRead, Kind: KindFile},
			},
		},
		{
			name:  "sed in place writes file",
			input: `sed -i '' 's/a/b/' loop-desktop/src/App.tsx`,
			wantTargets: []Target{
				{Command: "sed", Raw: "loop-desktop/src/App.tsx", Path: filepath.Join(workdir, "loop-desktop", "src", "App.tsx"), Access: AccessWrite, Kind: KindFile},
			},
		},
		{
			name:  "cp tracks source and destination",
			input: "cp /tmp/a.ts src/a.ts",
			wantTargets: []Target{
				{Command: "cp", Raw: "/tmp/a.ts", Path: "/tmp/a.ts", Access: AccessRead, Kind: KindPath},
				{Command: "cp", Raw: "src/a.ts", Path: filepath.Join(workdir, "src", "a.ts"), Access: AccessWrite, Kind: KindPath},
			},
		},
		{
			name:  "output redirect writes file",
			input: "echo hi > /tmp/out.txt",
			wantTargets: []Target{
				{Command: "echo", Raw: "/tmp/out.txt", Path: "/tmp/out.txt", Access: AccessWrite, Kind: KindFile, FromRedirect: true},
			},
		},
		{
			name:  "patch has unknown writes and reads patch file",
			input: "patch -p0 < patch.diff",
			wantTargets: []Target{
				{Command: "patch", Raw: "patch.diff", Path: filepath.Join(workdir, "patch.diff"), Access: AccessRead, Kind: KindFile, FromRedirect: true},
			},
			wantUnknown: []UnknownTarget{
				{Command: "patch", Access: AccessWrite, Reason: "patch contents determine the files being modified"},
			},
		},
		{
			name:  "grep file operand",
			input: `grep -n "Composer" loop-desktop/src/App.tsx`,
			wantTargets: []Target{
				{Command: "grep", Raw: "loop-desktop/src/App.tsx", Path: filepath.Join(workdir, "loop-desktop", "src", "App.tsx"), Access: AccessSearch, Kind: KindFile},
			},
		},
		{
			name:  "go build output binary",
			input: "go build -o loop_bin .",
			wantTargets: []Target{
				{Command: "go", Raw: "loop_bin", Path: filepath.Join(workdir, "loop_bin"), Access: AccessWrite, Kind: KindPath},
				{Command: "go", Raw: ".", Path: workdir, Access: AccessRead, Kind: KindDirectory},
			},
		},
		{
			name:  "cd chain updates npm workdir",
			input: "cd loop-desktop && npm run build",
			wantTargets: []Target{
				{Command: "npm", Raw: "package.json", Path: filepath.Join(workdir, "loop-desktop", "package.json"), Access: AccessRead, Kind: KindFile},
				{Command: "npm", Raw: "package-lock.json", Path: filepath.Join(workdir, "loop-desktop", "package-lock.json"), Access: AccessRead, Kind: KindFile},
				{Command: "npm", Raw: "npm-shrinkwrap.json", Path: filepath.Join(workdir, "loop-desktop", "npm-shrinkwrap.json"), Access: AccessRead, Kind: KindFile},
			},
			wantUnknown: []UnknownTarget{
				{Command: "npm", Access: AccessWrite, Reason: "script name indicates it likely writes build artifacts or mutates project files"},
			},
		},
		{
			name:  "node script reads script file",
			input: "node scripts/fix-eslint.js",
			wantTargets: []Target{
				{Command: "node", Raw: "scripts/fix-eslint.js", Path: filepath.Join(workdir, "scripts", "fix-eslint.js"), Access: AccessRead, Kind: KindFile},
			},
		},
		{
			name:  "bun build outfile",
			input: "bun build src/index.ts --outfile dist/app.js",
			wantTargets: []Target{
				{Command: "bun", Raw: "src/index.ts", Path: filepath.Join(workdir, "src", "index.ts"), Access: AccessRead, Kind: KindFile},
				{Command: "bun", Raw: "dist/app.js", Path: filepath.Join(workdir, "dist", "app.js"), Access: AccessWrite, Kind: KindFile},
			},
		},
		{
			name:  "cargo build manifest and target dir",
			input: "cargo build --manifest-path rust/Cargo.toml --target-dir rust/target",
			wantTargets: []Target{
				{Command: "cargo", Raw: "rust/Cargo.toml", Path: filepath.Join(workdir, "rust", "Cargo.toml"), Access: AccessRead, Kind: KindFile},
				{Command: "cargo", Raw: "rust/Cargo.lock", Path: filepath.Join(workdir, "rust", "Cargo.lock"), Access: AccessRead, Kind: KindFile},
				{Command: "cargo", Raw: "rust/target", Path: filepath.Join(workdir, "rust", "target"), Access: AccessWrite, Kind: KindDirectory},
			},
		},
		{
			name:  "rustc input and output",
			input: "rustc src/main.rs -o bin/app",
			wantTargets: []Target{
				{Command: "rustc", Raw: "bin/app", Path: filepath.Join(workdir, "bin", "app"), Access: AccessWrite, Kind: KindFile},
				{Command: "rustc", Raw: "src/main.rs", Path: filepath.Join(workdir, "src", "main.rs"), Access: AccessRead, Kind: KindFile},
			},
		},
		{
			name:  "make custom file with build target",
			input: "make -C buildsys -f Makefile build",
			wantTargets: []Target{
				{Command: "make", Raw: "Makefile", Path: filepath.Join(workdir, "buildsys", "Makefile"), Access: AccessRead, Kind: KindFile},
			},
			wantUnknown: []UnknownTarget{
				{Command: "make", Access: AccessWrite, Reason: "task recipe name indicates it likely writes or deletes project outputs"},
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			resolution, err := ResolveTargets(tt.input, workdir)
			if err != nil {
				t.Fatalf("ResolveTargets() error = %v", err)
			}
			gotTargets := flattenTargets(resolution)
			gotUnknown := flattenUnknown(resolution)
			if len(gotTargets) != len(tt.wantTargets) {
				t.Fatalf("len(targets) = %d, want %d: %#v", len(gotTargets), len(tt.wantTargets), gotTargets)
			}
			for i := range tt.wantTargets {
				if gotTargets[i] != tt.wantTargets[i] {
					t.Fatalf("target[%d] = %#v, want %#v", i, gotTargets[i], tt.wantTargets[i])
				}
			}
			if len(gotUnknown) != len(tt.wantUnknown) {
				t.Fatalf("len(unknown) = %d, want %d: %#v", len(gotUnknown), len(tt.wantUnknown), gotUnknown)
			}
			for i := range tt.wantUnknown {
				if gotUnknown[i] != tt.wantUnknown[i] {
					t.Fatalf("unknown[%d] = %#v, want %#v", i, gotUnknown[i], tt.wantUnknown[i])
				}
			}
		})
	}
}

func TestResolveTargetsHistoricalCorpus(t *testing.T) {
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
		total         int
		parsed        int
		readTargets   int
		writeTargets  int
		searchTargets int
		listTargets   int
		unknownWrites int
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
		resolution, err := ResolveTargets(cmd, "/workspace")
		if err != nil {
			t.Fatalf("ResolveTargets(%q) error = %v", cmd, err)
		}
		parsed++
		for _, target := range flattenTargets(resolution) {
			switch target.Access {
			case AccessRead:
				readTargets++
			case AccessWrite, AccessDelete:
				writeTargets++
			case AccessSearch:
				searchTargets++
			case AccessList, AccessMetadata:
				listTargets++
			}
		}
		for _, unknown := range flattenUnknown(resolution) {
			if unknown.Access == AccessWrite || unknown.Access == AccessDelete {
				unknownWrites++
			}
		}
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("iterate historical commands: %v", err)
	}

	if total < 500 {
		t.Fatalf("expected substantial historical command corpus, got %d", total)
	}
	if parsed < 500 {
		t.Fatalf("expected substantial parsed corpus, got %d", parsed)
	}
	if readTargets == 0 {
		t.Fatal("expected historical corpus to resolve read targets")
	}
	if searchTargets == 0 {
		t.Fatal("expected historical corpus to resolve search targets")
	}
	if listTargets == 0 {
		t.Fatal("expected historical corpus to resolve list/metadata targets")
	}
	if writeTargets == 0 && unknownWrites == 0 {
		t.Fatal("expected historical corpus to contain write targets or unknown writes")
	}
}

func flattenTargets(resolution *TargetResolution) []Target {
	var out []Target
	for _, cmd := range resolution.Commands {
		out = append(out, cmd.Targets...)
	}
	return out
}

func flattenUnknown(resolution *TargetResolution) []UnknownTarget {
	var out []UnknownTarget
	for _, cmd := range resolution.Commands {
		out = append(out, cmd.Unknown...)
	}
	return out
}

func mustMkdirAll(t *testing.T, path string) {
	t.Helper()
	if err := os.MkdirAll(path, 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", path, err)
	}
}

func mustWriteFile(t *testing.T, path string, contents string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(contents), 0o644); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}
