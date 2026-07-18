package services

import (
	"encoding/binary"
	"fmt"
	"math"
)

// Embedding codec + incremental centroid math for recognition clustering.
// Embeddings are stored in Postgres as little-endian float32 BYTEA and kept
// unit-normalized, so cosine similarity reduces to a dot product. Clustering
// is a simple incremental centroid assignment: per-collection group counts
// are small enough that scanning every group per detection is trivial, which
// is why no vector index (pgvector) is needed.

// embeddingToBytes serializes a float32 vector as little-endian BYTEA.
func embeddingToBytes(v []float32) []byte {
	out := make([]byte, 4*len(v))
	for i, f := range v {
		binary.LittleEndian.PutUint32(out[i*4:], math.Float32bits(f))
	}
	return out
}

// bytesToEmbedding deserializes a little-endian float32 BYTEA vector.
func bytesToEmbedding(b []byte) ([]float32, error) {
	if len(b) == 0 || len(b)%4 != 0 {
		return nil, fmt.Errorf("embedding blob has invalid length %d", len(b))
	}
	out := make([]float32, len(b)/4)
	for i := range out {
		out[i] = math.Float32frombits(binary.LittleEndian.Uint32(b[i*4:]))
	}
	return out, nil
}

// normalizeEmbedding scales v to unit length in place (no-op for zero vectors).
func normalizeEmbedding(v []float32) []float32 {
	var sum float64
	for _, f := range v {
		sum += float64(f) * float64(f)
	}
	norm := math.Sqrt(sum)
	if norm == 0 {
		return v
	}
	for i := range v {
		v[i] = float32(float64(v[i]) / norm)
	}
	return v
}

// dotProduct returns the cosine similarity of two unit vectors.
func dotProduct(a, b []float32) float32 {
	if len(a) != len(b) {
		return -1
	}
	var sum float64
	for i := range a {
		sum += float64(a[i]) * float64(b[i])
	}
	return float32(sum)
}

// addToCentroid folds one new member embedding into a running centroid of
// weight n, returning the re-normalized centroid (weight becomes n+1).
func addToCentroid(centroid []float32, n int, emb []float32) []float32 {
	if len(centroid) != len(emb) || n <= 0 {
		return normalizeEmbedding(append([]float32(nil), emb...))
	}
	out := make([]float32, len(centroid))
	fn := float64(n)
	for i := range centroid {
		out[i] = float32((float64(centroid[i])*fn + float64(emb[i])) / (fn + 1))
	}
	return normalizeEmbedding(out)
}

// mergeCentroids combines two weighted centroids into one re-normalized
// centroid of weight n1+n2.
func mergeCentroids(c1 []float32, n1 int, c2 []float32, n2 int) []float32 {
	if len(c1) == 0 {
		return c2
	}
	if len(c2) == 0 || len(c1) != len(c2) {
		return c1
	}
	out := make([]float32, len(c1))
	f1, f2 := float64(n1), float64(n2)
	if f1+f2 == 0 {
		f1, f2 = 1, 1
	}
	for i := range c1 {
		out[i] = float32((float64(c1[i])*f1 + float64(c2[i])*f2) / (f1 + f2))
	}
	return normalizeEmbedding(out)
}
