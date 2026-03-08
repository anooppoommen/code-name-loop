package toolmeta

import (
	"encoding/json"
	"testing"
)

func TestClassify(t *testing.T) {
	tests := []struct {
		name     string
		toolName string
		args     string
		want     []string
	}{
		{name: "read file", toolName: "read_file", args: `{"file_path":"a.go"}`, want: []string{"read"}},
		{name: "grep files", toolName: "grep_files", args: `{"pattern":"foo","path":"."}`, want: []string{"discovery"}},
		{name: "apply patch", toolName: "apply_patch", args: `{"input":"*** Begin Patch\n*** End Patch"}`, want: []string{"write"}},
		{name: "shell cat", toolName: "shell", args: `{"command":"cat src/app.ts"}`, want: []string{"read"}},
		{name: "exec rg", toolName: "exec_command", args: `{"cmd":"rg foo src"}`, want: []string{"discovery"}},
		{name: "shell rm", toolName: "shell", args: `{"command":"rm -f tmp.txt"}`, want: []string{"write"}},
		{name: "exec chained go build and help", toolName: "exec_command", args: `{"cmd":"cd loop && go build -o loop_bin . && ./loop_bin agent --help"}`, want: []string{"read", "write"}},
		{name: "npm build", toolName: "exec_command", args: `{"cmd":"cd loop-desktop && npm run build"}`, want: []string{"read", "write"}},
		{name: "node script", toolName: "shell", args: `{"command":"node scripts/fix-eslint.js"}`, want: []string{"read"}},
		{name: "bun build", toolName: "exec_command", args: `{"cmd":"bun build src/index.ts --outfile dist/app.js"}`, want: []string{"read", "write"}},
		{name: "cargo build", toolName: "exec_command", args: `{"cmd":"cargo build --manifest-path rust/Cargo.toml --target-dir rust/target"}`, want: []string{"read", "write"}},
		{name: "make build", toolName: "exec_command", args: `{"cmd":"make -C buildsys -f Makefile build"}`, want: []string{"read", "write"}},
		{name: "parallel union", toolName: "parallel_tool_use", args: `{"tool_uses":[{"recipient_name":"functions.exec_command","parameters":{"cmd":"cat src/app.ts"}},{"recipient_name":"functions.grep_files","parameters":{"pattern":"foo","path":"."}}]}`, want: []string{"discovery", "read"}},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := Classify(tt.toolName, json.RawMessage(tt.args))
			if len(got) != len(tt.want) {
				t.Fatalf("Classify() = %#v, want %#v", got, tt.want)
			}
			for i := range got {
				if got[i] != tt.want[i] {
					t.Fatalf("Classify() = %#v, want %#v", got, tt.want)
				}
			}
		})
	}
}
