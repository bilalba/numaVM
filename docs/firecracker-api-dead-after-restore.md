# Firecracker API Socket Dead After Snapshot Restore

**Status**: Fixed (upgrade to v1.14.2)
**Discovered**: 2026-03-04
**Fixed**: 2026-03-05
**Firecracker version**: v1.10.1 (affected), v1.14.2 (fixed)
**Host**: AWS Graviton (aarch64, Cortex-A72)
**Affected files**: `control-plane/services/idle-monitor.ts`, `control-plane/services/firecracker.ts`

## Problem

After restoring a VM from a snapshot, the Firecracker HTTP API socket (`/tmp/fc-{slug}.sock`) stops accepting connections at some point. The Firecracker process remains alive and the VM continues to work (SSH, networking all fine), but the management API is completely unresponsive.

This means **re-snapshotting a restored VM is impossible** via the API. The idle monitor detects the VM as idle, calls `snapshotVM()` which calls `fcApi()` → spawns curl to the dead socket → curl hangs forever → promise never resolves.

## Observed Behavior

On env `env-2wg7ky` (2026-03-05):

1. VM was restored from snapshot at 02:30 UTC
2. Idle monitor correctly detected <10KB traffic over 2min windows
3. Started attempting snapshots at 02:36 — logged "snapshotting..." every 30s
4. **Never** logged "snapshotted successfully" or "Failed to snapshot"
5. Window duration kept growing (120s → 330s → 660s → 1020s...) confirming the snapshot call never returned
6. 87 zombie curl processes accumulated, all hanging on the dead socket

### Evidence

```bash
# Firecracker process alive
$ pgrep -af 'firecracker.*env-2wg7ky'
215187 /opt/firecracker/bin/firecracker --api-sock /tmp/fc-env-2wg7ky.sock

# Process state: sleeping, 4 threads, 210MB RSS (VM memory)
$ cat /proc/215187/status
State:  S (sleeping)
Threads: 4
VmRSS:  210404 kB

# Socket exists and Firecracker is bound to it
$ ls -la /tmp/fc-env-2wg7ky.sock
srwxr-xr-x 1 root root 0 Mar  5 02:30 /tmp/fc-env-2wg7ky.sock

# But NOT accepting connections (Recv-Q = pending unaccepted connections)
$ ss -xl | grep fc-env-2wg7ky
u_str LISTEN 113    4096    /tmp/fc-env-2wg7ky.sock 567321    * 0

# API call times out (exit code 28 = curl timeout)
$ curl --unix-socket /tmp/fc-env-2wg7ky.sock -s -m 5 http://localhost/vm
# (no output, exit 28)

# 87 zombie curl processes hanging
$ pgrep -af 'curl.*fc-env-2wg7ky'
216256 curl ... -d {"action_type":"SendCtrlAltDel"} http://localhost/actions
217491 curl ... -d {"state":"Paused"} http://localhost/vm
217518 curl ... -d {"state":"Paused"} http://localhost/vm
# ... 84 more
```

### Idle monitor logs

```
[idle-monitor] VM env-2wg7ky transferred only 272 bytes in 330s (threshold: 10240), snapshotting...
[idle-monitor] VM env-2wg7ky transferred only 272 bytes in 360s (threshold: 10240), snapshotting...
[idle-monitor] VM env-2wg7ky transferred only 272 bytes in 390s (threshold: 10240), snapshotting...
# ... repeats every 30s, window duration keeps growing, no success/failure logged
```

## Root Cause Analysis

The Firecracker API socket is bound and listening but the API thread is not calling `accept()`. Connections queue up in the kernel backlog (up to 4096) but are never processed. This means the API event loop is stuck/deadlocked.

**Timeline:**
1. VM restored via `restoreVM()` — API works during restore (used for `snapshot/load` + `PATCH /vm Resumed`)
2. At some point after restore, the API thread stops processing
3. First hung call was `SendCtrlAltDel` (PID 216256), suggesting something tried `stopVM()` before the idle monitor kicked in
4. All subsequent `PATCH /vm Paused` calls from idle monitor also hang

**Not the AMD TSC bug**: Host is ARM (Graviton), not AMD. [Firecracker #4099](https://github.com/firecracker-microvm/firecracker/issues/4099) describes a similar-sounding issue (processes stuck after resume) but is specific to AMD CPUs and affects guest processes, not the host-side API.

**Firecracker docs say re-snapshot is supported**: The [snapshot docs](https://github.com/firecracker-microvm/firecracker/blob/main/docs/snapshotting/snapshot-support.md) describe restore→resume→pause→snapshot as a valid workflow. The docs mention re-enabling `track_dirty_pages` for diff snapshots after restore, implying re-snapshotting is expected.

## Secondary Issues (caused by primary)

### 1. `fcApi()` has no curl timeout
`control-plane/services/firecracker.ts` line ~90 — the curl call has no `-m` (max time) flag. If the socket is dead, curl hangs forever and the promise never resolves.

### 2. Idle monitor has no concurrency guard
`control-plane/services/idle-monitor.ts` — `pollOnce()` is called every 30s via `setInterval` without waiting for the previous call to complete. If `snapshotVM()` hangs, the next poll spawns another hanging `snapshotVM()` for the same env. This caused 87 zombie curl processes.

### 3. No error = no recovery
Since the promise never resolves or rejects, the idle monitor never logs an error and never cleans up. The `trafficMap` entry is never deleted, so the window duration grows unbounded and it retries forever.

## Fixes Needed

### Immediate (prevents zombie accumulation)

1. **Add `-m 30` timeout to `fcApi` curl calls** in `firecracker.ts`
   - All `fcApi` calls should have a max timeout so they fail instead of hanging
   - `-m 30` (30 seconds) is reasonable for any Firecracker API call

2. **Add per-env snapshot lock in idle monitor** in `idle-monitor.ts`
   - Track a `snapshotting: boolean` per env
   - Skip snapshot attempt if one is already in-flight
   - On failure, reset the window and back off

3. **Reset window on snapshot failure** in `idle-monitor.ts`
   - Currently on failure, the window is not reset, so it retries every 30s
   - Should reset `windowStart` and `windowBytes` in the catch block

### Medium-term (handle the dead API)

4. **Detect dead API and fall back to process kill**
   - If `fcApi` times out for a Pause call, fall back to `SIGTERM` on the Firecracker process
   - This won't create a snapshot (VM state is lost) but at least frees resources
   - Could mark status as `stopped` instead of `snapshotted`

5. **Probe API health before attempting snapshot**
   - Quick `GET /` or `GET /vm` with a short timeout before trying to pause
   - If API is dead, skip the snapshot and fall back to kill

### Long-term (fix the actual issue)

6. **Upgrade Firecracker** — ~~try v1.11+ to see if the API freeze is fixed~~ **DONE: Upgraded to v1.14.2, which fixes the issue.** Tested triple snapshot→restore→re-snapshot cycle successfully. Likely fixed by v1.14.0's "Fixed watchdog soft lockup on restored snapshots via KVM_KVMCLOCK_CTRL ioctl call" or general snapshot stability improvements (snapshots moved from "developer preview" to GA in v1.13.0).
7. **File upstream bug** — Not needed, fixed by upgrade.
8. **Alternative snapshot approach** — Not needed, fixed by upgrade.

## How to Reproduce

1. Create a VM via `POST /envs`
2. Wait for idle monitor to snapshot it (or trigger manually)
3. Restore from snapshot (visit the env URL or open terminal in dashboard)
4. Wait — at some point the API becomes unresponsive
5. Try: `curl --unix-socket /tmp/fc-{slug}.sock -s -m 5 http://localhost/vm`
6. Observe: curl times out, `ss -xl` shows growing Recv-Q on the socket

## Related Links

- [Firecracker Snapshot Docs](https://github.com/firecracker-microvm/firecracker/blob/main/docs/snapshotting/snapshot-support.md)
- [#4099 — Processes get stuck after resuming VM from snapshot](https://github.com/firecracker-microvm/firecracker/issues/4099)
- [Firecracker CHANGELOG](https://github.com/firecracker-microvm/firecracker/blob/main/CHANGELOG.md)
