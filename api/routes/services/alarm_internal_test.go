package services

import (
	"strings"
	"testing"

	"github.com/google/uuid"

	"apollo-sfs.com/api/models"
)

// noDriveTemps / noDriveSummary are unused lookups for node-scoped assessments.
func noDriveTemps(uuid.UUID) []models.DriveTempSnapshot { return nil }
func noDriveSummary(uuid.UUID) (models.DriveSummary, bool) {
	return models.DriveSummary{}, false
}

// assess must evaluate CPU usage per node: only the node whose own snapshot
// window breaches the subscriber's threshold fires, and the message names it.
func TestAssess_CPUUsage_PerNode(t *testing.T) {
	svc := &AlarmService{}
	nodeA, nodeB := uuid.New(), uuid.New()
	snaps := map[uuid.UUID][]models.NodeMetricSnapshot{
		nodeA: {{CPUPercent: 95}, {CPUPercent: 96}},
		nodeB: {{CPUPercent: 40}, {CPUPercent: 50}},
	}
	getNode := func(id uuid.UUID) []models.NodeMetricSnapshot { return snaps[id] }

	subA := &models.AlarmSubscription{
		AlarmType: models.AlarmCPUUsage, NodeID: &nodeA, Threshold: 90,
		NodeHostname: "apollo-sfs-1", NodeRole: "manager",
	}
	_, detail, fire := svc.assess(subA, getNode, noDriveTemps, noDriveSummary)
	if !fire {
		t.Fatalf("expected node A (95%%) to breach 90%% threshold")
	}
	if !strings.Contains(detail, "apollo-sfs-1") || !strings.Contains(detail, "manager") {
		t.Errorf("detail should name the breaching node, got: %s", detail)
	}

	subB := &models.AlarmSubscription{AlarmType: models.AlarmCPUUsage, NodeID: &nodeB, Threshold: 90}
	if _, _, fireB := svc.assess(subB, getNode, noDriveTemps, noDriveSummary); fireB {
		t.Errorf("expected node B (45%%) not to breach 90%% threshold")
	}
}

// Each subscription is compared against its own threshold, not a shared constant.
func TestAssess_PerSubscriptionThreshold(t *testing.T) {
	svc := &AlarmService{}
	node := uuid.New()
	getNode := func(uuid.UUID) []models.NodeMetricSnapshot {
		return []models.NodeMetricSnapshot{{CPUPercent: 70}, {CPUPercent: 70}}
	}

	strict := &models.AlarmSubscription{AlarmType: models.AlarmCPUUsage, NodeID: &node, Threshold: 60}
	if _, _, fire := svc.assess(strict, getNode, noDriveTemps, noDriveSummary); !fire {
		t.Errorf("70%% should breach a 60%% threshold")
	}
	lax := &models.AlarmSubscription{AlarmType: models.AlarmCPUUsage, NodeID: &node, Threshold: 90}
	if _, _, fire := svc.assess(lax, getNode, noDriveTemps, noDriveSummary); fire {
		t.Errorf("70%% should not breach a 90%% threshold")
	}
}
