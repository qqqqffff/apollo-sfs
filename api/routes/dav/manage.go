package dav

// Management verbs: DELETE, MOVE, COPY and PROPPATCH. These give the mount
// full file-management control. The two invariants that are never relaxed
// live in download()/writeFileResponse(): user files are only ever served as
// opaque octet-stream attachments (no previews) and are never executed
// server-side — management verbs only touch metadata rows and MinIO blobs.
//
// All management operations stay scoped to the link's drive: only files
// stored on it can be deleted, moved, copied or overwritten — not other
// drives/tiers on the same server. Folders are part of the user's global
// tree, so folder renames/moves apply globally, and a folder DELETE removes
// only the files visible through this mount — folders that still hold
// out-of-scope files survive.

import (
	"bytes"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"apollo-sfs.com/api/db"
	"apollo-sfs.com/api/models"
	"apollo-sfs.com/api/routes/services"
	"apollo-sfs.com/api/routes/sfs"
)

// maxSubtreeEntries caps how many folders/files a recursive DELETE walks,
// guarding against runaway trees in a single request.
const maxSubtreeEntries = 10000

// errDestOutsideMount marks a Destination that points at a different mount
// (or another host path entirely) — reported as 502 per RFC 4918 §9.9.4.
var errDestOutsideMount = errors.New("destination must be inside this mount")

// parseDestination extracts and validates the Destination header of a
// MOVE/COPY: it must target the same mount (same token) and yields the
// destination path segments.
func parseDestination(dest, token string) ([]string, error) {
	if dest == "" {
		return nil, fmt.Errorf("missing Destination header")
	}
	u, err := url.Parse(dest)
	if err != nil {
		return nil, fmt.Errorf("invalid Destination header")
	}
	prefix := "/dav/" + token
	rest, ok := strings.CutPrefix(u.Path, prefix)
	if !ok || (rest != "" && !strings.HasPrefix(rest, "/")) {
		return nil, errDestOutsideMount
	}
	segments, err := splitPath(rest)
	if err != nil {
		return nil, err
	}
	if len(segments) == 0 {
		return nil, fmt.Errorf("destination must not be the mount root")
	}
	return segments, nil
}

// destinationStatus maps a parseDestination error to its HTTP status.
func destinationStatus(err error) int {
	if errors.Is(err, errDestOutsideMount) {
		return http.StatusBadGateway
	}
	return http.StatusBadRequest
}

// overwriteAllowed reads the WebDAV Overwrite header (default T per RFC 4918).
func overwriteAllowed(c *gin.Context) bool {
	return !strings.EqualFold(c.GetHeader("Overwrite"), "F")
}

// ── DELETE ────────────────────────────────────────────────────────────────────

// remove deletes a file, or a folder subtree. For folders, every file on the
// link's drive inside the subtree is deleted; folders are then removed
// bottom-up when empty. Folders still holding files that live on other
// drives/tiers (invisible through this mount) are kept.
func (h *Handler) remove(c *gin.Context, link *models.FileServerLink, user *models.User) {
	segments, err := splitPath(c.Param("path"))
	if err != nil {
		c.String(http.StatusBadRequest, "bad path")
		return
	}
	if len(segments) == 0 {
		c.String(http.StatusForbidden, "cannot delete the mount root")
		return
	}
	if !h.checkLocation(c, link, user) {
		return
	}

	q, tx, err := h.pool.ForUser(c.Request.Context(), link.UserID)
	if err != nil {
		c.String(http.StatusInternalServerError, "server error")
		return
	}

	// A file wins over a same-named folder, mirroring lookup order elsewhere.
	file, ok := h.lookupFile(c, q, link, segments)
	if !ok {
		_ = tx.Rollback()
		return
	}
	if file != nil {
		_ = tx.Rollback()
		if err := h.files.Delete(c.Request.Context(), file.ID, link.UserID, link.Username); err != nil {
			log.Printf("dav: delete %s: %v", file.ID, err)
			c.String(http.StatusInternalServerError, "delete failed")
			return
		}
		h.links.Touch(c.Request.Context(), link.ID)
		h.audit(c, link, "dav.delete", strings.Join(segments, "/"))
		c.Status(http.StatusNoContent)
		return
	}

	folderID, err := sfs.LookupFolderByPath(c.Request.Context(), q, link.UserID, segments)
	if err != nil || folderID == nil {
		_ = tx.Rollback()
		c.String(http.StatusNotFound, "not found")
		return
	}
	folderOrder, fileIDs, err := h.collectSubtree(c, q, link, *folderID)
	_ = tx.Rollback()
	if err != nil {
		c.String(http.StatusInsufficientStorage, err.Error())
		return
	}

	// Delete scoped files first — each call handles its own transaction,
	// MinIO blob removal and storage accounting.
	for _, id := range fileIDs {
		if err := h.files.Delete(c.Request.Context(), id, link.UserID, link.Username); err != nil {
			log.Printf("dav: delete subtree file %s: %v", id, err)
			c.String(http.StatusInternalServerError, "delete failed")
			return
		}
	}

	// Then remove folders bottom-up, skipping any that still hold content
	// (subfolders kept alive by files on other servers).
	q2, tx2, err := h.pool.ForUser(c.Request.Context(), link.UserID)
	if err != nil {
		c.String(http.StatusInternalServerError, "server error")
		return
	}
	defer func() { _ = tx2.Rollback() }()
	for i := len(folderOrder) - 1; i >= 0; i-- {
		id := folderOrder[i]
		hasChildren, err := q2.HasFolderChildren(c.Request.Context(), id)
		if err != nil {
			c.String(http.StatusInternalServerError, "delete failed")
			return
		}
		if hasChildren {
			continue
		}
		if err := q2.DeleteFolder(c.Request.Context(), id); err != nil {
			c.String(http.StatusInternalServerError, "delete failed")
			return
		}
	}
	if err := tx2.Commit(); err != nil {
		c.String(http.StatusInternalServerError, "server error")
		return
	}
	h.links.Touch(c.Request.Context(), link.ID)
	h.audit(c, link, "dav.delete", strings.Join(segments, "/"))
	c.Status(http.StatusNoContent)
}

// collectSubtree walks the folder subtree rooted at rootID (inclusive) in
// DFS pre-order, returning the folder ids visited and the ids of every file
// on the link's drive inside it.
func (h *Handler) collectSubtree(c *gin.Context, q *db.Queries, link *models.FileServerLink, rootID uuid.UUID) ([]uuid.UUID, []uuid.UUID, error) {
	var folders, files []uuid.UUID
	stack := []uuid.UUID{rootID}
	for len(stack) > 0 {
		id := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		folders = append(folders, id)

		fid := id
		children, err := q.ListFolderChildren(c.Request.Context(), link.UserID, &fid)
		if err != nil {
			return nil, nil, fmt.Errorf("delete failed")
		}
		for _, child := range children {
			stack = append(stack, child.ID)
		}
		scoped, err := q.ListFilesByFolderOnDrive(c.Request.Context(), link.UserID, &fid, link.DriveID)
		if err != nil {
			return nil, nil, fmt.Errorf("delete failed")
		}
		for i := range scoped {
			files = append(files, scoped[i].ID)
		}
		if len(folders)+len(files) > maxSubtreeEntries {
			return nil, nil, fmt.Errorf("folder is too large to delete in one operation")
		}
	}
	return folders, files, nil
}

// ── MOVE ──────────────────────────────────────────────────────────────────────

// move renames/relocates a file or folder within the mount. File moves are
// scoped to the link's drive; folder moves re-parent the folder in the
// user's global tree (metadata only — no bytes are touched).
func (h *Handler) move(c *gin.Context, link *models.FileServerLink, user *models.User) {
	src, err := splitPath(c.Param("path"))
	if err != nil || len(src) == 0 {
		c.String(http.StatusBadRequest, "bad path")
		return
	}
	dst, err := parseDestination(c.GetHeader("Destination"), link.Token)
	if err != nil {
		c.String(destinationStatus(err), err.Error())
		return
	}
	if !h.checkLocation(c, link, user) {
		return
	}
	overwrite := overwriteAllowed(c)
	dstLeaf := dst[len(dst)-1]

	q, tx, err := h.pool.ForUser(c.Request.Context(), link.UserID)
	if err != nil {
		c.String(http.StatusInternalServerError, "server error")
		return
	}

	file, ok := h.lookupFile(c, q, link, src)
	if !ok {
		_ = tx.Rollback()
		return
	}

	if file != nil {
		dstParent, existing, status, msg := h.resolveFileDestination(c, q, link, dst, file.ID, overwrite)
		_ = tx.Rollback()
		if status != 0 {
			c.String(status, msg)
			return
		}
		created := existing == nil
		if existing != nil {
			if err := h.files.Delete(c.Request.Context(), existing.ID, link.UserID, link.Username); err != nil {
				log.Printf("dav: move overwrite delete %s: %v", existing.ID, err)
				c.String(http.StatusInternalServerError, "move failed")
				return
			}
		}
		if !h.relocateFile(c, link, file, dstParent, dstLeaf) {
			return
		}
		h.links.Touch(c.Request.Context(), link.ID)
		h.audit(c, link, "dav.move", strings.Join(src, "/")+" -> "+strings.Join(dst, "/"))
		if created {
			c.Status(http.StatusCreated)
		} else {
			c.Status(http.StatusNoContent)
		}
		return
	}

	// Folder move / rename.
	defer func() { _ = tx.Rollback() }()
	folderID, err := sfs.LookupFolderByPath(c.Request.Context(), q, link.UserID, src)
	if err != nil || folderID == nil {
		c.String(http.StatusNotFound, "not found")
		return
	}
	dstParent, err := sfs.LookupFolderByPath(c.Request.Context(), q, link.UserID, dst[:len(dst)-1])
	if err != nil {
		c.String(http.StatusConflict, "destination parent folder does not exist")
		return
	}
	if dstParent != nil {
		cycle, err := q.FolderWouldCreateCycle(c.Request.Context(), *folderID, *dstParent)
		if err != nil {
			c.String(http.StatusInternalServerError, "move failed")
			return
		}
		if cycle {
			c.String(http.StatusConflict, "cannot move a folder into itself or one of its subfolders")
			return
		}
	}
	// Existing folder or file at the destination: folder overwrite is never
	// performed (it would be a hidden recursive delete).
	if existingFolder, err := q.FindFolderByParentAndName(c.Request.Context(), link.UserID, dstParent, dstLeaf); err == nil && existingFolder.ID != *folderID {
		c.String(http.StatusPreconditionFailed, "destination already exists")
		return
	}
	if _, err := q.FindFileByFolderAndName(c.Request.Context(), link.UserID, dstParent, dstLeaf); err == nil {
		c.String(http.StatusPreconditionFailed, "destination already exists")
		return
	}
	if src[len(src)-1] != dstLeaf {
		if _, err := q.UpdateFolderName(c.Request.Context(), *folderID, dstLeaf); err != nil {
			c.String(http.StatusConflict, "rename failed")
			return
		}
	}
	if _, err := q.UpdateFolderParent(c.Request.Context(), *folderID, dstParent); err != nil {
		c.String(http.StatusConflict, "move failed")
		return
	}
	if err := tx.Commit(); err != nil {
		c.String(http.StatusInternalServerError, "server error")
		return
	}
	h.links.Touch(c.Request.Context(), link.ID)
	h.audit(c, link, "dav.move", strings.Join(src, "/")+" -> "+strings.Join(dst, "/"))
	c.Status(http.StatusCreated)
}

// resolveFileDestination validates the destination of a file MOVE/COPY inside
// the supplied transaction. Returns the destination parent folder, the
// existing file to overwrite (nil when none), and a non-zero HTTP status +
// message when the operation must stop.
func (h *Handler) resolveFileDestination(c *gin.Context, q *db.Queries, link *models.FileServerLink, dst []string, srcFileID uuid.UUID, overwrite bool) (*uuid.UUID, *models.File, int, string) {
	dstParent, err := sfs.LookupFolderByPath(c.Request.Context(), q, link.UserID, dst[:len(dst)-1])
	if err != nil {
		return nil, nil, http.StatusConflict, "destination parent folder does not exist"
	}
	if _, err := q.FindFolderByParentAndName(c.Request.Context(), link.UserID, dstParent, dst[len(dst)-1]); err == nil {
		return nil, nil, http.StatusPreconditionFailed, "destination is a folder"
	}
	existing, err := q.FindFileByFolderAndName(c.Request.Context(), link.UserID, dstParent, dst[len(dst)-1])
	if err != nil {
		return dstParent, nil, 0, "" // clean destination
	}
	if existing.ID == srcFileID {
		// MOVE onto itself is a no-op; COPY onto itself is refused upstream.
		return dstParent, nil, http.StatusForbidden, "source and destination are the same file"
	}
	if !overwrite {
		return nil, nil, http.StatusPreconditionFailed, "destination already exists"
	}
	// Overwriting deletes the destination — only allowed when it is
	// manageable through this mount (stored on the link's drive).
	if existing.DriveID == nil || *existing.DriveID != link.DriveID {
		return nil, nil, http.StatusForbidden, "destination belongs to a different storage server"
	}
	return dstParent, existing, 0, ""
}

// relocateFile renames and re-parents a file row in a fresh transaction.
func (h *Handler) relocateFile(c *gin.Context, link *models.FileServerLink, file *models.File, dstParent *uuid.UUID, dstLeaf string) bool {
	q, tx, err := h.pool.ForUser(c.Request.Context(), link.UserID)
	if err != nil {
		c.String(http.StatusInternalServerError, "server error")
		return false
	}
	defer func() { _ = tx.Rollback() }()
	if file.Name != dstLeaf {
		if _, err := q.UpdateFileName(c.Request.Context(), file.ID, dstLeaf); err != nil {
			c.String(http.StatusConflict, "rename failed")
			return false
		}
	}
	if dstParent != nil {
		if _, err := q.MoveFile(c.Request.Context(), file.ID, *dstParent); err != nil {
			c.String(http.StatusConflict, "move failed")
			return false
		}
	} else {
		if _, err := q.MoveFileToRoot(c.Request.Context(), file.ID); err != nil {
			c.String(http.StatusConflict, "move failed")
			return false
		}
	}
	if err := tx.Commit(); err != nil {
		c.String(http.StatusInternalServerError, "server error")
		return false
	}
	return true
}

// ── COPY ──────────────────────────────────────────────────────────────────────

// copyResource duplicates a single file within the mount: the blob is
// decrypted, re-encrypted and stored as a new object pinned to the link's
// server. Folder (collection) copies are refused — copy the contents
// client-side instead.
func (h *Handler) copyResource(c *gin.Context, link *models.FileServerLink, user *models.User) {
	src, err := splitPath(c.Param("path"))
	if err != nil || len(src) == 0 {
		c.String(http.StatusBadRequest, "bad path")
		return
	}
	dst, err := parseDestination(c.GetHeader("Destination"), link.Token)
	if err != nil {
		c.String(destinationStatus(err), err.Error())
		return
	}
	if !h.checkLocation(c, link, user) {
		return
	}
	overwrite := overwriteAllowed(c)

	q, tx, err := h.pool.ForUser(c.Request.Context(), link.UserID)
	if err != nil {
		c.String(http.StatusInternalServerError, "server error")
		return
	}
	file, ok := h.lookupFile(c, q, link, src)
	if !ok {
		_ = tx.Rollback()
		return
	}
	if file == nil {
		// Copying folders would silently duplicate arbitrary amounts of data
		// server-side; refuse and let the client copy file-by-file.
		if folderID, err := sfs.LookupFolderByPath(c.Request.Context(), q, link.UserID, src); err == nil && folderID != nil {
			_ = tx.Rollback()
			c.String(http.StatusForbidden, "folder copy is not supported — copy the files inside it instead")
			return
		}
		_ = tx.Rollback()
		c.String(http.StatusNotFound, "not found")
		return
	}
	dstParent, existing, status, msg := h.resolveFileDestination(c, q, link, dst, file.ID, overwrite)
	_ = tx.Rollback()
	if status != 0 {
		c.String(status, msg)
		return
	}

	var plaintext []byte
	if services.IsChunked(file) {
		plaintext, err = h.files.DownloadChunked(c.Request.Context(), file, link.Username)
	} else {
		_, plaintext, err = h.files.Download(c.Request.Context(), file.ID, link.UserID, link.Username)
	}
	if err != nil {
		log.Printf("dav: copy read %s: %v", file.ID, err)
		c.String(http.StatusInternalServerError, "copy failed")
		return
	}

	created := existing == nil
	if existing != nil {
		if err := h.files.Delete(c.Request.Context(), existing.ID, link.UserID, link.Username); err != nil {
			log.Printf("dav: copy overwrite delete %s: %v", existing.ID, err)
			c.String(http.StatusInternalServerError, "copy failed")
			return
		}
	}
	driveID := link.DriveID
	if _, err := h.files.Upload(c.Request.Context(), services.UploadInput{
		Username:       link.Username,
		UserID:         link.UserID,
		FolderID:       dstParent,
		Name:           dst[len(dst)-1],
		IgnoreRedirect: true,
		Source:         "file_server",
		Reader:         bytes.NewReader(plaintext),
		RequireDriveID: &driveID,
	}); err != nil {
		switch {
		case errors.Is(err, services.ErrQuotaExceeded):
			c.String(http.StatusInsufficientStorage, "storage quota exceeded")
		case errors.Is(err, services.ErrDriveUnavailable):
			c.String(http.StatusInsufficientStorage, "the storage server has no room for this file")
		default:
			log.Printf("dav: copy write %q: %v", dst[len(dst)-1], err)
			c.String(http.StatusInternalServerError, "copy failed")
		}
		return
	}
	h.links.Touch(c.Request.Context(), link.ID)
	h.audit(c, link, "dav.copy", strings.Join(src, "/")+" -> "+strings.Join(dst, "/"))
	if created {
		c.Status(http.StatusCreated)
	} else {
		c.Status(http.StatusNoContent)
	}
}

// ── PROPPATCH ─────────────────────────────────────────────────────────────────

// proppatch accepts property updates and reports success without persisting
// anything. Clients (notably Windows Explorer) PROPPATCH timestamps and
// Win32 attributes after every upload; there is nowhere to store dead-letter
// properties, and failing the call makes those clients mark transfers as
// failed. The resource must exist.
func (h *Handler) proppatch(c *gin.Context, link *models.FileServerLink) {
	segments, err := splitPath(c.Param("path"))
	if err != nil {
		c.String(http.StatusBadRequest, "bad path")
		return
	}

	q, tx, err := h.pool.ForUser(c.Request.Context(), link.UserID)
	if err != nil {
		c.String(http.StatusInternalServerError, "server error")
		return
	}
	exists := false
	isDir := false
	if _, lookupErr := sfs.LookupFolderByPath(c.Request.Context(), q, link.UserID, segments); lookupErr == nil {
		exists, isDir = true, true
	} else if file, ok := h.lookupFile(c, q, link, segments); ok && file != nil {
		exists = true
	} else if !ok {
		_ = tx.Rollback()
		return
	}
	_ = tx.Rollback()
	if !exists {
		c.String(http.StatusNotFound, "not found")
		return
	}

	props := parseProppatchProps(c.Request.Body)

	var buf bytes.Buffer
	buf.WriteString(xml.Header)
	buf.WriteString(`<D:multistatus xmlns:D="DAV:"><D:response><D:href>`)
	xmlEscape(&buf, hrefFor(link.Token, segments, isDir))
	buf.WriteString(`</D:href><D:propstat><D:prop>`)
	for _, p := range props {
		buf.WriteString(`<`)
		buf.WriteString(p.local)
		if p.space != "" {
			buf.WriteString(` xmlns="`)
			xmlEscape(&buf, p.space)
			buf.WriteString(`"`)
		}
		buf.WriteString(`/>`)
	}
	buf.WriteString(`</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response></D:multistatus>`)
	c.Header("Content-Type", `application/xml; charset="utf-8"`)
	c.String(http.StatusMultiStatus, buf.String())
}

type propName struct {
	space string
	local string
}

// parseProppatchProps best-effort extracts the property names inside
// <set>/<remove> <prop> blocks so the 207 response can echo them. Malformed
// bodies yield an empty list — the response is then a bare 200 propstat.
func parseProppatchProps(body io.Reader) []propName {
	dec := xml.NewDecoder(io.LimitReader(body, 1<<20))
	var props []propName
	depthInProp := 0
	for {
		tok, err := dec.Token()
		if err != nil {
			break
		}
		switch t := tok.(type) {
		case xml.StartElement:
			if depthInProp > 0 {
				if depthInProp == 1 && len(props) < 64 {
					// XML names are echoed verbatim into the response; keep
					// only sane ones to avoid reflected markup.
					if isSimpleXMLName(t.Name.Local) {
						props = append(props, propName{space: t.Name.Space, local: t.Name.Local})
					}
				}
				depthInProp++
			} else if t.Name.Space == "DAV:" && t.Name.Local == "prop" {
				depthInProp = 1
			}
		case xml.EndElement:
			if depthInProp > 0 {
				depthInProp--
			}
		}
	}
	return props
}

// isSimpleXMLName accepts conservative XML element names (letters, digits,
// '-', '_', '.', not starting with a digit or punctuation).
func isSimpleXMLName(s string) bool {
	if s == "" || len(s) > 128 {
		return false
	}
	for i, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z':
		case i > 0 && (r >= '0' && r <= '9' || r == '-' || r == '_' || r == '.'):
		default:
			return false
		}
	}
	return true
}
