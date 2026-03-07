package checkpoints_test

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"testing"

	"loop/checkpoints"
	"loop/models"
	"loop/store"
	"loop/store/sqlite"
)

type fakeBackend struct {
	createCount     int
	createSnapshots map[string]*checkpoints.Snapshot
	restoreCalls    []*checkpoints.Snapshot
	deletedRefs     []string
	fileContents    map[string][]byte
	createErr       error
	restoreErr      error
	readFileErr     error
}

func (b *fakeBackend) Create(_ context.Context, _ string, req checkpoints.CreateRequest) (*checkpoints.Snapshot, error) {
	if b.createErr != nil {
		return nil, b.createErr
	}
	b.createCount++
	snapshot := &checkpoints.Snapshot{
		CommitID:                  fmt.Sprintf("commit-%d", b.createCount),
		Parent:                    fmt.Sprintf("parent-%d", b.createCount),
		Ref:                       fmt.Sprintf("ref-%s", req.CheckpointID),
		PreexistingUntrackedFiles: []string{"keep.txt"},
		PreexistingUntrackedDirs:  []string{"cache"},
	}
	if b.createSnapshots == nil {
		b.createSnapshots = map[string]*checkpoints.Snapshot{}
	}
	b.createSnapshots[req.CheckpointID] = snapshot
	return snapshot, nil
}

func (b *fakeBackend) Restore(_ context.Context, _ string, snapshot *checkpoints.Snapshot) error {
	if b.restoreErr != nil {
		return b.restoreErr
	}
	b.restoreCalls = append(b.restoreCalls, snapshot)
	return nil
}

func (b *fakeBackend) DeleteRef(_ context.Context, _ string, ref string) error {
	b.deletedRefs = append(b.deletedRefs, ref)
	return nil
}

func (b *fakeBackend) ReadFileAtSnapshot(_ context.Context, _ string, _ *checkpoints.Snapshot, relativePath string) ([]byte, error) {
	if b.readFileErr != nil {
		return nil, b.readFileErr
	}
	if content, ok := b.fileContents[relativePath]; ok {
		return append([]byte(nil), content...), nil
	}
	return nil, errors.New("missing file")
}

func newCheckpointTestStore(t *testing.T) store.Store {
	t.Helper()
	s, err := sqlite.New(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func seedCheckpointConversation(t *testing.T, s store.Store) (*models.Workspace, *models.Conversation) {
	t.Helper()
	ctx := context.Background()
	root := t.TempDir()
	ws := &models.Workspace{
		ID:                "ws-checkpoints-service",
		Name:              "Service Workspace",
		RootPath:          root,
		CanonicalRootPath: root,
	}
	if err := s.Workspaces().Create(ctx, ws); err != nil {
		t.Fatalf("create workspace: %v", err)
	}
	conv := &models.Conversation{
		ID:          "conv-checkpoints-service",
		WorkspaceID: ws.ID,
		Title:       "Service conversation",
	}
	if err := s.Conversations().Create(ctx, conv); err != nil {
		t.Fatalf("create conversation: %v", err)
	}
	return ws, conv
}

func TestServiceCreateEmitsUIEventAndPrunesStaleCheckpoints(t *testing.T) {
	s := newCheckpointTestStore(t)
	defer s.Close()
	ws, conv := seedCheckpointConversation(t, s)
	ctx := context.Background()
	backend := &fakeBackend{}
	service := checkpoints.NewService(s, checkpoints.StaticResolver{Backend: backend})

	cp1, err := service.Create(ctx, ws, conv, checkpoints.CreateOptions{Label: "first", RetentionLimit: 2})
	if err != nil {
		t.Fatalf("create cp1: %v", err)
	}
	cp2, err := service.Create(ctx, ws, conv, checkpoints.CreateOptions{Label: "second", RetentionLimit: 2})
	if err != nil {
		t.Fatalf("create cp2: %v", err)
	}
	cp3, err := service.Create(ctx, ws, conv, checkpoints.CreateOptions{Label: "third", RetentionLimit: 2})
	if err != nil {
		t.Fatalf("create cp3: %v", err)
	}

	checkpointsList, err := s.Checkpoints().ListByConversation(ctx, conv.ID, 10)
	if err != nil {
		t.Fatalf("list checkpoints: %v", err)
	}
	if len(checkpointsList) != 2 {
		t.Fatalf("checkpoint count = %d, want 2", len(checkpointsList))
	}
	if checkpointsList[0].ID != cp3.ID || checkpointsList[1].ID != cp2.ID {
		t.Fatalf("checkpoint order = [%s,%s], want [%s,%s]", checkpointsList[0].ID, checkpointsList[1].ID, cp3.ID, cp2.ID)
	}
	if len(backend.deletedRefs) != 1 || backend.deletedRefs[0] != cp1.GitRef {
		t.Fatalf("deleted refs = %v, want [%s]", backend.deletedRefs, cp1.GitRef)
	}

	events, err := s.UIEvents().GetByConversation(ctx, conv.ID)
	if err != nil {
		t.Fatalf("get ui events: %v", err)
	}
	if len(events) != 3 {
		t.Fatalf("ui event count = %d, want 3", len(events))
	}
	last := events[len(events)-1]
	if last.Kind != models.UIEventKindCheckpointCreated {
		t.Fatalf("last ui event kind = %s, want %s", last.Kind, models.UIEventKindCheckpointCreated)
	}
	if got := fmt.Sprint(last.Metadata["checkpoint_id"]); got != cp3.ID {
		t.Fatalf("checkpoint_id metadata = %v, want %s", last.Metadata["checkpoint_id"], cp3.ID)
	}
}

func TestServiceUndoLatestRestoresAndConsumesCheckpoint(t *testing.T) {
	s := newCheckpointTestStore(t)
	defer s.Close()
	ws, conv := seedCheckpointConversation(t, s)
	ctx := context.Background()
	backend := &fakeBackend{}
	service := checkpoints.NewService(s, checkpoints.StaticResolver{Backend: backend})

	cp1, err := service.Create(ctx, ws, conv, checkpoints.CreateOptions{Label: "first"})
	if err != nil {
		t.Fatalf("create cp1: %v", err)
	}
	cp2, err := service.Create(ctx, ws, conv, checkpoints.CreateOptions{Label: "second"})
	if err != nil {
		t.Fatalf("create cp2: %v", err)
	}

	undone, err := service.UndoLatest(ctx, ws, conv.ID, checkpoints.RestoreOptions{Reason: "undo_latest"})
	if err != nil {
		t.Fatalf("undo latest: %v", err)
	}
	if undone.ID != cp2.ID {
		t.Fatalf("undone checkpoint = %s, want %s", undone.ID, cp2.ID)
	}
	if len(backend.restoreCalls) != 1 || backend.restoreCalls[0].CommitID != cp2.CommitID {
		t.Fatalf("restore calls = %+v, want commit %s", backend.restoreCalls, cp2.CommitID)
	}
	if got, err := s.Checkpoints().LatestByConversation(ctx, conv.ID); err != nil || got.ID != cp1.ID {
		t.Fatalf("latest checkpoint after undo = %+v err=%v, want %s", got, err, cp1.ID)
	}
	if len(backend.deletedRefs) == 0 || backend.deletedRefs[len(backend.deletedRefs)-1] != cp2.GitRef {
		t.Fatalf("deleted refs = %v, want trailing %s", backend.deletedRefs, cp2.GitRef)
	}

	events, err := s.UIEvents().GetByConversation(ctx, conv.ID)
	if err != nil {
		t.Fatalf("get ui events: %v", err)
	}
	last := events[len(events)-1]
	if last.Kind != models.UIEventKindCheckpointRestored {
		t.Fatalf("last ui event kind = %s, want %s", last.Kind, models.UIEventKindCheckpointRestored)
	}
	if got := fmt.Sprint(last.Metadata["checkpoint_id"]); got != cp2.ID {
		t.Fatalf("restore metadata checkpoint_id = %v, want %s", last.Metadata["checkpoint_id"], cp2.ID)
	}
	if got := fmt.Sprint(last.Metadata["reason"]); got != "undo_latest" {
		t.Fatalf("restore metadata reason = %v, want undo_latest", last.Metadata["reason"])
	}
}

func TestServiceRestoreFailureEmitsFailureEvent(t *testing.T) {
	s := newCheckpointTestStore(t)
	defer s.Close()
	ws, conv := seedCheckpointConversation(t, s)
	ctx := context.Background()
	backend := &fakeBackend{restoreErr: errors.New("restore exploded")}
	service := checkpoints.NewService(s, checkpoints.StaticResolver{Backend: backend})

	cp, err := service.Create(ctx, ws, conv, checkpoints.CreateOptions{Label: "first"})
	if err != nil {
		t.Fatalf("create checkpoint: %v", err)
	}

	err = service.Restore(ctx, ws, conv.ID, cp, checkpoints.RestoreOptions{Reason: "manual_restore"})
	if err == nil {
		t.Fatalf("expected restore error")
	}

	events, err := s.UIEvents().GetByConversation(ctx, conv.ID)
	if err != nil {
		t.Fatalf("get ui events: %v", err)
	}
	last := events[len(events)-1]
	if last.Kind != models.UIEventKindCheckpointRestoreFailed {
		t.Fatalf("last ui event kind = %s, want %s", last.Kind, models.UIEventKindCheckpointRestoreFailed)
	}
	if got := fmt.Sprint(last.Metadata["error"]); got != "restore exploded" {
		t.Fatalf("restore failure error metadata = %v, want restore exploded", last.Metadata["error"])
	}
}

func TestServiceReadFileAtCheckpointValidatesConversation(t *testing.T) {
	s := newCheckpointTestStore(t)
	defer s.Close()
	ws, conv := seedCheckpointConversation(t, s)
	ctx := context.Background()
	backend := &fakeBackend{fileContents: map[string][]byte{"deleted.txt": []byte("restore me\n")}}
	service := checkpoints.NewService(s, checkpoints.StaticResolver{Backend: backend})

	cp, err := service.Create(ctx, ws, conv, checkpoints.CreateOptions{Label: "first"})
	if err != nil {
		t.Fatalf("create checkpoint: %v", err)
	}

	content, loaded, err := service.ReadFileAtCheckpoint(ctx, ws, conv.ID, cp.ID, "deleted.txt")
	if err != nil {
		t.Fatalf("read file at checkpoint: %v", err)
	}
	if string(content) != "restore me\n" {
		t.Fatalf("content = %q, want %q", string(content), "restore me\n")
	}
	if loaded.ID != cp.ID {
		t.Fatalf("loaded checkpoint = %s, want %s", loaded.ID, cp.ID)
	}

	otherConv := &models.Conversation{ID: "conv-other", WorkspaceID: ws.ID, Title: "Other"}
	if err := s.Conversations().Create(ctx, otherConv); err != nil {
		t.Fatalf("create other conversation: %v", err)
	}
	if _, _, err := service.ReadFileAtCheckpoint(ctx, ws, otherConv.ID, cp.ID, "deleted.txt"); err == nil || err.Error() != "checkpoint not found" {
		t.Fatalf("expected checkpoint not found for foreign conversation, got %v", err)
	}
}
