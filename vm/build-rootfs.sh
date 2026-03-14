#!/bin/bash
set -euo pipefail
set +H 2>/dev/null || true  # Disable history expansion (prevents \! in heredocs)

# NumaVM — Build Rootfs for Firecracker
#
# Framework that sources distro-specific profiles to build ext4 rootfs images.
# Each VM gets its own copy at creation time; updating base images has no effect
# on existing VMs.
#
# Usage: sudo ./build-rootfs.sh [--distro <name>] [--output-dir <path>]
# Distros: alpine (default), ubuntu
# Requires: root, e2fsprogs, curl
#            + debootstrap (for ubuntu)

# --- Parse arguments ---

DISTRO="alpine"
OUTPUT_DIR="/opt/firecracker/rootfs"
ROOTFS_SIZE_MB="${ROOTFS_SIZE_MB:-4096}"
ARCH="$(uname -m)"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --distro)
      DISTRO="$2"
      shift 2
      ;;
    --output-dir)
      OUTPUT_DIR="$2"
      shift 2
      ;;
    --size)
      ROOTFS_SIZE_MB="$2"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      echo "Usage: sudo ./build-rootfs.sh [--distro <name>] [--output-dir <path>] [--size <mb>]" >&2
      exit 1
      ;;
  esac
done

export ARCH

# --- Validate distro profile ---

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DISTRO_PROFILE="${SCRIPT_DIR}/distros/${DISTRO}.sh"

if [ ! -f "${DISTRO_PROFILE}" ]; then
  echo "ERROR: Unknown distro '${DISTRO}'. Available:" >&2
  ls "${SCRIPT_DIR}/distros/"*.sh 2>/dev/null | xargs -I{} basename {} .sh | sed 's/^/  /' >&2
  exit 1
fi

# Source the distro profile (defines distro_* functions)
# shellcheck source=/dev/null
source "${DISTRO_PROFILE}"

# --- Version calculation ---

MANIFEST="${OUTPUT_DIR}/manifest.json"
VERSION=1

if [ -f "${MANIFEST}" ]; then
  # Find the highest version for this distro and increment
  EXISTING=$(python3 -c "
import json, sys
try:
  m = json.load(open('${MANIFEST}'))
  versions = [i['version'] for i in m.get('images', []) if i['distro'] == '${DISTRO}']
  print(max(versions) if versions else 0)
except: print(0)
" 2>/dev/null || echo "0")
  VERSION=$((EXISTING + 1))
fi

OUTPUT="${OUTPUT_DIR}/${DISTRO}-v${VERSION}.ext4"

echo "=== Building ${DISTRO} Rootfs ==="
echo "Output: ${OUTPUT}"
echo "Version: v${VERSION}"
echo "Size: ${ROOTFS_SIZE_MB}MB"
echo "Arch: ${ARCH}"
echo ""

if [ "$(id -u)" -ne 0 ]; then
  echo "ERROR: Must run as root (sudo)" >&2
  exit 1
fi

# --- Create output directory ---

mkdir -p "${OUTPUT_DIR}"

# --- Working directory ---

WORKDIR=$(mktemp -d)
MOUNTDIR="${WORKDIR}/rootfs"
mkdir -p "${MOUNTDIR}"

cleanup() {
  echo "Cleaning up..."
  umount "${MOUNTDIR}/proc" 2>/dev/null || true
  umount "${MOUNTDIR}/sys" 2>/dev/null || true
  umount "${MOUNTDIR}/dev" 2>/dev/null || true
  umount "${MOUNTDIR}" 2>/dev/null || true
  losetup -D 2>/dev/null || true
  rm -rf "${WORKDIR}"
}
trap cleanup EXIT

# ============================================================
# Phase 1: Create ext4 image (shared)
# ============================================================

echo "Creating ${ROOTFS_SIZE_MB}MB ext4 image..."
dd if=/dev/zero of="${OUTPUT}" bs=1M count="${ROOTFS_SIZE_MB}" status=progress
mkfs.ext4 -F -L numavm-root "${OUTPUT}"

LOOP=$(losetup --find --show "${OUTPUT}")
mount "${LOOP}" "${MOUNTDIR}"

# ============================================================
# Phase 2: Bootstrap (distro-specific)
# ============================================================

distro_bootstrap "${MOUNTDIR}"

# Mount proc/sys/dev for chroot
mount -t proc proc "${MOUNTDIR}/proc"
mount -t sysfs sys "${MOUNTDIR}/sys"
mount --bind /dev "${MOUNTDIR}/dev"

# ============================================================
# Phase 3: Install packages (distro-specific)
# ============================================================

distro_install_packages "${MOUNTDIR}"

# ============================================================
# Phase 4: Install Node.js (distro-specific)
# ============================================================

distro_install_node "${MOUNTDIR}"

# Verify Node.js version
NODE_VERSION=$(chroot "${MOUNTDIR}" node --version 2>/dev/null || echo "none")
echo "Node.js version: ${NODE_VERSION}"

# ============================================================
# Phase 5: Install agent CLIs (shared)
# ============================================================

echo "Installing agent CLIs..."

# Codex CLI
chroot "${MOUNTDIR}" npm install -g @openai/codex || {
  echo "WARNING: Failed to install Codex CLI" >&2
}

# Claude Code CLI
chroot "${MOUNTDIR}" npm install -g @anthropic-ai/claude-code || {
  echo "WARNING: Failed to install Claude Code CLI" >&2
}

# OpenCode
chroot "${MOUNTDIR}" sh -c 'curl -fsSL https://opencode.ai/install | bash' || {
  echo "WARNING: Failed to install OpenCode" >&2
}
# Copy opencode binary to PATH (not symlink — dev user can't access /root/)
if [ -f "${MOUNTDIR}/root/.opencode/bin/opencode" ]; then
  cp "${MOUNTDIR}/root/.opencode/bin/opencode" "${MOUNTDIR}/usr/local/bin/opencode"
  chmod 755 "${MOUNTDIR}/usr/local/bin/opencode"
fi

# PM2 process manager
chroot "${MOUNTDIR}" npm install -g pm2

# ============================================================
# Phase 6: Create user (distro-specific)
# ============================================================

distro_create_user "${MOUNTDIR}"

# ============================================================
# Phase 7: Configure SSH (shared)
# ============================================================

echo "Configuring SSH..."

# Generate host keys
chroot "${MOUNTDIR}" ssh-keygen -A

# Configure sshd — use distro-specific SFTP path
SFTP_PATH=$(distro_sftp_path)

cat > "${MOUNTDIR}/etc/ssh/sshd_config" <<SSHD_CONF
Port 22
PermitRootLogin no
PasswordAuthentication no
PubkeyAuthentication yes
AuthorizedKeysFile .ssh/authorized_keys
PermitUserEnvironment yes
ChallengeResponseAuthentication no
UsePAM no
X11Forwarding no
PrintMotd yes
AcceptEnv LANG LC_*
Subsystem sftp ${SFTP_PATH}
SSHD_CONF

# ============================================================
# Phase 8: Init scripts (distro-specific)
# ============================================================

echo "Configuring init..."

# Create the numavm dir for scripts
mkdir -p "${MOUNTDIR}/opt/numavm"

# Copy BASE_AGENTS.md (used by init scripts to write AGENTS.md into project directories)
mkdir -p "${MOUNTDIR}/etc/numavm"
if [ -f "${SCRIPT_DIR}/BASE_AGENTS.md" ]; then
  cp "${SCRIPT_DIR}/BASE_AGENTS.md" "${MOUNTDIR}/etc/numavm/BASE_AGENTS.md"
  echo "Installed BASE_AGENTS.md to /etc/numavm/BASE_AGENTS.md"
fi

if [ "${DISTRO}" = "alpine" ]; then
  # --- Alpine: custom init as PID 1 (uses OpenRC) ---

  chroot "${MOUNTDIR}" rc-update add sshd default 2>/dev/null || true

  # Create numavm-init (PID 1)
  cat > "${MOUNTDIR}/sbin/numavm-init" <<'INIT'
#!/bin/bash
# NumaVM VM init — executed as PID 1 by the kernel
# See vm/init.sh for the full version with overlayfs + env setup

set -e

# Mount essential filesystems (use mountpoint to skip already-mounted ones)
mountpoint -q /proc  || mount -t proc proc /proc
mountpoint -q /sys   || mount -t sysfs sysfs /sys
mountpoint -q /dev   || mount -t devtmpfs devtmpfs /dev
mkdir -p /dev/pts /dev/shm
mountpoint -q /dev/pts || mount -t devpts devpts /dev/pts
mountpoint -q /dev/shm || mount -t tmpfs tmpfs /dev/shm
mountpoint -q /run     || mount -t tmpfs tmpfs /run
# /tmp stays on the rootfs ext4 volume to avoid eating VM RAM
mkdir -p /tmp && chmod 1777 /tmp

# Parse kernel cmdline for env vars
eval $(cat /proc/cmdline | tr ' ' '\n' | grep '^dm\.' | sed 's/^dm\./export DM_/' | sed 's/=\(.*\)/="\1"/')

# Run the actual init script
if [ -f /opt/numavm/init.sh ]; then
  exec /opt/numavm/init.sh
fi

# Fallback: just start SSH and wait
/usr/sbin/sshd -D &

# Keep PID 1 alive
exec sleep infinity
INIT
  chmod +x "${MOUNTDIR}/sbin/numavm-init"

  # Verify shebang wasn't corrupted (bash history expansion can turn #!/bin/bash into #\!/bin/bash)
  if ! head -1 "${MOUNTDIR}/sbin/numavm-init" | grep -q '^#!/bin/bash$'; then
    echo "ERROR: numavm-init shebang is corrupted: $(head -1 "${MOUNTDIR}/sbin/numavm-init")" >&2
    echo "  This usually happens when the build script is run in an interactive shell." >&2
    echo "  Run with: sudo ./build-rootfs.sh (not 'sudo bash' then paste)" >&2
    exit 1
  fi

  # Copy the actual init script
  if [ -f "${SCRIPT_DIR}/init.sh" ]; then
    cp "${SCRIPT_DIR}/init.sh" "${MOUNTDIR}/opt/numavm/init.sh"
    chmod +x "${MOUNTDIR}/opt/numavm/init.sh"
    echo "Installed init.sh to /opt/numavm/init.sh"
  fi

else
  # --- Ubuntu: systemd as PID 1 ---

  # Copy systemd scripts
  cp "${SCRIPT_DIR}/systemd/parse-cmdline.sh" "${MOUNTDIR}/opt/numavm/parse-cmdline.sh"
  cp "${SCRIPT_DIR}/systemd/setup.sh" "${MOUNTDIR}/opt/numavm/setup.sh"
  cp "${SCRIPT_DIR}/systemd/app.sh" "${MOUNTDIR}/opt/numavm/app.sh"
  chmod +x "${MOUNTDIR}/opt/numavm/parse-cmdline.sh"
  chmod +x "${MOUNTDIR}/opt/numavm/setup.sh"
  chmod +x "${MOUNTDIR}/opt/numavm/app.sh"

  # Install systemd unit files
  cp "${SCRIPT_DIR}/systemd/numavm-setup.service" "${MOUNTDIR}/etc/systemd/system/numavm-setup.service"
  cp "${SCRIPT_DIR}/systemd/numavm-app.service" "${MOUNTDIR}/etc/systemd/system/numavm-app.service"

  # Install ssh.service drop-in for vsock-signal after sshd starts
  mkdir -p "${MOUNTDIR}/etc/systemd/system/ssh.service.d"
  cp "${SCRIPT_DIR}/systemd/numavm-ready.conf" "${MOUNTDIR}/etc/systemd/system/ssh.service.d/numavm-ready.conf"

  # Set default hostname (overridden at boot by setup.sh)
  echo "numavm" > "${MOUNTDIR}/etc/hostname"

  # Enable numavm services + ssh
  chroot "${MOUNTDIR}" systemctl enable numavm-setup.service
  chroot "${MOUNTDIR}" systemctl enable numavm-app.service
  chroot "${MOUNTDIR}" systemctl enable ssh.service

  # Mask unnecessary services for faster boot
  chroot "${MOUNTDIR}" systemctl mask systemd-networkd.service
  chroot "${MOUNTDIR}" systemctl mask systemd-resolved.service
  chroot "${MOUNTDIR}" systemctl mask systemd-timesyncd.service
  chroot "${MOUNTDIR}" systemctl mask tmp.mount

  # Ensure /sbin/init exists (kernel default init path)
  ln -sf /lib/systemd/systemd "${MOUNTDIR}/sbin/init"

  echo "Installed systemd units: numavm-setup, numavm-app, ssh drop-in"
fi

# ============================================================
# Phase 9: MOTD (shared)
# ============================================================

cat > "${MOUNTDIR}/etc/motd" <<'MOTD'
  _   _                     __     ____  __
 | \ | |_   _ _ __ ___   __ \ \   / /  \/  |
 |  \| | | | | '_ ` _ \ / _` \ \ / /| |\/| |
 | |\  | |_| | | | | | | (_| |\ V / | |  | |
 |_| \_|\__,_|_| |_| |_|\__,_| \_/  |_|  |_|

  Your project is in ~/ — run `claude`, `codex`, or `opencode` there.

  Your GitHub SSH keys are pre-configured.
  Set ANTHROPIC_API_KEY or run `claude /login` to authenticate.
MOTD

# ============================================================
# Phase 9.5: Pre-warm OpenCode bun dependencies (shared)
# ============================================================

echo "Pre-warming OpenCode bun runtime..."
# Launch opencode serve briefly as dev user so bun JIT-compiles its runtime.
# Needs /dev/shm and /dev/pts (bun segfaults without them).
mkdir -p "${MOUNTDIR}/dev/shm" "${MOUNTDIR}/dev/pts"
mount -t tmpfs tmpfs "${MOUNTDIR}/dev/shm" 2>/dev/null || true
mount -t devpts devpts "${MOUNTDIR}/dev/pts" 2>/dev/null || true
chroot "${MOUNTDIR}" su -s /bin/sh dev -c 'HOME=/home/dev timeout 30 opencode serve --port 5099 >/dev/null 2>&1; true' || true
umount "${MOUNTDIR}/dev/shm" 2>/dev/null || true
umount "${MOUNTDIR}/dev/pts" 2>/dev/null || true

# ============================================================
# Phase 10: Swap (shared)
# ============================================================

echo "Creating 1GB swap file..."
dd if=/dev/zero of="${MOUNTDIR}/swapfile" bs=1M count=1024 status=progress
chmod 600 "${MOUNTDIR}/swapfile"
mkswap "${MOUNTDIR}/swapfile"

# ============================================================
# Phase 11: Cleanup (distro-specific + shared)
# ============================================================

distro_cleanup "${MOUNTDIR}"

# Remove npm cache (can be 100MB+), but preserve bun JIT cache (.so files in /tmp)
rm -rf "${MOUNTDIR}/root/.npm"
find "${MOUNTDIR}/tmp" -maxdepth 1 ! -name '*.so' ! -name 'tmp' -mindepth 1 -exec rm -rf {} + 2>/dev/null || true

# Remove resolv.conf (will be set at boot)
rm -f "${MOUNTDIR}/etc/resolv.conf"

# ============================================================
# Phase 12: Write manifest (shared)
# ============================================================

echo "Writing manifest..."

# Compute SHA256
umount "${MOUNTDIR}/dev" 2>/dev/null || true
umount "${MOUNTDIR}/sys" 2>/dev/null || true
umount "${MOUNTDIR}/proc" 2>/dev/null || true
umount "${MOUNTDIR}"
losetup -d "${LOOP}" 2>/dev/null || true

SHA256=$(sha256sum "${OUTPUT}" | awk '{print $1}')
SIZE_BYTES=$(stat -c%s "${OUTPUT}" 2>/dev/null || stat -f%z "${OUTPUT}" 2>/dev/null || echo "0")
DISTRO_VERSION=$(distro_version_string)
BUILT_AT=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Read existing manifest or create empty one
if [ -f "${MANIFEST}" ]; then
  MANIFEST_JSON=$(cat "${MANIFEST}")
else
  MANIFEST_JSON='{"images":[]}'
fi

# Append new entry
MANIFEST_JSON=$(python3 -c "
import json, sys
m = json.loads('''${MANIFEST_JSON}''')
m['images'].append({
  'distro': '${DISTRO}',
  'version': ${VERSION},
  'distro_version': '${DISTRO_VERSION}',
  'node_version': '${NODE_VERSION}',
  'built_at': '${BUILT_AT}',
  'sha256': '${SHA256}',
  'size_bytes': ${SIZE_BYTES}
})
print(json.dumps(m, indent=2))
")
echo "${MANIFEST_JSON}" > "${MANIFEST}"

# ============================================================
# Phase 13: Create symlinks (shared)
# ============================================================

echo "Creating symlinks..."

# Latest symlink: alpine.ext4 -> alpine-v1.ext4
ln -sf "${DISTRO}-v${VERSION}.ext4" "${OUTPUT_DIR}/${DISTRO}.ext4"
echo "  ${DISTRO}.ext4 -> ${DISTRO}-v${VERSION}.ext4"

# Backward compat: base.ext4 -> alpine.ext4 (only for alpine, the default)
if [ "${DISTRO}" = "alpine" ]; then
  ln -sf "alpine.ext4" "${OUTPUT_DIR}/base.ext4"
  echo "  base.ext4 -> alpine.ext4"
fi

# Reset trap (cleanup already done)
trap - EXIT

echo ""
echo "=== Rootfs Built Successfully ==="
echo "Distro:  ${DISTRO} v${VERSION}"
echo "Output:  ${OUTPUT}"
echo "Size:    $(du -h "${OUTPUT}" | awk '{print $1}')"
echo "Node.js: ${NODE_VERSION}"
echo "SHA256:  ${SHA256}"
echo ""
echo "Manifest: ${MANIFEST}"
