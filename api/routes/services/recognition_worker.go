package services

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"fmt"
	"image"
	"image/jpeg"
	"log"
	"strings"
	"sync"
	"time"

	// Register decoders for the formats the Go-side cropper supports. Files
	// in other formats (HEIC, WebP) still index fine — they just skip the
	// stored crop and fall back to the file preview as the group cover.
	_ "image/gif"
	_ "image/png"

	"github.com/google/uuid"

	"apollo-sfs.com/api/db"
	"apollo-sfs.com/api/models"
)

const (
	cropMaxDim  = 160
	cropMargin  = 0.2
	cropQuality = 80
)

// Start runs the durable queue worker: claim a fair batch, process with
// bounded concurrency, repeat. Call as a goroutine from main (same lifecycle
// as EmailService.Start). No-op when the sidecar is not configured.
func (s *RecognitionService) Start(ctx context.Context) {
	if !s.Available() {
		log.Printf("recognition worker: disabled (RECOGNITION_URL not set)")
		return
	}

	// Nothing is in flight at process start — requeue every processing job.
	if n, err := s.queries.ResetStaleRecognitionJobs(ctx, 0); err != nil {
		log.Printf("recognition worker: startup reset: %v", err)
	} else if n > 0 {
		log.Printf("recognition worker: requeued %d interrupted jobs", n)
	}

	ticker := time.NewTicker(recognitionPollInterval)
	defer ticker.Stop()
	log.Printf("recognition worker: started (poll %s, concurrency %d)", recognitionPollInterval, s.cfg.Concurrency)

	for {
		select {
		case <-ctx.Done():
			log.Printf("recognition worker: stopped")
			return
		case <-ticker.C:
			if _, err := s.queries.ResetStaleRecognitionJobs(ctx, recognitionStaleAfter); err != nil {
				log.Printf("recognition worker: stale reset: %v", err)
			}
			jobs, err := s.queries.ClaimRecognitionJobs(ctx, s.cfg.Concurrency*2)
			if err != nil {
				log.Printf("recognition worker: claim: %v", err)
				continue
			}
			if len(jobs) == 0 {
				continue
			}
			s.markRunStarts(jobs)

			sem := make(chan struct{}, s.cfg.Concurrency)
			var wg sync.WaitGroup
			for _, job := range jobs {
				wg.Add(1)
				sem <- struct{}{}
				go func(j models.RecognitionJob) {
					defer wg.Done()
					defer func() { <-sem }()
					s.processJob(ctx, j)
				}(job)
			}
			wg.Wait()
		}
	}
}

func (s *RecognitionService) markRunStarts(jobs []models.RecognitionJob) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, j := range jobs {
		if _, ok := s.runStarts[j.CollectionID]; !ok {
			s.runStarts[j.CollectionID] = time.Now()
		}
	}
}

// processJob runs one claimed job to a terminal state and emits the
// collection-drained audit event when it finishes the queue.
func (s *RecognitionService) processJob(ctx context.Context, job models.RecognitionJob) {
	defer func() {
		if r := recover(); r != nil {
			log.Printf("recognition job %s: recovered panic: %v", job.ID, r)
			msg := fmt.Sprintf("panic: %v", r)
			_ = s.queries.FinishRecognitionJob(ctx, job.ID, models.RecognitionJobFailed, &msg)
		}
	}()

	status, jobErr := s.runJob(ctx, job)
	var errMsg *string
	if jobErr != nil {
		msg := jobErr.Error()
		if len(msg) > 500 {
			msg = msg[:500]
		}
		errMsg = &msg
		if status == models.RecognitionJobFailed && job.Attempts < recognitionMaxAttempts {
			// Requeue for another attempt; attempts increment on claim.
			status = models.RecognitionJobPending
		}
	}
	if err := s.queries.FinishRecognitionJob(ctx, job.ID, status, errMsg); err != nil {
		log.Printf("recognition job %s: finish: %v", job.ID, err)
		return
	}
	if status == models.RecognitionJobFailed {
		log.Printf("recognition job %s: failed permanently: %v", job.ID, jobErr)
		s.audit(ctx, job.Username, "recognition_job_failed", job.CollectionID, "",
			map[string]any{"file_id": job.FileID.String(), "error": errMsg})
	}
	if status != models.RecognitionJobPending {
		s.maybeAuditIndexComplete(ctx, job)
	}
}

// runJob does the actual work and returns the job's next status.
func (s *RecognitionService) runJob(ctx context.Context, job models.RecognitionJob) (string, error) {
	// Read phase: load the file, re-check the toggle, and look for detections
	// from an earlier indexing of the same file via another collection.
	q, tx, err := s.queries.ForUser(ctx, job.UserID)
	if err != nil {
		return models.RecognitionJobFailed, err
	}
	file, ferr := q.GetFileByID(ctx, job.FileID)
	var collection *models.Folder
	var existing []models.RecognitionDetection
	if ferr == nil {
		collection, err = q.GetFolderByID(ctx, job.CollectionID)
		if err == nil {
			existing, _ = q.ListRecognitionDetectionsByFile(ctx, job.FileID)
		}
	}
	_ = tx.Rollback()

	if ferr != nil || err != nil {
		if errors.Is(ferr, sql.ErrNoRows) || errors.Is(err, sql.ErrNoRows) {
			return models.RecognitionJobSkipped, nil
		}
		if ferr != nil {
			return models.RecognitionJobFailed, ferr
		}
		return models.RecognitionJobFailed, err
	}
	if !collection.AIRecognitionEnabled {
		return models.RecognitionJobSkipped, nil
	}

	if len(existing) > 0 {
		// Already inferred (for another collection) — only cluster-assign here.
		if err := s.assignToGroups(ctx, job, existing); err != nil {
			return models.RecognitionJobFailed, err
		}
		return models.RecognitionJobDone, nil
	}

	// Inference phase (no transaction held).
	frames, err := s.loadFrames(ctx, file, job.Username)
	if err != nil {
		return models.RecognitionJobFailed, err
	}
	var pending []pendingDetection
	for _, frame := range frames {
		result, err := s.client.Analyze(ctx, frame.data, frame.contentType)
		if err != nil {
			return models.RecognitionJobFailed, err
		}
		pending = append(pending, buildDetections(job, frame, result)...)
	}

	// Crop + encrypt + upload thumbnails (quota permitting) before the rows
	// they belong to are committed.
	cropBytes, err := s.storeCrops(ctx, job, file, pending)
	if err != nil {
		return models.RecognitionJobFailed, err
	}

	// Write phase: insert detections and cluster-assign in one transaction.
	if err := s.persistAndAssign(ctx, job, pending); err != nil {
		// The crops are orphaned if this fails — best-effort cleanup.
		s.removeCrops(ctx, job.Username, file, pending)
		return models.RecognitionJobFailed, err
	}
	if cropBytes > 0 {
		if err := s.queries.AddStorageUsed(ctx, job.Username, cropBytes); err != nil {
			log.Printf("recognition job %s: quota add: %v", job.ID, err)
		}
	}
	return models.RecognitionJobDone, nil
}

// analyzedFrame is one plaintext image handed to the sidecar: the file itself
// for photos, or a sampled keyframe for videos.
type analyzedFrame struct {
	data        []byte
	contentType string
	frameMs     *int
}

// pendingDetection pairs a detection row with the source frame it was found
// in so a crop can be cut for it.
type pendingDetection struct {
	det   *models.RecognitionDetection
	frame analyzedFrame
}

// loadFrames decrypts the file and returns the frames to analyze.
func (s *RecognitionService) loadFrames(ctx context.Context, file *models.File, username string) ([]analyzedFrame, error) {
	var plaintext []byte
	var err error
	if IsChunked(file) {
		plaintext, err = s.files.DownloadChunked(ctx, file, username)
	} else {
		_, plaintext, err = s.files.Download(ctx, file.ID, file.UserID, username)
	}
	if err != nil {
		return nil, fmt.Errorf("decrypt source: %w", err)
	}

	if strings.HasPrefix(file.MimeType, "image/") {
		return []analyzedFrame{{data: plaintext, contentType: file.MimeType}}, nil
	}

	// Video: write to a temp file and sample frames with FFmpeg.
	path, cleanup, err := extractToTempFile(plaintext, mimeToExt(file.MimeType))
	plaintext = nil
	if err != nil {
		return nil, fmt.Errorf("keyframes: temp file: %w", err)
	}
	defer cleanup()
	keyframes, err := s.transcode.ExtractKeyframes(ctx, path, s.cfg.MaxKeyframes)
	if err != nil {
		return nil, err
	}
	frames := make([]analyzedFrame, len(keyframes))
	for i, kf := range keyframes {
		ms := kf.FrameMs
		frames[i] = analyzedFrame{data: kf.JPEG, contentType: "image/jpeg", frameMs: &ms}
	}
	return frames, nil
}

// buildDetections converts one frame's sidecar response into detection rows
// (IDs generated up front so crop object keys can embed them).
func buildDetections(job models.RecognitionJob, frame analyzedFrame, result *AnalyzeResult) []pendingDetection {
	versions := result.ModelVersions
	version := func(k string) string {
		if v, ok := versions[k]; ok {
			return v
		}
		return "unknown"
	}
	var out []pendingDetection
	add := func(kind string, class *string, bbox []float32, conf float32, emb []float32, modelKey string) {
		if len(bbox) != 4 {
			return
		}
		d := &models.RecognitionDetection{
			ID:           uuid.New(),
			UserID:       job.UserID,
			FileID:       job.FileID,
			Kind:         kind,
			ClassLabel:   class,
			Confidence:   conf,
			BBoxX:        bbox[0],
			BBoxY:        bbox[1],
			BBoxW:        bbox[2],
			BBoxH:        bbox[3],
			FrameMs:      frame.frameMs,
			ModelVersion: version(modelKey),
		}
		if len(emb) > 0 {
			d.Embedding = embeddingToBytes(normalizeEmbedding(emb))
		}
		out = append(out, pendingDetection{det: d, frame: frame})
	}
	for _, f := range result.Faces {
		add(models.RecognitionKindFace, nil, f.BBox, f.Confidence, f.Embedding, "face")
	}
	for _, p := range result.Pets {
		cls := p.Class
		add(models.RecognitionKindPet, &cls, p.BBox, p.Confidence, p.Embedding, "pet")
	}
	for _, o := range result.Objects {
		cls := o.Class
		add(models.RecognitionKindObject, &cls, o.BBox, o.Confidence, nil, "object")
	}
	return out
}

// storeCrops cuts, encrypts, and uploads face/pet thumbnails, filling in the
// thumb_* fields. Crops count against the user's quota — when there is no
// headroom they are skipped entirely (groups still work, covers fall back to
// file previews). Returns the total bytes stored.
func (s *RecognitionService) storeCrops(ctx context.Context, job models.RecognitionJob, file *models.File, pending []pendingDetection) (int64, error) {
	hasCropKinds := false
	for _, p := range pending {
		if p.det.Kind != models.RecognitionKindObject {
			hasCropKinds = true
			break
		}
	}
	if !hasCropKinds {
		return 0, nil
	}

	storage, err := s.files.storageForFile(ctx, job.Username, file)
	if err != nil {
		return 0, fmt.Errorf("crop storage: %w", err)
	}
	userKey, err := s.files.userKey(ctx, job.Username)
	if err != nil {
		return 0, fmt.Errorf("crop key: %w", err)
	}
	defer zeroBytes(userKey)

	user, err := s.queries.GetUserByUsername(ctx, job.Username)
	if err != nil {
		return 0, fmt.Errorf("crop quota: %w", err)
	}
	headroom := user.StorageQuotaBytes - user.StorageUsedBytes

	var total int64
	for _, p := range pending {
		if p.det.Kind == models.RecognitionKindObject {
			continue
		}
		crop, err := cropDetectionJPEG(p.frame.data, []float32{p.det.BBoxX, p.det.BBoxY, p.det.BBoxW, p.det.BBoxH})
		if err != nil {
			continue // undecodable in Go (e.g. HEIC) — index without a crop
		}
		ciphertext, nonce, err := s.files.enc.EncryptFile(userKey, crop)
		if err != nil {
			continue
		}
		size := int64(len(crop))
		if total+size > headroom {
			log.Printf("recognition job %s: quota exhausted, skipping remaining crops", job.ID)
			break
		}
		key := fmt.Sprintf("%s/recognition/%s.jpg", job.UserID, p.det.ID)
		if err := storage.PutObject(ctx, key, bytes.NewReader(ciphertext), int64(len(ciphertext)), "application/octet-stream"); err != nil {
			log.Printf("recognition job %s: upload crop: %v", job.ID, err)
			continue
		}
		p.det.ThumbObjectKey = &key
		p.det.ThumbNonce = nonce
		p.det.ThumbSizeBytes = size
		total += size
	}
	return total, nil
}

// removeCrops best-effort deletes the crops uploaded for a job whose DB write
// failed (they were never committed, so no quota was charged).
func (s *RecognitionService) removeCrops(ctx context.Context, username string, file *models.File, pending []pendingDetection) {
	storage, err := s.files.storageForFile(ctx, username, file)
	if err != nil {
		return
	}
	for _, p := range pending {
		if p.det.ThumbObjectKey != nil {
			_ = storage.RemoveObject(ctx, *p.det.ThumbObjectKey)
		}
	}
}

// persistAndAssign inserts the detections and cluster-assigns them under one
// ForUser transaction with the collection lock held.
func (s *RecognitionService) persistAndAssign(ctx context.Context, job models.RecognitionJob, pending []pendingDetection) error {
	lock := s.collLock(job.CollectionID)
	lock.Lock()
	defer lock.Unlock()

	q, tx, err := s.queries.ForUser(ctx, job.UserID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()

	dets := make([]models.RecognitionDetection, 0, len(pending))
	for _, p := range pending {
		inserted, err := q.InsertRecognitionDetection(ctx, p.det)
		if err != nil {
			return err
		}
		dets = append(dets, *inserted)
	}
	if err := s.assignToGroupsTx(ctx, q, job, dets); err != nil {
		return err
	}
	return tx.Commit()
}

// assignToGroups cluster-assigns already-persisted detections (the reuse path
// for files indexed via another collection).
func (s *RecognitionService) assignToGroups(ctx context.Context, job models.RecognitionJob, dets []models.RecognitionDetection) error {
	lock := s.collLock(job.CollectionID)
	lock.Lock()
	defer lock.Unlock()

	q, tx, err := s.queries.ForUser(ctx, job.UserID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if err := s.assignToGroupsTx(ctx, q, job, dets); err != nil {
		return err
	}
	return tx.Commit()
}

// memGroup mirrors one group's clustering state in memory for the duration of
// a job so each detection doesn't re-query the group list.
type memGroup struct {
	id         uuid.UUID
	kind       string
	classLabel *string
	centroid   []float32
	weight     int
}

// assignToGroupsTx implements incremental centroid assignment: best
// dot-product group at or above the kind's threshold joins (updating the
// running centroid); otherwise a new group is created. Object detections
// bucket into one group per class. Runs inside the caller's ForUser tx with
// the collection lock held.
func (s *RecognitionService) assignToGroupsTx(ctx context.Context, q *db.Queries, job models.RecognitionJob, dets []models.RecognitionDetection) error {
	groups, err := q.ListRecognitionGroupsByCollection(ctx, job.CollectionID, "", false)
	if err != nil {
		return err
	}
	mem := make([]*memGroup, 0, len(groups))
	for _, g := range groups {
		mg := &memGroup{id: g.ID, kind: g.Kind, classLabel: g.ClassLabel, weight: g.MemberCount}
		if len(g.Centroid) > 0 {
			if c, err := bytesToEmbedding(g.Centroid); err == nil {
				mg.centroid = c
			}
		}
		mem = append(mem, mg)
	}

	for i := range dets {
		det := &dets[i]
		switch det.Kind {
		case models.RecognitionKindObject:
			if err := s.assignObject(ctx, q, job, det, &mem); err != nil {
				return err
			}
		case models.RecognitionKindFace, models.RecognitionKindPet:
			if err := s.assignEmbedding(ctx, q, job, det, &mem); err != nil {
				return err
			}
		}
	}
	return nil
}

func (s *RecognitionService) assignObject(ctx context.Context, q *db.Queries, job models.RecognitionJob, det *models.RecognitionDetection, mem *[]*memGroup) error {
	for _, g := range *mem {
		if g.kind == models.RecognitionKindObject && equalStrPtr(g.classLabel, det.ClassLabel) {
			return q.AddRecognitionGroupMember(ctx, g.id, det.ID, det.FileID, job.UserID)
		}
	}
	label := "object"
	if det.ClassLabel != nil {
		label = *det.ClassLabel
	}
	created, err := q.CreateRecognitionGroup(ctx, &models.RecognitionGroup{
		UserID:       job.UserID,
		CollectionID: job.CollectionID,
		Kind:         models.RecognitionKindObject,
		ClassLabel:   det.ClassLabel,
		AutoLabel:    label,
	})
	if err != nil {
		return err
	}
	*mem = append(*mem, &memGroup{id: created.ID, kind: created.Kind, classLabel: created.ClassLabel})
	return q.AddRecognitionGroupMember(ctx, created.ID, det.ID, det.FileID, job.UserID)
}

func (s *RecognitionService) assignEmbedding(ctx context.Context, q *db.Queries, job models.RecognitionJob, det *models.RecognitionDetection, mem *[]*memGroup) error {
	if len(det.Embedding) == 0 {
		return nil
	}
	emb, err := bytesToEmbedding(det.Embedding)
	if err != nil {
		return nil
	}

	threshold := s.cfg.FaceThreshold
	if det.Kind == models.RecognitionKindPet {
		threshold = s.cfg.PetThreshold
	}

	var best *memGroup
	var bestScore float32 = -1
	for _, g := range *mem {
		if g.kind != det.Kind || len(g.centroid) == 0 {
			continue
		}
		// Pets never cluster across species — the class is part of the key.
		if det.Kind == models.RecognitionKindPet && !equalStrPtr(g.classLabel, det.ClassLabel) {
			continue
		}
		if score := dotProduct(g.centroid, emb); score > bestScore {
			best, bestScore = g, score
		}
	}

	if best != nil && bestScore >= threshold {
		if err := q.AddRecognitionGroupMember(ctx, best.id, det.ID, det.FileID, job.UserID); err != nil {
			return err
		}
		best.centroid = addToCentroid(best.centroid, best.weight, emb)
		best.weight++
		return q.UpdateRecognitionGroupCentroid(ctx, best.id, embeddingToBytes(best.centroid), best.weight)
	}

	seq, err := q.NextRecognitionAutoLabelSeq(ctx, job.CollectionID, det.Kind)
	if err != nil {
		return err
	}
	autoLabel := fmt.Sprintf("Person %d", seq)
	if det.Kind == models.RecognitionKindPet {
		species := "pet"
		if det.ClassLabel != nil {
			species = *det.ClassLabel
		}
		autoLabel = fmt.Sprintf("Pet %d (%s)", seq, species)
	}
	created, err := q.CreateRecognitionGroup(ctx, &models.RecognitionGroup{
		UserID:           job.UserID,
		CollectionID:     job.CollectionID,
		Kind:             det.Kind,
		ClassLabel:       det.ClassLabel,
		AutoLabel:        autoLabel,
		Centroid:         det.Embedding,
		MemberCount:      1,
		CoverDetectionID: &det.ID,
	})
	if err != nil {
		return err
	}
	*mem = append(*mem, &memGroup{
		id: created.ID, kind: created.Kind, classLabel: created.ClassLabel,
		centroid: emb, weight: 1,
	})
	return q.AddRecognitionGroupMember(ctx, created.ID, det.ID, det.FileID, job.UserID)
}

// maybeAuditIndexComplete emits recognition_index_completed once a
// collection's queue fully drains.
func (s *RecognitionService) maybeAuditIndexComplete(ctx context.Context, job models.RecognitionJob) {
	counts, err := s.queries.CountRecognitionJobsByCollection(ctx, job.CollectionID)
	if err != nil || counts.Pending+counts.Processing > 0 {
		return
	}

	s.mu.Lock()
	started, ok := s.runStarts[job.CollectionID]
	delete(s.runStarts, job.CollectionID)
	s.mu.Unlock()
	if !ok {
		return // another goroutine already reported this drain
	}

	var storageBytes int64
	if q, tx, err := s.queries.ForUser(ctx, job.UserID); err == nil {
		storageBytes, _ = q.SumRecognitionStorageForCollection(ctx, job.CollectionID)
		_ = tx.Rollback()
	}
	s.audit(ctx, job.Username, "recognition_index_completed", job.CollectionID, "",
		map[string]any{
			"processed":           counts.Done,
			"failed":              counts.Failed,
			"skipped":             counts.Skipped,
			"storage_bytes_added": storageBytes,
			"duration_ms":         time.Since(started).Milliseconds(),
		})
}

// cropDetectionJPEG cuts the bbox (+20% margin) out of an image, downscales
// the crop to <=160px, and re-encodes as JPEG. Uses a dependency-free
// nearest-neighbor scaler — thumbnail quality is fine at this size.
func cropDetectionJPEG(src []byte, bbox []float32) ([]byte, error) {
	img, _, err := image.Decode(bytes.NewReader(src))
	if err != nil {
		return nil, err
	}
	b := img.Bounds()
	w, h := b.Dx(), b.Dy()

	mx := float64(bbox[2]) * cropMargin
	my := float64(bbox[3]) * cropMargin
	x1 := b.Min.X + int((float64(bbox[0])-mx)*float64(w))
	y1 := b.Min.Y + int((float64(bbox[1])-my)*float64(h))
	x2 := b.Min.X + int((float64(bbox[0])+float64(bbox[2])+mx)*float64(w))
	y2 := b.Min.Y + int((float64(bbox[1])+float64(bbox[3])+my)*float64(h))
	x1, y1 = max(x1, b.Min.X), max(y1, b.Min.Y)
	x2, y2 = min(x2, b.Max.X), min(y2, b.Max.Y)
	if x2-x1 < 2 || y2-y1 < 2 {
		return nil, fmt.Errorf("crop region too small")
	}

	cw, ch := x2-x1, y2-y1
	scale := 1.0
	if cw > cropMaxDim || ch > cropMaxDim {
		scale = float64(cropMaxDim) / float64(max(cw, ch))
	}
	tw, th := max(1, int(float64(cw)*scale)), max(1, int(float64(ch)*scale))

	thumb := image.NewRGBA(image.Rect(0, 0, tw, th))
	for ty := 0; ty < th; ty++ {
		sy := y1 + ty*ch/th
		for tx := 0; tx < tw; tx++ {
			sx := x1 + tx*cw/tw
			thumb.Set(tx, ty, img.At(sx, sy))
		}
	}

	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, thumb, &jpeg.Options{Quality: cropQuality}); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}
