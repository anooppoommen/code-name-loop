package tools

import "loop/models"

func testWorkspace(root string) *models.Workspace {
	return &models.Workspace{
		CanonicalRootPath: root,
	}
}
