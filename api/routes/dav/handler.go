// Package dav implements the premium file-server mount endpoint: a minimal,
// deliberately restricted WebDAV server at /dav/:token, mountable as a
// network drive on Windows, macOS, Linux, iOS and Android.
//
// The mount supports full file management — upload (PUT, MKCOL), download
// (GET, HEAD, PROPFIND), DELETE, MOVE, COPY and PROPPATCH — under two
// invariants that are never relaxed:
//   - Nothing is ever executed server-side: file bytes are stored encrypted
//     in MinIO and only ever streamed back.
//   - No previews: every download is served as application/octet-stream with
//     Content-Disposition: attachment and X-Content-Type-Options: nosniff.
//
// The tree is scoped to the link's storage server: only files stored on that
// server's drives are visible or manageable, and uploads/copies are pinned
// to the owner's drive on that server.
//
// Every request must carry HTTP Basic credentials, which are verified against
// Keycloak (the user's normal login credentials). The link token alone grants
// nothing.
package dav

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
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"apollo-sfs.com/api/db"
	"apollo-sfs.com/api/models"
	"apollo-sfs.com/api/routes/services"
	"apollo-sfs.com/api/routes/sfs"
)

// maxUploadBytes caps a single PUT body. Host nginx enforces its own limit
// (client_max_body_size) in front of this.
const maxUploadBytes = 1 << 30 // 1 GiB

// Handler serves all /dav/:token requests.
type Handler struct {
	links *services.FileServerLinkService
	files *services.FileService
	pool  *db.Queries
}

// NewHandler wires a DAV handler.
func NewHandler(links *services.FileServerLinkService, files *services.FileService, pool *db.Queries) *Handler {
	return &Handler{links: links, files: files, pool: pool}
}

// Register mounts the DAV method handlers on the router. Gin has no helpers
// for WebDAV verbs, so each method is registered explicitly.
func (h *Handler) Register(r gin.IRouter, mw ...gin.HandlerFunc) {
	group := r.Group("/dav", mw...)
	for _, method := range []string{
		http.MethodOptions, http.MethodGet, http.MethodHead, http.MethodPut,
		http.MethodDelete, "PROPFIND", "PROPPATCH", "MKCOL", "MOVE", "COPY",
		"LOCK", "UNLOCK",
		// POST still needs a route so it gets a clean 403 instead of 404.
		http.MethodPost,
	} {
		group.Handle(method, "/:token", h.dispatch)
		group.Handle(method, "/:token/*path", h.dispatch)
	}
}

// dispatch authenticates the request and routes it by HTTP method.
func (h *Handler) dispatch(c *gin.Context) {
	switch c.Request.Method {
	case http.MethodOptions:
		// Answer OPTIONS before auth: Windows probes it pre-credentials.
		h.options(c)
		return
	case http.MethodPost:
		h.refuse(c)
		return
	}

	link, user, ok := h.authenticate(c)
	if !ok {
		return
	}

	switch c.Request.Method {
	case http.MethodGet, http.MethodHead:
		h.download(c, link, user)
	case http.MethodPut:
		h.upload(c, link, user)
	case http.MethodDelete:
		h.remove(c, link, user)
	case "MOVE":
		h.move(c, link, user)
	case "COPY":
		h.copyResource(c, link, user)
	case "PROPFIND":
		h.propfind(c, link)
	case "PROPPATCH":
		h.proppatch(c, link)
	case "MKCOL":
		h.mkcol(c, link)
	case "LOCK":
		h.lock(c)
	case "UNLOCK":
		c.Status(http.StatusNoContent)
	default:
		h.refuse(c)
	}
}

// allowedMethods is advertised on OPTIONS and refusals.
const allowedMethods = "OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, PROPPATCH, MKCOL, MOVE, COPY, LOCK, UNLOCK"

func (h *Handler) options(c *gin.Context) {
	c.Header("DAV", "1, 2")
	c.Header("MS-Author-Via", "DAV")
	c.Header("Allow", allowedMethods)
	c.Status(http.StatusOK)
}

func (h *Handler) refuse(c *gin.Context) {
	c.Header("Allow", allowedMethods)
	c.String(http.StatusForbidden, "method not supported on this file server")
	c.Abort()
}

// authenticate resolves the URL token to a link and verifies Basic
// credentials via Keycloak. Failures write the response themselves.
func (h *Handler) authenticate(c *gin.Context) (*models.FileServerLink, *models.User, bool) {
	link, err := h.links.ResolveToken(c.Request.Context(), c.Param("token"))
	if err != nil {
		if errors.Is(err, services.ErrLinkNotFound) {
			c.String(http.StatusNotFound, "not found")
		} else {
			c.String(http.StatusInternalServerError, "server error")
		}
		c.Abort()
		return nil, nil, false
	}

	username, password, hasAuth := c.Request.BasicAuth()
	if !hasAuth {
		h.challenge(c)
		return nil, nil, false
	}
	user, err := h.links.Authenticate(c.Request.Context(), link, username, password)
	if err != nil {
		switch {
		case errors.Is(err, services.ErrLinkNotPremium):
			c.String(http.StatusForbidden, "premium membership required")
			c.Abort()
		default:
			h.challenge(c)
		}
		return nil, nil, false
	}
	return link, user, true
}

func (h *Handler) challenge(c *gin.Context) {
	c.Header("WWW-Authenticate", `Basic realm="Apollo SFS file server"`)
	c.String(http.StatusUnauthorized, "authentication required")
	c.Abort()
}

// checkLocation enforces enhanced-security mode for transfer requests.
func (h *Handler) checkLocation(c *gin.Context, link *models.FileServerLink, user *models.User) bool {
	err := h.links.CheckLocation(c.Request.Context(), link, user, c.ClientIP())
	if err == nil {
		return true
	}
	if errors.Is(err, services.ErrLocationUnverified) {
		c.String(http.StatusForbidden,
			"location verification required — a verification link has been emailed to the account owner")
	} else {
		log.Printf("dav: check location: %v", err)
		c.String(http.StatusInternalServerError, "server error")
	}
	c.Abort()
	return false
}

// ── Path handling ─────────────────────────────────────────────────────────────

// splitPath turns the wildcard *path into validated segments. Rejects dot,
// dot-dot and control characters so a client can never escape the tree.
func splitPath(raw string) ([]string, error) {
	raw = strings.Trim(raw, "/")
	if raw == "" {
		return nil, nil
	}
	parts := strings.Split(raw, "/")
	segments := make([]string, 0, len(parts))
	for _, p := range parts {
		if p == "" {
			continue
		}
		if p == "." || p == ".." || len(p) > 255 {
			return nil, fmt.Errorf("invalid path segment %q", p)
		}
		for _, r := range p {
			if r < 0x20 || r == 0x7f {
				return nil, fmt.Errorf("invalid path segment %q", p)
			}
		}
		segments = append(segments, p)
	}
	return segments, nil
}

// hrefFor builds a URL-escaped href for a resource under the mount.
func hrefFor(token string, segments []string, isDir bool) string {
	var b strings.Builder
	b.WriteString("/dav/")
	b.WriteString(url.PathEscape(token))
	for _, s := range segments {
		b.WriteString("/")
		b.WriteString(url.PathEscape(s))
	}
	if isDir {
		b.WriteString("/")
	}
	return b.String()
}

// ── PROPFIND ──────────────────────────────────────────────────────────────────

// propfind lists a folder (Depth 0/1) or a single file. The tree is the
// user's folder hierarchy; files are filtered to the link's server.
func (h *Handler) propfind(c *gin.Context, link *models.FileServerLink) {
	segments, err := splitPath(c.Param("path"))
	if err != nil {
		c.String(http.StatusBadRequest, "bad path")
		return
	}
	depth := c.GetHeader("Depth")
	if depth == "" || depth == "infinity" {
		// RFC 4918 discourages infinite-depth listings; clamp to 1.
		depth = "1"
	}
	// Body (if any) is ignored — treated as allprop.
	_, _ = io.Copy(io.Discard, c.Request.Body)

	q, tx, err := h.pool.ForUser(c.Request.Context(), link.UserID)
	if err != nil {
		c.String(http.StatusInternalServerError, "server error")
		return
	}
	defer func() { _ = tx.Rollback() }()

	var buf bytes.Buffer
	buf.WriteString(xml.Header)
	buf.WriteString(`<D:multistatus xmlns:D="DAV:">`)

	folderID, folderErr := sfs.LookupFolderByPath(c.Request.Context(), q, link.UserID, segments)
	if folderErr == nil {
		// Collection: self entry + children when Depth is 1.
		name := link.ServerName
		if len(segments) > 0 {
			name = segments[len(segments)-1]
		}
		// Quota properties (RFC 4331) are only meaningful at the mount root —
		// clients like Windows Explorer and Finder query them there to show
		// drive capacity/free space. Without them, clients fall back to
		// reporting the underlying volume's raw size instead of this specific
		// drive's capacity and the user's usage on it.
		var quota *quotaInfo
		if len(segments) == 0 {
			quota, err = h.driveQuota(c, link)
			if err != nil {
				c.String(http.StatusInternalServerError, "server error")
				return
			}
		}
		writeCollectionResponse(&buf, hrefFor(link.Token, segments, true), name, link.CreatedAt, quota)
		if depth != "0" {
			folders, err := q.ListFolderChildren(c.Request.Context(), link.UserID, folderID)
			if err != nil {
				c.String(http.StatusInternalServerError, "server error")
				return
			}
			for _, f := range folders {
				writeCollectionResponse(&buf, hrefFor(link.Token, append(segments, f.Name), true), f.Name, f.UpdatedAt, nil)
			}
			files, err := q.ListFilesByFolderOnDrive(c.Request.Context(), link.UserID, folderID, link.DriveID)
			if err != nil {
				c.String(http.StatusInternalServerError, "server error")
				return
			}
			for i := range files {
				f := &files[i]
				writeFileResponse(&buf, hrefFor(link.Token, append(segments, f.Name), false), f.Name, f.SizeBytes, f.UpdatedAt)
			}
		}
	} else {
		// Not a folder — maybe a single file.
		file, ok := h.lookupFile(c, q, link, segments)
		if !ok {
			return
		}
		if file == nil {
			c.String(http.StatusNotFound, "not found")
			return
		}
		writeFileResponse(&buf, hrefFor(link.Token, segments, false), file.Name, file.SizeBytes, file.UpdatedAt)
	}

	buf.WriteString(`</D:multistatus>`)
	c.Header("Content-Type", `application/xml; charset="utf-8"`)
	c.String(http.StatusMultiStatus, buf.String())
}

// quotaInfo carries RFC 4331 quota properties for the mount root.
type quotaInfo struct {
	usedBytes      int64
	availableBytes int64
}

// driveQuota reports link.DriveID's physical capacity and the user's own
// bytes stored on it — the same per-drive figures shown on the storage page
// (GetUserDrives / "my-servers"), so a fast-tier mount and a standard-tier
// mount on the same server correctly report different capacities instead of
// both echoing one account-wide number.
func (h *Handler) driveQuota(c *gin.Context, link *models.FileServerLink) (*quotaInfo, error) {
	capacityBytes, usedBytes, err := h.pool.GetDriveCapacityAndUsage(c.Request.Context(), link.DriveID, link.UserID)
	if err != nil {
		return nil, err
	}
	available := capacityBytes - usedBytes
	if available < 0 {
		available = 0
	}
	return &quotaInfo{usedBytes: usedBytes, availableBytes: available}, nil
}

func writeCollectionResponse(buf *bytes.Buffer, href, name string, modified time.Time, quota *quotaInfo) {
	buf.WriteString(`<D:response><D:href>`)
	xmlEscape(buf, href)
	buf.WriteString(`</D:href><D:propstat><D:prop>`)
	buf.WriteString(`<D:resourcetype><D:collection/></D:resourcetype>`)
	buf.WriteString(`<D:displayname>`)
	xmlEscape(buf, name)
	buf.WriteString(`</D:displayname>`)
	buf.WriteString(`<D:getlastmodified>`)
	buf.WriteString(modified.UTC().Format(http.TimeFormat))
	buf.WriteString(`</D:getlastmodified>`)
	if quota != nil {
		fmt.Fprintf(buf, `<D:quota-used-bytes>%d</D:quota-used-bytes>`, quota.usedBytes)
		fmt.Fprintf(buf, `<D:quota-available-bytes>%d</D:quota-available-bytes>`, quota.availableBytes)
	}
	buf.WriteString(`</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`)
}

func writeFileResponse(buf *bytes.Buffer, href, name string, size int64, modified time.Time) {
	buf.WriteString(`<D:response><D:href>`)
	xmlEscape(buf, href)
	buf.WriteString(`</D:href><D:propstat><D:prop>`)
	buf.WriteString(`<D:resourcetype/>`)
	buf.WriteString(`<D:displayname>`)
	xmlEscape(buf, name)
	buf.WriteString(`</D:displayname>`)
	fmt.Fprintf(buf, `<D:getcontentlength>%d</D:getcontentlength>`, size)
	// Always an opaque byte stream: the mount never advertises a previewable
	// or executable type.
	buf.WriteString(`<D:getcontenttype>application/octet-stream</D:getcontenttype>`)
	buf.WriteString(`<D:getlastmodified>`)
	buf.WriteString(modified.UTC().Format(http.TimeFormat))
	buf.WriteString(`</D:getlastmodified>`)
	buf.WriteString(`</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`)
}

func xmlEscape(buf *bytes.Buffer, s string) {
	_ = xml.EscapeText(buf, []byte(s))
}

// lookupFile resolves segments to a file on the link's drive. Returns
// (nil, true) when the path cleanly does not exist; (nil, false) when a
// response has already been written.
func (h *Handler) lookupFile(c *gin.Context, q *db.Queries, link *models.FileServerLink, segments []string) (*models.File, bool) {
	if len(segments) == 0 {
		return nil, true
	}
	parentID, err := sfs.LookupFolderByPath(c.Request.Context(), q, link.UserID, segments[:len(segments)-1])
	if err != nil {
		return nil, true
	}
	file, err := q.FindFileByFolderAndName(c.Request.Context(), link.UserID, parentID, segments[len(segments)-1])
	if err != nil {
		return nil, true
	}
	// Drive scoping: the mount only exposes files stored on the link's drive
	// (not other drives/tiers on the same server).
	if file.DriveID == nil || *file.DriveID != link.DriveID {
		return nil, true
	}
	return file, true
}

// ── GET / HEAD ────────────────────────────────────────────────────────────────

func (h *Handler) download(c *gin.Context, link *models.FileServerLink, user *models.User) {
	segments, err := splitPath(c.Param("path"))
	if err != nil || len(segments) == 0 {
		c.String(http.StatusBadRequest, "bad path")
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
	file, ok := h.lookupFile(c, q, link, segments)
	_ = tx.Rollback()
	if !ok {
		return
	}
	if file == nil {
		c.String(http.StatusNotFound, "not found")
		return
	}

	// Downloads are opaque attachments: no content sniffing, no inline
	// rendering, no preview — and nothing server-side ever executes the bytes.
	c.Header("X-Content-Type-Options", "nosniff")
	c.Header("Content-Disposition", fmt.Sprintf("attachment; filename=%q", file.Name))
	c.Header("Cache-Control", "private, no-store")

	if c.Request.Method == http.MethodHead {
		c.Header("Content-Length", fmt.Sprintf("%d", file.SizeBytes))
		c.Header("Content-Type", "application/octet-stream")
		c.Status(http.StatusOK)
		return
	}

	var plaintext []byte
	if services.IsChunked(file) {
		plaintext, err = h.files.DownloadChunked(c.Request.Context(), file, link.Username)
	} else {
		_, plaintext, err = h.files.Download(c.Request.Context(), file.ID, link.UserID, link.Username)
	}
	if err != nil {
		log.Printf("dav: download %s: %v", file.ID, err)
		c.String(http.StatusInternalServerError, "download failed")
		return
	}
	h.links.Touch(c.Request.Context(), link.ID)
	h.audit(c, link, "dav.download", strings.Join(segments, "/"))
	c.Data(http.StatusOK, "application/octet-stream", plaintext)
}

// ── PUT ───────────────────────────────────────────────────────────────────────

func (h *Handler) upload(c *gin.Context, link *models.FileServerLink, user *models.User) {
	segments, err := splitPath(c.Param("path"))
	if err != nil || len(segments) == 0 {
		c.String(http.StatusBadRequest, "bad path")
		return
	}
	if !h.checkLocation(c, link, user) {
		return
	}
	if c.Request.ContentLength > maxUploadBytes {
		c.String(http.StatusRequestEntityTooLarge, "file too large")
		return
	}

	leaf := segments[len(segments)-1]
	parents := segments[:len(segments)-1]

	// Resolve (and create) the destination folder chain in its own tx.
	q, tx, err := h.pool.ForUser(c.Request.Context(), link.UserID)
	if err != nil {
		c.String(http.StatusInternalServerError, "server error")
		return
	}
	folderID, err := sfs.ResolvePath(c.Request.Context(), q, link.UserID, parents, true)
	if err != nil {
		_ = tx.Rollback()
		c.String(http.StatusConflict, "cannot create destination folder")
		return
	}
	// PUT replaces an existing file (standard WebDAV semantics), but only when
	// the existing file is manageable through this mount — i.e. stored on the
	// link's drive. Same-named files on other drives/tiers stay untouchable.
	var existing *models.File
	if found, err := q.FindFileByFolderAndName(c.Request.Context(), link.UserID, folderID, leaf); err == nil && found != nil {
		if found.DriveID == nil || *found.DriveID != link.DriveID {
			_ = tx.Rollback()
			c.String(http.StatusForbidden, "a file with this name exists on a different storage server")
			return
		}
		existing = found
	}
	if err := tx.Commit(); err != nil {
		c.String(http.StatusInternalServerError, "server error")
		return
	}
	if existing != nil {
		if err := h.files.Delete(c.Request.Context(), existing.ID, link.UserID, link.Username); err != nil {
			log.Printf("dav: put overwrite delete %s: %v", existing.ID, err)
			c.String(http.StatusInternalServerError, "upload failed")
			return
		}
	}

	driveID := link.DriveID
	file, err := h.files.Upload(c.Request.Context(), services.UploadInput{
		Username:       link.Username,
		UserID:         link.UserID,
		FolderID:       folderID,
		Name:           leaf,
		IgnoreRedirect: true,
		Source:         "web",
		Reader:         http.MaxBytesReader(c.Writer, c.Request.Body, maxUploadBytes),
		RequireDriveID: &driveID,
	})
	if err != nil {
		switch {
		case errors.Is(err, services.ErrQuotaExceeded):
			c.String(http.StatusInsufficientStorage, "storage quota exceeded")
		case errors.Is(err, services.ErrDriveUnavailable):
			c.String(http.StatusInsufficientStorage, "the storage server has no room for this file")
		case errors.Is(err, services.ErrDuplicateName):
			// Raced with a concurrent upload of the same name.
			c.String(http.StatusConflict, "a file with this name was just created — retry to overwrite")
		default:
			log.Printf("dav: upload %q: %v", leaf, err)
			c.String(http.StatusInternalServerError, "upload failed")
		}
		return
	}
	h.links.Touch(c.Request.Context(), link.ID)
	h.audit(c, link, "dav.upload", strings.Join(segments, "/"))
	_ = file
	if existing != nil {
		c.Status(http.StatusNoContent) // replaced
	} else {
		c.Status(http.StatusCreated)
	}
}

// ── MKCOL ─────────────────────────────────────────────────────────────────────

func (h *Handler) mkcol(c *gin.Context, link *models.FileServerLink) {
	segments, err := splitPath(c.Param("path"))
	if err != nil || len(segments) == 0 {
		c.String(http.StatusBadRequest, "bad path")
		return
	}
	q, tx, err := h.pool.ForUser(c.Request.Context(), link.UserID)
	if err != nil {
		c.String(http.StatusInternalServerError, "server error")
		return
	}
	defer func() { _ = tx.Rollback() }()

	// RFC 4918: the parent must already exist (409 otherwise) and the target
	// must not (405 when it does).
	parentID, err := sfs.LookupFolderByPath(c.Request.Context(), q, link.UserID, segments[:len(segments)-1])
	if err != nil {
		c.String(http.StatusConflict, "parent folder does not exist")
		return
	}
	name := segments[len(segments)-1]
	if _, err := q.FindFolderByParentAndName(c.Request.Context(), link.UserID, parentID, name); err == nil {
		c.String(http.StatusMethodNotAllowed, "folder already exists")
		return
	}
	if _, err := q.CreateFolder(c.Request.Context(), &models.Folder{
		UserID:   link.UserID,
		ParentID: parentID,
		Name:     name,
		Kind:     models.FolderKindRegular,
	}); err != nil {
		c.String(http.StatusInternalServerError, "create folder failed")
		return
	}
	if err := tx.Commit(); err != nil {
		c.String(http.StatusInternalServerError, "server error")
		return
	}
	c.Status(http.StatusCreated)
}

// ── LOCK / UNLOCK ─────────────────────────────────────────────────────────────

// lock returns a fake shared lock. Windows Explorer and macOS Finder refuse
// to write to a class-2 server that denies LOCK, so we hand out a token
// without any real locking semantics (uploads are create-only, so there is
// nothing to protect).
func (h *Handler) lock(c *gin.Context) {
	_, _ = io.Copy(io.Discard, c.Request.Body)
	token := "opaquelocktoken:" + uuid.NewString()
	var buf bytes.Buffer
	buf.WriteString(xml.Header)
	buf.WriteString(`<D:prop xmlns:D="DAV:"><D:lockdiscovery><D:activelock>`)
	buf.WriteString(`<D:locktype><D:write/></D:locktype>`)
	buf.WriteString(`<D:lockscope><D:exclusive/></D:lockscope>`)
	buf.WriteString(`<D:depth>0</D:depth>`)
	buf.WriteString(`<D:timeout>Second-600</D:timeout>`)
	buf.WriteString(`<D:locktoken><D:href>`)
	buf.WriteString(token)
	buf.WriteString(`</D:href></D:locktoken>`)
	buf.WriteString(`</D:activelock></D:lockdiscovery></D:prop>`)
	c.Header("Lock-Token", "<"+token+">")
	c.Header("Content-Type", `application/xml; charset="utf-8"`)
	c.String(http.StatusOK, buf.String())
}

// ── Audit ─────────────────────────────────────────────────────────────────────

func (h *Handler) audit(c *gin.Context, link *models.FileServerLink, action, path string) {
	resourceType := "file_server_link"
	resourceID := link.ID
	resourceName := path
	if err := h.pool.InsertAuditLog(c.Request.Context(), db.AuditInput{
		TargetUsername: link.Username,
		ActorUsername:  link.Username,
		Action:         action,
		ResourceType:   &resourceType,
		ResourceID:     &resourceID,
		ResourceName:   &resourceName,
	}); err != nil {
		log.Printf("dav audit %q: %v", action, err)
	}
}
