package checkpoints

import (
	"context"
	"errors"
	"fmt"
	"log"
	"strings"

	"github.com/google/uuid"

	"loop/models"
	"loop/store"
)

const ListSlack = 256

type Snapshot struct {
	CommitID string
	Parent   string
	Ref      string

	PreexistingUntrackedFiles []string
	PreexistingUntrackedDirs  []string
}

type Backend interface {
	Create(ctx context.Context, workspacePath string, req CreateRequest) (*Snapshot, error)
	Restore(ctx context.Context, workspacePath string, snapshot *Snapshot) error
	DeleteRef(ctx context.Context, workspacePath string, ref string) error
	ReadFileAtSnapshot(ctx context.Context, workspacePath string, snapshot *Snapshot, relativePath string) ([]byte, error)
}

type Resolver interface {
	Resolve(ws *models.Workspace) (Backend, error)
}

type StaticResolver struct {
	Backend Backend
}

func (r StaticResolver) Resolve(_ *models.Workspace) (Backend, error) {
	if r.Backend == nil {
		return nil, fmt.Errorf("checkpoint backend is not configured")
	}
	return r.Backend, nil
}

type CreateRequest struct {
	ConversationID models.ConversationID
	CheckpointID   string
	Label          string
}

type CreateOptions struct {
	Label          string
	Auto           bool
	MessageID      models.MessageID
	RetentionLimit int
}

type RestoreOptions struct {
	Reason    string
	MessageID models.MessageID
}

type Service struct {
	store    store.Store
	resolver Resolver
}

func NewService(s store.Store, resolver Resolver) *Service {
	return &Service{store: s, resolver: resolver}
}

func WorkspacePath(ws *models.Workspace) string {
	if ws == nil {
		return ""
	}
	if trimmed := strings.TrimSpace(ws.CanonicalRootPath); trimmed != "" {
		return trimmed
	}
	return strings.TrimSpace(ws.RootPath)
}

func SnapshotFromCheckpoint(cp *models.Checkpoint) *Snapshot {
	if cp == nil {
		return nil
	}
	return &Snapshot{
		CommitID:                  cp.CommitID,
		Parent:                    cp.ParentCommitID,
		Ref:                       cp.GitRef,
		PreexistingUntrackedFiles: append([]string(nil), cp.PreexistingUntrackedFiles...),
		PreexistingUntrackedDirs:  append([]string(nil), cp.PreexistingUntrackedDirs...),
	}
}

func (s *Service) Create(ctx context.Context, ws *models.Workspace, conv *models.Conversation, opts CreateOptions) (*models.Checkpoint, error) {
	if s == nil || s.store == nil || conv == nil || ws == nil {
		return nil, fmt.Errorf("checkpoint service requires store, workspace, and conversation")
	}
	backend, workspacePath, err := s.backendForWorkspace(ws)
	if err != nil {
		return nil, err
	}

	checkpointID := "chk-" + uuid.New().String()
	label := defaultLabel(opts.Label, opts.Auto)

	snapshot, err := backend.Create(ctx, workspacePath, CreateRequest{
		ConversationID: conv.ID,
		CheckpointID:   checkpointID,
		Label:          label,
	})
	if err != nil {
		return nil, err
	}

	cp := &models.Checkpoint{
		ID:                        checkpointID,
		ConversationID:            conv.ID,
		WorkspaceID:               ws.ID,
		Label:                     label,
		GitRef:                    snapshot.Ref,
		CommitID:                  snapshot.CommitID,
		ParentCommitID:            snapshot.Parent,
		PreexistingUntrackedFiles: snapshot.PreexistingUntrackedFiles,
		PreexistingUntrackedDirs:  snapshot.PreexistingUntrackedDirs,
	}
	if err := s.store.Checkpoints().Create(ctx, cp); err != nil {
		_ = backend.DeleteRef(ctx, workspacePath, cp.GitRef)
		return nil, err
	}

	s.appendUIEvent(ctx, conv.ID, opts.MessageID, models.UIEventKindCheckpointCreated,
		fmt.Sprintf("checkpoint saved (%s)", shortCommitID(cp.CommitID)),
		map[string]any{
			"checkpoint_id": cp.ID,
			"label":         cp.Label,
			"commit_id":     cp.CommitID,
			"auto":          opts.Auto,
		},
	)

	if opts.RetentionLimit > 0 {
		if err := s.Prune(ctx, ws, conv.ID, opts.RetentionLimit); err != nil {
			log.Printf("[checkpoint] prune conv=%s: %v", conv.ID, err)
		}
	}

	return cp, nil
}

func (s *Service) Restore(ctx context.Context, ws *models.Workspace, convID models.ConversationID, cp *models.Checkpoint, opts RestoreOptions) error {
	if s == nil || s.store == nil || ws == nil || cp == nil {
		return fmt.Errorf("checkpoint restore requires service, workspace, and checkpoint")
	}
	backend, workspacePath, err := s.backendForWorkspace(ws)
	if err != nil {
		return err
	}

	if err := backend.Restore(ctx, workspacePath, SnapshotFromCheckpoint(cp)); err != nil {
		s.appendUIEvent(ctx, convID, opts.MessageID, models.UIEventKindCheckpointRestoreFailed,
			restoreFailedText(opts.Reason, cp.CommitID),
			map[string]any{
				"checkpoint_id": cp.ID,
				"label":         cp.Label,
				"commit_id":     cp.CommitID,
				"reason":        strings.TrimSpace(opts.Reason),
				"error":         err.Error(),
			},
		)
		return err
	}

	s.appendUIEvent(ctx, convID, opts.MessageID, models.UIEventKindCheckpointRestored,
		restoreSucceededText(opts.Reason, cp.CommitID),
		map[string]any{
			"checkpoint_id":     cp.ID,
			"label":             cp.Label,
			"commit_id":         cp.CommitID,
			"reason":            strings.TrimSpace(opts.Reason),
			"consumed_by_undo":  strings.TrimSpace(opts.Reason) == "undo_latest",
			"restored_snapshot": true,
		},
	)
	return nil
}

func (s *Service) UndoLatest(ctx context.Context, ws *models.Workspace, convID models.ConversationID, opts RestoreOptions) (*models.Checkpoint, error) {
	if s == nil || s.store == nil {
		return nil, fmt.Errorf("checkpoint service requires store")
	}

	cp, err := s.store.Checkpoints().LatestByConversation(ctx, convID)
	if err != nil {
		return nil, err
	}

	restoreOpts := opts
	if strings.TrimSpace(restoreOpts.Reason) == "" {
		restoreOpts.Reason = "undo_latest"
	}
	if err := s.Restore(ctx, ws, convID, cp, restoreOpts); err != nil {
		return nil, err
	}

	backend, workspacePath, err := s.backendForWorkspace(ws)
	if err != nil {
		return nil, err
	}
	if err := s.store.Checkpoints().Delete(ctx, cp.ID); err != nil {
		log.Printf("[checkpoint] undo delete record id=%s conv=%s: %v", cp.ID, convID, err)
	}
	if err := backend.DeleteRef(ctx, workspacePath, cp.GitRef); err != nil {
		log.Printf("[checkpoint] undo delete ref=%s conv=%s: %v", cp.GitRef, convID, err)
	}
	return cp, nil
}

func (s *Service) Prune(ctx context.Context, ws *models.Workspace, convID models.ConversationID, keep int) error {
	if keep <= 0 {
		return nil
	}
	backend, workspacePath, err := s.backendForWorkspace(ws)
	if err != nil {
		return err
	}

	checkpoints, err := s.store.Checkpoints().ListByConversation(ctx, convID, keep+ListSlack)
	if err != nil {
		return err
	}
	if len(checkpoints) <= keep {
		return nil
	}

	for _, stale := range checkpoints[keep:] {
		if err := s.store.Checkpoints().Delete(ctx, stale.ID); err != nil {
			log.Printf("[checkpoint] delete stale record id=%s conv=%s: %v", stale.ID, convID, err)
		}
		if err := backend.DeleteRef(ctx, workspacePath, stale.GitRef); err != nil {
			log.Printf("[checkpoint] delete stale ref=%s conv=%s: %v", stale.GitRef, convID, err)
		}
	}
	return nil
}

func (s *Service) Get(ctx context.Context, checkpointID string) (*models.Checkpoint, error) {
	if s == nil || s.store == nil {
		return nil, fmt.Errorf("checkpoint service requires store")
	}
	return s.store.Checkpoints().Get(ctx, checkpointID)
}

func (s *Service) ReadFileAtCheckpoint(ctx context.Context, ws *models.Workspace, convID models.ConversationID, checkpointID string, relativePath string) ([]byte, *models.Checkpoint, error) {
	if s == nil || s.store == nil {
		return nil, nil, fmt.Errorf("checkpoint service requires store")
	}
	cp, err := s.store.Checkpoints().Get(ctx, checkpointID)
	if err != nil {
		return nil, nil, fmt.Errorf("checkpoint not found")
	}
	if cp.ConversationID != convID {
		return nil, nil, fmt.Errorf("checkpoint not found")
	}

	backend, workspacePath, err := s.backendForWorkspace(ws)
	if err != nil {
		return nil, nil, err
	}

	content, err := backend.ReadFileAtSnapshot(ctx, workspacePath, SnapshotFromCheckpoint(cp), relativePath)
	if err != nil {
		return nil, cp, err
	}
	return content, cp, nil
}

func (s *Service) backendForWorkspace(ws *models.Workspace) (Backend, string, error) {
	if s == nil || s.resolver == nil {
		return nil, "", fmt.Errorf("checkpoint backend resolver is not configured")
	}
	backend, err := s.resolver.Resolve(ws)
	if err != nil {
		return nil, "", err
	}
	workspacePath := WorkspacePath(ws)
	if workspacePath == "" {
		return nil, "", fmt.Errorf("workspace path is required")
	}
	return backend, workspacePath, nil
}

func (s *Service) appendUIEvent(ctx context.Context, convID models.ConversationID, messageID models.MessageID, kind models.UIEventKind, text string, metadata map[string]any) {
	if s == nil || s.store == nil {
		return
	}
	if err := s.store.UIEvents().Append(ctx, &models.UIEvent{
		ConversationID: convID,
		MessageID:      messageID,
		Kind:           kind,
		Text:           text,
		Metadata:       metadata,
	}); err != nil && !errors.Is(err, context.Canceled) && !errors.Is(err, context.DeadlineExceeded) {
		log.Printf("[checkpoint] append ui event conv=%s kind=%s: %v", convID, kind, err)
	}
}

func defaultLabel(label string, auto bool) string {
	trimmed := strings.TrimSpace(label)
	if trimmed != "" {
		return trimmed
	}
	if auto {
		return "auto checkpoint"
	}
	return "checkpoint"
}

func restoreSucceededText(reason string, commitID string) string {
	if strings.TrimSpace(reason) == "undo_latest" {
		return fmt.Sprintf("undo restored checkpoint (%s)", shortCommitID(commitID))
	}
	return fmt.Sprintf("restored checkpoint (%s)", shortCommitID(commitID))
}

func restoreFailedText(reason string, commitID string) string {
	if strings.TrimSpace(reason) == "undo_latest" {
		return fmt.Sprintf("undo failed to restore checkpoint (%s)", shortCommitID(commitID))
	}
	return fmt.Sprintf("checkpoint restore failed (%s)", shortCommitID(commitID))
}

func shortCommitID(commitID string) string {
	trimmed := strings.TrimSpace(commitID)
	if len(trimmed) <= 7 {
		return trimmed
	}
	return trimmed[:7]
}
