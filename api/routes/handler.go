package routes

import (
	"apollo-sfs.com/api/db"
	"apollo-sfs.com/api/routes/services"
)

// Handler holds shared dependencies for route handlers in the routes package.
// Methods on Handler implement the individual endpoint logic.
// Sub-packages (auth, admin) define their own equivalent structs.
type Handler struct {
	queries *db.Queries
	files   *services.FileService
	folders *services.FolderService
	invites *services.InviteService
}

// NewHandler constructs a Handler with the given dependencies.
func NewHandler(q *db.Queries, fileSvc *services.FileService, folderSvc *services.FolderService, inviteSvc *services.InviteService) *Handler {
	return &Handler{queries: q, files: fileSvc, folders: folderSvc, invites: inviteSvc}
}
