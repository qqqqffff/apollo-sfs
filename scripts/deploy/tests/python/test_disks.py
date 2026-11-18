"""Tests for apollo_disks.py — drive classification must never offer a disk
the OS or another subsystem is using, and must adopt Apollo drives."""
import json
import os
import subprocess
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ND = os.environ.get("APOLLO_NODE_STATUS_DIR") or os.path.join(HERE, "..", "..", "..", "node-status")
sys.path.insert(0, ND)
import apollo_disks  # noqa: E402

FX = os.path.join(HERE, "fixtures", "ws2")


def run_list(name, node_json=None):
    d = os.path.join(FX, name)
    args = ["list", "--lsblk-json", os.path.join(d, "lsblk.json"), "--swaps", os.path.join(d, "swaps"),
            "--fstab", os.path.join(d, "fstab"), "--mountinfo", os.path.join(d, "mountinfo"),
            "--crypttab", os.path.join(d, "crypttab"), "--sys-root", os.path.join(d, "sysroot")]
    if node_json:
        args += ["--node-json", node_json]
    out = subprocess.run([sys.executable, "-I", "-B", os.path.join(ND, "apollo_node.py"), "disks"] + args,
                         capture_output=True, text=True, check=True).stdout
    data = json.loads(out)
    return data, {x["name"]: x for x in data["disks"]}


class Classification(unittest.TestCase):
    def test_wsl_box_offers_nothing(self):
        _, by = run_list("wsl")
        for name, d in by.items():
            self.assertIn(d["status"], ("system", "in_use"), "%s offered on the WSL box: %s" % (name, d["reasons"]))

    def test_manager_adopts_hdd01_and_protects_os(self):
        _, by = run_list("manager")
        self.assertEqual(by["nvme0n1"]["status"], "system")
        self.assertEqual(by["sda"]["status"], "apollo")
        self.assertEqual(by["sda"]["label"], "hdd-01")
        self.assertEqual(by["sda"]["mountpoint"], "/srv/minio/hdd-01")
        self.assertEqual(by["sda"]["class_guess"], "hdd")
        self.assertEqual(by["sda"]["part_path"], "/dev/sda1")

    def test_pi_adopts_both_nvmes_and_finds_the_pool(self):
        data, by = run_list("pi")
        self.assertEqual(by["mmcblk0"]["status"], "system")
        self.assertEqual(by["nvme0n1"]["status"], "apollo")
        self.assertEqual(by["nvme0n1"]["fstype"], "ext4")
        self.assertEqual(by["nvme1n1"]["status"], "apollo")
        self.assertEqual(by["nvme1n1"]["part_path"], "/dev/nvme1n1")  # whole-disk filesystem
        self.assertEqual(by["nvme1n1"]["class_guess"], "nvme")
        pool = data["pools"][0]
        self.assertTrue(pool["mounted"])
        self.assertFalse(pool["nofail"])
        self.assertEqual(len(pool["branches"]), 2)

    def test_fresh_node(self):
        _, by = run_list("fresh")
        self.assertEqual(by["nvme0n1"]["status"], "system")
        self.assertEqual(by["sda"]["status"], "blank")
        self.assertEqual(by["sdb"]["status"], "foreign")
        self.assertEqual(by["sdc"]["status"], "foreign")
        self.assertTrue(by["sdc"]["needs_class_confirm"])   # USB bridge: ROTA can't be trusted
        self.assertEqual(by["sdd"]["status"], "in_use")      # LVM member
        self.assertTrue(any("LVM" in r for r in by["sdd"]["reasons"]))

    def test_recorded_uuid_is_adopted_without_label(self):
        import tempfile
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
            json.dump({"deployment": {"drives": [{"label": "hdd-02", "uuid": "01D9C3F5A1B2C3D4",
                                                   "mountpoint": "/srv/minio/hdd-02"}]}}, f)
        try:
            _, by = run_list("fresh", node_json=f.name)
            self.assertEqual(by["sdb"]["status"], "apollo")
        finally:
            os.unlink(f.name)

    def test_disk_in_fstab_but_unmounted_is_in_use(self):
        ctx = {"swaps": set(), "fstab": apollo_disks.parse_fstab("UUID=abc /mnt/backup ext4 defaults 0 2\n"),
               "crypttab": [], "mounts_by_dev": {}, "holders": {}, "by_id": {}, "recorded_uuids": {}, "apollo_mounts": set()}
        disk = {"name": "sdx", "path": "/dev/sdx", "type": "disk", "size": 10,
                "children": [{"name": "sdx1", "path": "/dev/sdx1", "type": "part", "fstype": "ext4", "uuid": "abc"}]}
        self.assertEqual(apollo_disks.classify(disk, ctx)["status"], "in_use")

    def test_held_disk_is_in_use(self):
        ctx = {"swaps": set(), "fstab": [], "crypttab": [], "mounts_by_dev": {}, "holders": {"sdy": ["dm-0"]},
               "by_id": {}, "recorded_uuids": {}, "apollo_mounts": set()}
        self.assertEqual(apollo_disks.classify({"name": "sdy", "path": "/dev/sdy", "type": "disk", "size": 1}, ctx)["status"], "in_use")

    def test_duplicate_labels_flagged(self):
        import copy, tempfile
        with open(os.path.join(FX, "pi", "lsblk.json")) as f:
            data = json.load(f)
        dup = copy.deepcopy(data["blockdevices"][2]); dup["name"] = "nvme2n1"; dup["path"] = "/dev/nvme2n1"
        dup["uuid"] = "ffffffff-0000-4000-8000-000000000000"; dup["mountpoint"] = None
        data["blockdevices"].append(dup)
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
            json.dump(data, f)
        try:
            out = subprocess.run([sys.executable, "-I", "-B", os.path.join(ND, "apollo_node.py"), "disks", "list",
                                  "--lsblk-json", f.name], capture_output=True, text=True, check=True).stdout
            self.assertTrue(json.loads(out)["warnings"])
        finally:
            os.unlink(f.name)


class FstabFix(unittest.TestCase):
    def test_adds_nofail_to_the_pi_pool_line_keeping_branches(self):
        with open(os.path.join(FX, "pi", "fstab")) as f:
            text = f.read()
        line = apollo_disks.fstab_fix(text, "/home/apollo/apollo-sfs/minio/pool", ["nofail"])
        self.assertIn("nofail", line)
        self.assertIn("x-systemd.requires=/home/apollo/apollo-sfs/minio/nvme-01", line)
        self.assertTrue(line.startswith("/home/apollo/apollo-sfs/minio/nvme-01/data:/home/apollo/apollo-sfs/minio/nvme-02/data "))

    def test_no_change_when_present(self):
        with open(os.path.join(FX, "manager", "fstab")) as f:
            self.assertIsNone(apollo_disks.fstab_fix(f.read(), "/srv/minio/hdd-01", ["nofail", "x-systemd.device-timeout=10"]))


if __name__ == "__main__":
    unittest.main()
