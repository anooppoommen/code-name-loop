package sqlite_test

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"loop/models"
	"loop/store/sqlite"
)

func TestCheckpointStoreCreateListLatestAndPrune(t *testing.T) {
	dir := t.TempDir()
	s, err := sqlite.New(filepath.Join(dir, "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()

	ctx := context.Background()
	ws := &models.Workspace{
		ID:                "ws-checkpoints",
		Name:              "Checkpoints",
		RootPath:          dir,
		CanonicalRootPath: dir,
	}
	if err := s.Workspaces().Create(ctx, ws); err != nil {
		t.Fatalf("create workspace: %v", err)
	}
	conv := &models.Conversation{
		ID:          "conv-checkpoints",
		WorkspaceID: ws.ID,
		Title:       "Checkpoint test",
	}
	if err := s.Conversations().Create(ctx, conv); err != nil {
		t.Fatalf("create conversation: %v", err)
	}

	makeCheckpoint := func(id, label, commit string) *models.Checkpoint {
		return &models.Checkpoint{
			ID:                        id,
			ConversationID:            conv.ID,
			WorkspaceID:               ws.ID,
			Label:                     label,
			GitRef:                    "refs/loop/checkpoints/" + id,
			CommitID:                  commit,
			ParentCommitID:            "",
			PreexistingUntrackedFiles: []string{"keep.txt"},
			PreexistingUntrackedDirs:  []string{"tmp"},
		}
	}

	cp1 := makeCheckpoint("chk-1", "first", "abc1111")
	cp2 := makeCheckpoint("chk-2", "second", "abc2222")
	cp3 := makeCheckpoint("chk-3", "third", "abc3333")

	if err := s.Checkpoints().Create(ctx, cp1); err != nil {
		t.Fatalf("create cp1: %v", err)
	}
	time.Sleep(2 * time.Millisecond)
	if err := s.Checkpoints().Create(ctx, cp2); err != nil {
		t.Fatalf("create cp2: %v", err)
	}
	time.Sleep(2 * time.Millisecond)
	if err := s.Checkpoints().Create(ctx, cp3); err != nil {
		t.Fatalf("create cp3: %v", err)
	}

	latest, err := s.Checkpoints().LatestByConversation(ctx, conv.ID)
	if err != nil {
		t.Fatalf("latest checkpoint: %v", err)
	}
	if latest.ID != cp3.ID {
		t.Fatalf("latest id = %s, want %s", latest.ID, cp3.ID)
	}

	list, err := s.Checkpoints().ListByConversation(ctx, conv.ID, 10)
	if err != nil {
		t.Fatalf("list checkpoints: %v", err)
	}
	if len(list) != 3 {
		t.Fatalf("list size = %d, want 3", len(list))
	}
	if list[0].ID != cp3.ID || list[1].ID != cp2.ID || list[2].ID != cp1.ID {
		t.Fatalf("list order = [%s,%s,%s], want [%s,%s,%s]",
			list[0].ID, list[1].ID, list[2].ID, cp3.ID, cp2.ID, cp1.ID)
	}

	if err := s.Checkpoints().PruneByConversation(ctx, conv.ID, 1); err != nil {
		t.Fatalf("prune checkpoints: %v", err)
	}

	afterPrune, err := s.Checkpoints().ListByConversation(ctx, conv.ID, 10)
	if err != nil {
		t.Fatalf("list after prune: %v", err)
	}
	if len(afterPrune) != 1 {
		t.Fatalf("after prune size = %d, want 1", len(afterPrune))
	}
	if afterPrune[0].ID != cp3.ID {
		t.Fatalf("after prune id = %s, want %s", afterPrune[0].ID, cp3.ID)
	}
}
