package checkpoints

import (
	"context"
	"fmt"
	"strings"

	"loop/gitcheckpoints"
	"loop/models"
)

type GitBackend struct{}

func NewGitBackend() GitBackend {
	return GitBackend{}
}

func (GitBackend) Create(ctx context.Context, workspacePath string, req CreateRequest) (*Snapshot, error) {
	refName := checkpointRefName(req.ConversationID, req.CheckpointID)
	snapshot, err := gitcheckpoints.Create(ctx, workspacePath, refName, req.Label)
	if err != nil {
		return nil, err
	}
	return &Snapshot{
		CommitID:                  snapshot.CommitID,
		Parent:                    snapshot.Parent,
		Ref:                       snapshot.GitRef,
		PreexistingUntrackedFiles: snapshot.PreexistingUntrackedFiles,
		PreexistingUntrackedDirs:  snapshot.PreexistingUntrackedDirs,
	}, nil
}

func (GitBackend) Restore(ctx context.Context, workspacePath string, snapshot *Snapshot) error {
	return gitcheckpoints.Restore(ctx, workspacePath, &gitcheckpoints.Snapshot{
		CommitID:                  snapshot.CommitID,
		Parent:                    snapshot.Parent,
		GitRef:                    snapshot.Ref,
		PreexistingUntrackedFiles: snapshot.PreexistingUntrackedFiles,
		PreexistingUntrackedDirs:  snapshot.PreexistingUntrackedDirs,
	})
}

func (GitBackend) DeleteRef(ctx context.Context, workspacePath string, ref string) error {
	if err := gitcheckpoints.DeleteRef(ctx, workspacePath, ref); err != nil && !errorsIsNotGitOrMissing(err) {
		return err
	}
	return nil
}

func (GitBackend) ReadFileAtSnapshot(ctx context.Context, workspacePath string, snapshot *Snapshot, relativePath string) ([]byte, error) {
	return gitcheckpoints.ReadFileAtSnapshot(ctx, workspacePath, &gitcheckpoints.Snapshot{
		CommitID:                  snapshot.CommitID,
		Parent:                    snapshot.Parent,
		GitRef:                    snapshot.Ref,
		PreexistingUntrackedFiles: snapshot.PreexistingUntrackedFiles,
		PreexistingUntrackedDirs:  snapshot.PreexistingUntrackedDirs,
	}, relativePath)
}

func checkpointRefName(conversationID models.ConversationID, checkpointID string) string {
	return fmt.Sprintf("refs/loop/checkpoints/%s/%s",
		sanitizeRefComponent(string(conversationID)),
		sanitizeRefComponent(checkpointID),
	)
}

func sanitizeRefComponent(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "unknown"
	}
	var b strings.Builder
	for _, r := range raw {
		switch {
		case r >= 'a' && r <= 'z':
			b.WriteRune(r)
		case r >= 'A' && r <= 'Z':
			b.WriteRune(r)
		case r >= '0' && r <= '9':
			b.WriteRune(r)
		case r == '.', r == '-', r == '_':
			b.WriteRune(r)
		default:
			b.WriteRune('-')
		}
	}
	out := strings.Trim(b.String(), "-")
	if out == "" {
		return "unknown"
	}
	return out
}

func errorsIsNotGitOrMissing(err error) bool {
	if err == nil {
		return false
	}
	if err == gitcheckpoints.ErrNotGitRepository {
		return true
	}
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "cannot lock ref") || strings.Contains(msg, "not a valid ref")
}
