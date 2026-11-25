"""Golden tests for apollo_stack.py — the generated per-node stack file."""
import json
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ND = os.environ.get("APOLLO_NODE_STATUS_DIR") or os.path.join(HERE, "..", "..", "..", "node-status")
sys.path.insert(0, ND)
import apollo_stack  # noqa: E402

REPO = os.path.abspath(os.path.join(ND, "..", ".."))
TEMPLATE = os.path.join(REPO, "scripts", "deploy", "templates", "legacy-node-services.yml")
ORIG_STACK = os.environ.get("APOLLO_ORIG_STACK")  # optional: pre-2.0 docker-stack.yml for a 3-way check


def write_records(d, recs):
    for r in recs:
        with open(os.path.join(d, r["hostname"] + ".json"), "w") as f:
            json.dump(r, f)


class LegacyEquivalence(unittest.TestCase):
    def test_seeded_render_matches_template(self):
        """Adoption must not change any service spec → no restarts."""
        with tempfile.TemporaryDirectory() as d:
            write_records(d, apollo_stack.legacy_seeds("apollo-sfs", "apollo-sfs-1", "2026-01-01T00:00:00Z"))
            rendered = apollo_stack.render(apollo_stack.load_records(d))
        with open(TEMPLATE) as f:
            template = f.read()
        self.assertEqual(apollo_stack.compare(template, rendered), [])
        self.assertEqual(sorted(apollo_stack.service_blocks(rendered)),
                         ["minio", "minio-standard", "node-agent-fast", "node-agent-standard"])

    def test_template_matches_pre_2_0_stack_file(self):
        if not ORIG_STACK or not os.path.exists(ORIG_STACK):
            self.skipTest("APOLLO_ORIG_STACK not provided")
        with open(ORIG_STACK) as f:
            orig = apollo_stack.service_blocks(f.read())
        with open(TEMPLATE) as f:
            tmpl = apollo_stack.service_blocks(f.read())
        for name, lines in tmpl.items():
            self.assertEqual(orig[name], lines, name)

    def test_render_is_deterministic(self):
        with tempfile.TemporaryDirectory() as d:
            write_records(d, apollo_stack.legacy_seeds("b-node", "a-node"))
            a = apollo_stack.render(apollo_stack.load_records(d))
            b = apollo_stack.render(apollo_stack.load_records(d))
        self.assertEqual(a, b)


def request(hostname, tier, drives, pools=(), blob=None, phase="full", role="worker"):
    roles = {}
    if blob is not None:
        roles = {"blob_storage_shard": {"enabled": blob, "implemented": True, "percent": 100}}
    return {"hostname": hostname, "phase": phase, "previous_names": [],
            "deployment": {"node": {"name": hostname, "ip": "192.168.68.70", "arch": "aarch64"},
                           "cluster": {"role": role}, "storage": {"tier": tier},
                           "drives": drives, "pools": list(pools), "roles": roles}}


def drive(label, mnt, tier="fast"):
    return {"label": label, "mountpoint": mnt, "data_dir": mnt + "/data", "bench_dir": mnt + "/.bench", "tier": tier}


class MergeRecord(unittest.TestCase):
    def test_new_node_gets_hostname_placement_and_agent(self):
        rec, w = apollo_stack.merge_record(None, request("apollo-sfs-3", "standard", [drive("hdd-02", "/srv/minio/hdd-02", "standard")], phase="drives"),
                                           "apollo-sfs-3", {"fast": "apollo-sfs", "standard": None})
        self.assertEqual(rec["services"], {"agent": "node-agent-apollo-sfs-3"})
        self.assertEqual(rec["placement"], "node.hostname == apollo-sfs-3")
        text = apollo_stack.render([rec])
        self.assertIn('NODE_DISK_MOUNTS: "hdd-02:/srv/minio/hdd-02"', text)
        self.assertIn("- /srv/minio/hdd-02/.bench:/bench/hdd-02", text)
        self.assertEqual(w, [])

    def test_blob_role_adds_minio_for_tier(self):
        rec, _ = apollo_stack.merge_record(None, request("apollo-sfs-3", "standard", [drive("hdd-02", "/srv/minio/hdd-02", "standard")], blob=True),
                                           "apollo-sfs-3", {"fast": "apollo-sfs", "standard": None})
        self.assertEqual(rec["services"]["minio"], "minio-standard")
        self.assertEqual(rec["minio_data_path"], "/srv/minio/hdd-02/data")

    def test_tier_already_served_is_refused(self):
        with self.assertRaises(apollo_stack.RecordError):
            apollo_stack.merge_record(None, request("apollo-sfs-3", "fast", [drive("nvme-03", "/srv/minio/nvme-03")], blob=True),
                                      "apollo-sfs-3", {"fast": "apollo-sfs", "standard": None})

    def test_seeded_pi_registration_keeps_legacy_render(self):
        seeds = {r["tier"]: r for r in apollo_stack.legacy_seeds("apollo-sfs", "apollo-sfs-1")}
        pi = request("apollo-sfs", "fast",
                     [drive("nvme-01", "/home/apollo/apollo-sfs/minio/nvme-01"), drive("nvme-02", "/home/apollo/apollo-sfs/minio/nvme-02")],
                     pools=[{"tier": "fast", "path": "/home/apollo/apollo-sfs/minio/pool"}], blob=True)
        rec, _ = apollo_stack.merge_record(seeds["fast"], pi, "apollo-sfs", {"fast": "apollo-sfs", "standard": "apollo-sfs-1"})
        before = apollo_stack.render([seeds["fast"]])
        after = apollo_stack.render([rec])
        self.assertEqual(apollo_stack.compare(before, after), [])

    def test_removing_blob_keeps_existing_minio_with_warning(self):
        seeds = {r["tier"]: r for r in apollo_stack.legacy_seeds("apollo-sfs", "apollo-sfs-1")}
        req = request("apollo-sfs-1", "standard", [drive("hdd-01", "/srv/minio/hdd-01", "standard")], blob=False, role="manager")
        rec, w = apollo_stack.merge_record(seeds["standard"], req, "apollo-sfs-1", {"fast": "apollo-sfs", "standard": "apollo-sfs-1"})
        self.assertEqual(rec["services"]["minio"], "minio-standard")
        self.assertTrue(w)

    def test_adding_a_drive_extends_agent_mounts(self):
        seeds = {r["tier"]: r for r in apollo_stack.legacy_seeds("apollo-sfs", "apollo-sfs-1")}
        drives = [drive("nvme-0%d" % i, "/home/apollo/apollo-sfs/minio/nvme-0%d" % i) for i in (1, 2, 3)]
        rec, _ = apollo_stack.merge_record(seeds["fast"], request("apollo-sfs", "fast", drives,
                                           pools=[{"tier": "fast", "path": "/home/apollo/apollo-sfs/minio/pool"}], blob=True),
                                           "apollo-sfs", {"fast": "apollo-sfs"})
        text = apollo_stack.render([rec])
        self.assertIn("nvme-03:/home/apollo/apollo-sfs/minio/nvme-03", text)
        self.assertIn("- /home/apollo/apollo-sfs/minio/nvme-03/.bench:/bench/nvme-03", text)
        self.assertEqual(rec["services"]["agent"], "node-agent-fast")

    def test_bad_paths_rejected(self):
        bad = request("apollo-sfs-3", "standard", [drive("hdd-02", "/srv/minio/hdd 02", "standard")], phase="drives")
        with self.assertRaises(apollo_stack.RecordError):
            apollo_stack.merge_record(None, bad, "apollo-sfs-3", {})


class Cli(unittest.TestCase):
    def test_cli_render_and_tiers(self):
        with tempfile.TemporaryDirectory() as d:
            write_records(d, apollo_stack.legacy_seeds("apollo-sfs", "apollo-sfs-1"))
            py = [sys.executable, "-I", "-B", os.path.join(ND, "apollo_node.py"), "stack"]
            out = subprocess.run(py + ["tiers", "--nodes-dir", d], capture_output=True, text=True, check=True).stdout
            self.assertEqual(json.loads(out), {"fast": "apollo-sfs", "standard": "apollo-sfs-1"})
            out = subprocess.run(py + ["render", "--nodes-dir", d], capture_output=True, text=True, check=True).stdout
            self.assertIn("node-agent-standard:", out)

    def test_cli_rename_carries_blob_storage_over(self):
        # The Pi (legacy seed "apollo-sfs", serving the fast tier) is renamed:
        # registering under the new name must not be refused as "tier taken",
        # and the services/data path must not change.
        pi_drives = [drive("nvme-01", "/home/apollo/apollo-sfs/minio/nvme-01"),
                     drive("nvme-02", "/home/apollo/apollo-sfs/minio/nvme-02")]
        pool = [{"tier": "fast", "path": "/home/apollo/apollo-sfs/minio/pool"}]
        with tempfile.TemporaryDirectory() as d:
            seeds = apollo_stack.legacy_seeds("apollo-sfs", "apollo-sfs-1")
            write_records(d, seeds)
            req = request("nh-fast-node-001", "fast", pi_drives, pools=pool, blob=True)
            req["previous_names"] = ["apollo-sfs"]
            rf = os.path.join(d, "req.json.in")
            with open(rf, "w") as f:
                json.dump(req, f)
            py = [sys.executable, "-I", "-B", os.path.join(ND, "apollo_node.py"), "stack"]
            p = subprocess.run(py + ["merge-record", "--nodes-dir", d, "--hostname", "nh-fast-node-001", "--request", rf],
                               capture_output=True, text=True)
            self.assertEqual(p.returncode, 0, p.stderr)
            rec = json.loads(p.stdout)
            self.assertEqual(rec["hostname"], "nh-fast-node-001")
            self.assertEqual(rec["services"]["minio"], "minio")
            self.assertEqual(rec["previous_names"], ["apollo-sfs"])
            fast_seed = next(r for r in seeds if r["tier"] == "fast")
            self.assertEqual(apollo_stack.compare(apollo_stack.render([fast_seed]), apollo_stack.render([rec])), [])

    def test_rename_moves_hostname_placement(self):
        rec0, _ = apollo_stack.merge_record(None, request("apollo-sfs-3", "standard", [drive("hdd-02", "/srv/minio/hdd-02", "standard")], blob=True),
                                            "apollo-sfs-3", {})
        req = request("nh-std-002", "standard", [drive("hdd-02", "/srv/minio/hdd-02", "standard")], blob=True)
        rec, w = apollo_stack.merge_record(dict(rec0, renamed_from="apollo-sfs-3"), req, "nh-std-002", {})
        self.assertEqual(rec["placement"], "node.hostname == nh-std-002")
        self.assertEqual(rec["services"]["agent"], "node-agent-apollo-sfs-3")   # kept: no service recreation
        self.assertNotIn("renamed_from", rec)
        self.assertTrue(any("renamed" in x for x in w))


if __name__ == "__main__":
    unittest.main()
