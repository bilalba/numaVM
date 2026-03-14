# Rebuilding VM Rootfs Images

## Quick Reference

```bash
# On the compute node (ssh numavm):
sudo /home/ubuntu/numavm/oss/vm/build-rootfs.sh --distro ubuntu --output-dir /data/rootfs
sudo /home/ubuntu/numavm/oss/vm/build-rootfs.sh --distro alpine --output-dir /data/rootfs
```

## Important: Output Directory

The `--output-dir` flag **must** match the `FC_ROOTFS_DIR` env var configured in the node's `.env` file.

| Environment | `FC_ROOTFS_DIR` | Default (no flag) |
|-------------|-----------------|-------------------|
| Production node (`numavm`) | `/data/rootfs` | `/opt/firecracker/rootfs` |
| Dev / standalone | Usually unset | `/opt/firecracker/rootfs` |

**If you omit `--output-dir`, the rootfs is written to `/opt/firecracker/rootfs/` but the agent reads from `/data/rootfs/` — new VMs will still use the old image.**

Check the node's configured directory:
```bash
grep FC_ROOTFS_DIR /home/ubuntu/numavm/oss/.env
```

## How It Works

1. `build-rootfs.sh` creates a versioned ext4 image (e.g. `ubuntu-v4.ext4`)
2. Updates the `<distro>.ext4` symlink to point to the new version (e.g. `ubuntu.ext4 -> ubuntu-v4.ext4`)
3. Updates `manifest.json` with version metadata
4. New VMs get a copy of whatever the symlink points to at creation time
5. Existing VMs are unaffected (they have their own rootfs copy)

## Distro Init Systems

- **Alpine**: Custom PID 1 init (`/sbin/numavm-init` → `/opt/numavm/init.sh`). Kernel boot arg: `init=/sbin/numavm-init`
- **Ubuntu**: Systemd as PID 1 (`/lib/systemd/systemd`). Kernel boot arg: `init=/lib/systemd/systemd`. Services: `numavm-setup.service` (networking, SSH) → `numavm-app.service` (git, env, app)

## After Rebuilding

- No agent restart needed — the symlink is resolved at VM creation time
- Old images are kept on disk (for rollback). Clean up manually if disk space is needed
- The `image_version` in the DB is informational only — it doesn't affect rootfs selection
