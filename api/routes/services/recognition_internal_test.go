package services

import (
	"bytes"
	"image"
	"image/color"
	"image/jpeg"
	"math"
	"testing"

	"github.com/google/uuid"

	"apollo-sfs.com/api/models"
)

// ── Embedding codec ─────────────────────────────────────────────────────────

func TestEmbeddingCodecRoundTrip(t *testing.T) {
	in := []float32{0.25, -1.5, 3.75, 0, 1e-6}
	out, err := bytesToEmbedding(embeddingToBytes(in))
	if err != nil {
		t.Fatalf("round trip: %v", err)
	}
	if len(out) != len(in) {
		t.Fatalf("length mismatch: %d != %d", len(out), len(in))
	}
	for i := range in {
		if in[i] != out[i] {
			t.Fatalf("value %d changed: %v != %v", i, in[i], out[i])
		}
	}
}

func TestBytesToEmbeddingRejectsBadLength(t *testing.T) {
	if _, err := bytesToEmbedding([]byte{1, 2, 3}); err == nil {
		t.Fatal("expected error for non-multiple-of-4 blob")
	}
	if _, err := bytesToEmbedding(nil); err == nil {
		t.Fatal("expected error for empty blob")
	}
}

// ── Centroid math ───────────────────────────────────────────────────────────

func TestNormalizeAndDot(t *testing.T) {
	v := normalizeEmbedding([]float32{3, 4})
	if math.Abs(float64(v[0])-0.6) > 1e-6 || math.Abs(float64(v[1])-0.8) > 1e-6 {
		t.Fatalf("normalize wrong: %v", v)
	}
	if d := dotProduct(v, v); math.Abs(float64(d)-1) > 1e-6 {
		t.Fatalf("unit self-dot should be 1, got %v", d)
	}
	if d := dotProduct([]float32{1, 0}, []float32{0, 1}); d != 0 {
		t.Fatalf("orthogonal dot should be 0, got %v", d)
	}
	if d := dotProduct([]float32{1}, []float32{1, 2}); d != -1 {
		t.Fatalf("mismatched lengths should return -1, got %v", d)
	}
}

func TestAddToCentroidMovesTowardNewMember(t *testing.T) {
	centroid := []float32{1, 0}
	emb := []float32{0, 1}
	out := addToCentroid(centroid, 1, emb)
	// Mean of (1,0) and (0,1) normalized → (√2/2, √2/2).
	want := float32(math.Sqrt2 / 2)
	if math.Abs(float64(out[0]-want)) > 1e-6 || math.Abs(float64(out[1]-want)) > 1e-6 {
		t.Fatalf("unexpected centroid: %v", out)
	}
	// Higher weight → less movement toward the new member.
	heavy := addToCentroid([]float32{1, 0}, 9, emb)
	if heavy[0] <= out[0] {
		t.Fatalf("weight-9 centroid should stay closer to (1,0): %v vs %v", heavy, out)
	}
}

func TestMergeCentroidsWeighted(t *testing.T) {
	c := mergeCentroids([]float32{1, 0}, 3, []float32{0, 1}, 1)
	if c[0] <= c[1] {
		t.Fatalf("weighted merge should lean toward the heavier centroid: %v", c)
	}
	norm := math.Sqrt(float64(c[0]*c[0] + c[1]*c[1]))
	if math.Abs(norm-1) > 1e-6 {
		t.Fatalf("merged centroid must be unit length, got %v", norm)
	}
	// Degenerate inputs fall back sensibly.
	if got := mergeCentroids(nil, 0, []float32{0, 1}, 1); got[1] != 1 {
		t.Fatalf("empty first centroid should yield second: %v", got)
	}
}

// ── Detection building ──────────────────────────────────────────────────────

func TestBuildDetections(t *testing.T) {
	job := models.RecognitionJob{
		ID:           uuid.New(),
		UserID:       uuid.New(),
		FileID:       uuid.New(),
		CollectionID: uuid.New(),
	}
	ms := 4000
	frame := analyzedFrame{data: []byte("jpeg"), contentType: "image/jpeg", frameMs: &ms}
	result := &AnalyzeResult{
		Faces:   []AnalyzedFace{{BBox: []float32{0.1, 0.2, 0.3, 0.4}, Confidence: 0.9, Embedding: []float32{3, 4}}},
		Pets:    []AnalyzedPet{{Class: "cat", BBox: []float32{0, 0, 0.5, 0.5}, Confidence: 0.8, Embedding: []float32{0, 1}}},
		Objects: []AnalyzedObject{{Class: "car", BBox: []float32{0.5, 0.5, 0.2, 0.2}, Confidence: 0.7}},
		ModelVersions: map[string]string{"face": "f1", "pet": "p1", "object": "o1"},
	}

	out := buildDetections(job, frame, result)
	if len(out) != 3 {
		t.Fatalf("expected 3 detections, got %d", len(out))
	}

	face := out[0].det
	if face.Kind != models.RecognitionKindFace || face.ModelVersion != "f1" || face.ID == uuid.Nil {
		t.Fatalf("unexpected face detection: %+v", face)
	}
	if face.FrameMs == nil || *face.FrameMs != 4000 {
		t.Fatalf("frame_ms not carried: %+v", face.FrameMs)
	}
	// Embeddings are normalized before storage.
	emb, err := bytesToEmbedding(face.Embedding)
	if err != nil {
		t.Fatalf("face embedding: %v", err)
	}
	if math.Abs(float64(emb[0])-0.6) > 1e-6 {
		t.Fatalf("face embedding not normalized: %v", emb)
	}

	pet := out[1].det
	if pet.Kind != models.RecognitionKindPet || *pet.ClassLabel != "cat" || len(pet.Embedding) == 0 {
		t.Fatalf("unexpected pet detection: %+v", pet)
	}

	obj := out[2].det
	if obj.Kind != models.RecognitionKindObject || *obj.ClassLabel != "car" || obj.Embedding != nil {
		t.Fatalf("unexpected object detection: %+v", obj)
	}

	// Malformed bboxes are dropped, not persisted.
	bad := buildDetections(job, frame, &AnalyzeResult{
		Objects: []AnalyzedObject{{Class: "car", BBox: []float32{0.1, 0.2}, Confidence: 0.7}},
	})
	if len(bad) != 0 {
		t.Fatalf("expected malformed bbox to be dropped, got %d", len(bad))
	}
}

// ── Crop generation ─────────────────────────────────────────────────────────

func testJPEG(t *testing.T, w, h int) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			img.Set(x, y, color.RGBA{R: uint8(x % 256), G: uint8(y % 256), B: 100, A: 255})
		}
	}
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, nil); err != nil {
		t.Fatalf("encode test jpeg: %v", err)
	}
	return buf.Bytes()
}

func TestCropDetectionJPEG(t *testing.T) {
	src := testJPEG(t, 800, 600)
	crop, err := cropDetectionJPEG(src, []float32{0.25, 0.25, 0.5, 0.5})
	if err != nil {
		t.Fatalf("crop: %v", err)
	}
	img, err := jpeg.Decode(bytes.NewReader(crop))
	if err != nil {
		t.Fatalf("decode crop: %v", err)
	}
	b := img.Bounds()
	if b.Dx() > cropMaxDim || b.Dy() > cropMaxDim {
		t.Fatalf("crop exceeds max dim: %dx%d", b.Dx(), b.Dy())
	}
	if b.Dx() < 2 || b.Dy() < 2 {
		t.Fatalf("crop unexpectedly tiny: %dx%d", b.Dx(), b.Dy())
	}
}

func TestCropDetectionJPEGRejectsTinyRegions(t *testing.T) {
	src := testJPEG(t, 100, 100)
	if _, err := cropDetectionJPEG(src, []float32{0.5, 0.5, 0.001, 0.001}); err == nil {
		t.Fatal("expected error for sub-2px crop region")
	}
}

func TestCropDetectionJPEGRejectsGarbage(t *testing.T) {
	if _, err := cropDetectionJPEG([]byte("not an image"), []float32{0, 0, 1, 1}); err == nil {
		t.Fatal("expected decode error")
	}
}

// ── Misc helpers ────────────────────────────────────────────────────────────

func TestEqualStrPtr(t *testing.T) {
	a, b := "cat", "dog"
	cases := []struct {
		x, y *string
		want bool
	}{
		{nil, nil, true},
		{&a, nil, false},
		{nil, &b, false},
		{&a, &a, true},
		{&a, &b, false},
	}
	for i, c := range cases {
		if got := equalStrPtr(c.x, c.y); got != c.want {
			t.Fatalf("case %d: got %v want %v", i, got, c.want)
		}
	}
}
