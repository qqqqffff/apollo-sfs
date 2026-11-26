package tests

import (
	"bytes"
	"context"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/google/uuid"

	"apollo-sfs.com/api/db"
	"apollo-sfs.com/api/models"
	"apollo-sfs.com/api/routes"
)

// auditCapture is a stubQuerier that hands audit rows to the test.
type auditCapture struct {
	stubQuerier
	rows chan db.AuditInput
}

func (a *auditCapture) InsertAuditLog(_ context.Context, in db.AuditInput) error {
	a.rows <- in
	return nil
}

func (a *auditCapture) next(t *testing.T) (db.AuditInput, models.OperationAuditDetails) {
	t.Helper()
	select {
	case in := <-a.rows:
		var d models.OperationAuditDetails
		if err := json.Unmarshal(in.Details, &d); err != nil {
			t.Fatalf("details %q: %v", in.Details, err)
		}
		return in, d
	case <-time.After(2 * time.Second):
		t.Fatal("no audit row written")
		return db.AuditInput{}, models.OperationAuditDetails{}
	}
}

func auditedFileRouter(fs routes.FileServicer) (*auditCapture, *routesEngine) {
	q := &auditCapture{rows: make(chan db.AuditInput, 4)}
	h := routes.NewHandler(q, fs, nil, nil, nil, nil, nil, nil, nil, "x")
	r := newEngine()
	ginContext(r, uuid.NewString(), "zoe", false)
	r.POST("/files/upload", h.UploadFile)
	r.PATCH("/files/:file_id", h.UpdateFile)
	r.PATCH("/files/:file_id/move", h.MoveFile)
	r.DELETE("/files/:file_id", h.DeleteFile)
	return q, &routesEngine{r}
}

type routesEngine struct{ http.Handler }

func (e *routesEngine) do(method, path string, body *bytes.Buffer, contentType string) int {
	if body == nil {
		body = &bytes.Buffer{}
	}
	req := httptest.NewRequest(method, path, body)
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	return doRequest(e.Handler, req).Code
}

func TestUploadAuditRecordsSizeDurationAndSpeed(t *testing.T) {
	file := sampleFile()
	file.SizeBytes = 64 * 1024
	q, r := auditedFileRouter(&stubFileService{file: file})

	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	part, _ := mw.CreateFormFile("file", "test.txt")
	_, _ = part.Write(bytes.Repeat([]byte("x"), int(file.SizeBytes)))
	_ = mw.Close()

	if code := r.do(http.MethodPost, "/files/upload", &body, mw.FormDataContentType()); code != http.StatusCreated {
		t.Fatalf("status %d", code)
	}
	in, d := q.next(t)
	if in.Action != "file_uploaded" || d.SizeBytes != file.SizeBytes {
		t.Fatalf("row %s details %+v", in.Action, d)
	}
	if d.TransferMS <= 0 || d.AvgSpeedBps <= 0 || d.DurationMS < d.TransferMS {
		t.Errorf("timing not recorded sensibly: %+v", d)
	}
}

func TestRenameMoveDeleteAuditsCarryDuration(t *testing.T) {
	file := sampleFile()
	q, r := auditedFileRouter(&stubFileService{file: file})
	id := file.ID.String()

	if code := r.do(http.MethodPatch, "/files/"+id, bytes.NewBufferString(`{"name":"new.txt"}`), "application/json"); code != 200 {
		t.Fatalf("rename status %d", code)
	}
	in, d := q.next(t)
	if in.Action != "file_renamed" || d.PreviousName != "test.txt" || d.DurationMS < 0 {
		t.Errorf("rename: %s %+v", in.Action, d)
	}

	dest := uuid.NewString()
	if code := r.do(http.MethodPatch, "/files/"+id+"/move", bytes.NewBufferString(`{"folder_id":"`+dest+`"}`), "application/json"); code != 200 {
		t.Fatalf("move status %d", code)
	}
	in, d = q.next(t)
	if in.Action != "file_moved" || d.Destination != dest {
		t.Errorf("move: %s %+v", in.Action, d)
	}

	if code := r.do(http.MethodDelete, "/files/"+id, nil, ""); code != 200 {
		t.Fatalf("delete status %d", code)
	}
	in, _ = q.next(t)
	if in.Action != "file_deleted" || len(in.Details) == 0 {
		t.Errorf("delete: %s %s", in.Action, in.Details)
	}
}
