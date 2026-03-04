#!/bin/bash
set -euo pipefail

# DeployMagi — Host Setup for Firecracker
# Run once on a bare-metal Linux server with /dev/kvm.
#
# Usage: sudo ./setup-host.sh
#
# This script:
#   1. Downloads Firecracker + jailer binaries (pinned version)
#   2. Downloads a compatible Linux kernel (vmlinux)
#   3. Ensures /dev/kvm is accessible
#   4. Creates a bridge interface (br0) for VM networking
#   5. Configures NAT (iptables MASQUERADE) for outbound VM traffic
#   6. Installs helper scripts for TAP device management

FC_VERSION="${FC_VERSION:-1.10.1}"
ARCH="$(uname -m)"
INSTALL_DIR="${INSTALL_DIR:-/opt/firecracker}"
KERNEL_DIR="${INSTALL_DIR}/kernel"
DATA_DIR="${DATA_DIR:-/data/envs}"
BRIDGE_IF="br0"
BRIDGE_SUBNET="172.16.0.0/16"
BRIDGE_IP="172.16.0.1/16"

echo "=== DeployMagi Host Setup ==="
echo "Firecracker version: ${FC_VERSION}"
echo "Architecture: ${ARCH}"
echo "Install dir: ${INSTALL_DIR}"
echo ""

# --- Check prerequisites ---

if [ "$(id -u)" -ne 0 ]; then
  echo "ERROR: Must run as root (sudo)" >&2
  exit 1
fi

if [ ! -e /dev/kvm ]; then
  echo "ERROR: /dev/kvm not found. KVM is required for Firecracker." >&2
  echo "  Ensure your CPU supports hardware virtualization and it's enabled in BIOS." >&2
  exit 1
fi

# --- 1. Download Firecracker binaries ---

mkdir -p "${INSTALL_DIR}/bin"

if [ -f "${INSTALL_DIR}/bin/firecracker" ]; then
  CURRENT_VERSION=$("${INSTALL_DIR}/bin/firecracker" --version 2>/dev/null | head -1 | awk '{print $2}' || echo "unknown")
  echo "Firecracker already installed: ${CURRENT_VERSION}"
else
  echo "Downloading Firecracker v${FC_VERSION}..."
  FC_URL="https://github.com/firecracker-microvm/firecracker/releases/download/v${FC_VERSION}/firecracker-v${FC_VERSION}-${ARCH}.tgz"
  TMPDIR=$(mktemp -d)
  curl -fsSL "${FC_URL}" -o "${TMPDIR}/fc.tgz"
  tar -xzf "${TMPDIR}/fc.tgz" -C "${TMPDIR}"

  # Binaries are in release-v{version}-{arch}/
  FC_DIR=$(find "${TMPDIR}" -type d -name "release-*" | head -1)
  if [ -z "${FC_DIR}" ]; then
    # Fallback: binaries may be at top level
    FC_DIR="${TMPDIR}"
  fi

  cp "${FC_DIR}/firecracker-v${FC_VERSION}-${ARCH}" "${INSTALL_DIR}/bin/firecracker"
  cp "${FC_DIR}/jailer-v${FC_VERSION}-${ARCH}" "${INSTALL_DIR}/bin/jailer"
  chmod +x "${INSTALL_DIR}/bin/firecracker" "${INSTALL_DIR}/bin/jailer"
  rm -rf "${TMPDIR}"

  echo "Installed firecracker and jailer to ${INSTALL_DIR}/bin/"
fi

# Symlink to /usr/local/bin for PATH access
ln -sf "${INSTALL_DIR}/bin/firecracker" /usr/local/bin/firecracker
ln -sf "${INSTALL_DIR}/bin/jailer" /usr/local/bin/jailer

# --- 2. Download Linux kernel ---

mkdir -p "${KERNEL_DIR}"

if [ -f "${KERNEL_DIR}/vmlinux" ]; then
  echo "Kernel already exists at ${KERNEL_DIR}/vmlinux"
else
  echo "Downloading Firecracker-compatible kernel..."
  # Firecracker provides pre-built kernels via their CI
  KERNEL_URL="https://s3.amazonaws.com/spec.ccfc.min/firecracker-ci/v1.10/${ARCH}/vmlinux-6.1"
  curl -fsSL "${KERNEL_URL}" -o "${KERNEL_DIR}/vmlinux" || {
    echo "Failed to download from Firecracker CI. Trying alternative..."
    # Alternative: use a known-good kernel from Firecracker releases
    KERNEL_URL="https://s3.amazonaws.com/spec.ccfc.min/img/quickstart_guide/${ARCH}/kernels/vmlinux.bin"
    curl -fsSL "${KERNEL_URL}" -o "${KERNEL_DIR}/vmlinux"
  }
  echo "Kernel downloaded to ${KERNEL_DIR}/vmlinux"
fi

# --- 3. Ensure /dev/kvm is accessible ---

echo "Configuring /dev/kvm access..."

# Allow the deploymagi user/group to access KVM
if getent group kvm > /dev/null 2>&1; then
  chmod 660 /dev/kvm
  chgrp kvm /dev/kvm
  echo "  /dev/kvm is accessible by 'kvm' group"
  echo "  Add your service user to the kvm group: usermod -aG kvm <username>"
else
  chmod 666 /dev/kvm
  echo "  /dev/kvm set to world-readable (no kvm group found)"
fi

# --- 4. Create bridge interface ---

echo "Setting up bridge interface ${BRIDGE_IF}..."

if ip link show "${BRIDGE_IF}" &>/dev/null; then
  echo "  Bridge ${BRIDGE_IF} already exists"
else
  ip link add name "${BRIDGE_IF}" type bridge
  ip addr add "${BRIDGE_IP}" dev "${BRIDGE_IF}"
  ip link set "${BRIDGE_IF}" up
  echo "  Created bridge ${BRIDGE_IF} with IP ${BRIDGE_IP}"
fi

# --- 5. Configure NAT ---

echo "Configuring iptables NAT..."

# Get default outbound interface
DEFAULT_IF=$(ip route | grep "^default" | awk '{print $5}' | head -1)
if [ -z "${DEFAULT_IF}" ]; then
  echo "WARNING: Could not determine default network interface for NAT" >&2
  DEFAULT_IF="eth0"
fi

# Enable IP forwarding + route_localnet (needed for localhost DNAT to VMs)
sysctl -w net.ipv4.ip_forward=1 > /dev/null
sysctl -w net.ipv4.conf.all.route_localnet=1 > /dev/null
cat > /etc/sysctl.d/99-deploymagi.conf <<EOF
net.ipv4.ip_forward=1
net.ipv4.conf.all.route_localnet=1
EOF

# Add MASQUERADE rule for localhost->VM traffic (Caddy connects via localhost DNAT)
if ! iptables -t nat -C POSTROUTING -s 127.0.0.1 -d "${BRIDGE_SUBNET}" -j MASQUERADE 2>/dev/null; then
  iptables -t nat -A POSTROUTING -s 127.0.0.1 -d "${BRIDGE_SUBNET}" -j MASQUERADE
  echo "  Added localhost MASQUERADE rule for ${BRIDGE_SUBNET}"
else
  echo "  Localhost MASQUERADE rule already exists"
fi

# Add MASQUERADE rule (idempotent)
if ! iptables -t nat -C POSTROUTING -s "${BRIDGE_SUBNET}" -o "${DEFAULT_IF}" -j MASQUERADE 2>/dev/null; then
  iptables -t nat -A POSTROUTING -s "${BRIDGE_SUBNET}" -o "${DEFAULT_IF}" -j MASQUERADE
  echo "  Added MASQUERADE rule for ${BRIDGE_SUBNET} via ${DEFAULT_IF}"
else
  echo "  MASQUERADE rule already exists"
fi

# Allow forwarding between bridge and external
if ! iptables -C FORWARD -i "${BRIDGE_IF}" -o "${DEFAULT_IF}" -j ACCEPT 2>/dev/null; then
  iptables -A FORWARD -i "${BRIDGE_IF}" -o "${DEFAULT_IF}" -j ACCEPT
  iptables -A FORWARD -i "${DEFAULT_IF}" -o "${BRIDGE_IF}" -m state --state RELATED,ESTABLISHED -j ACCEPT
fi

# --- 6. Install TAP helper scripts ---

echo "Installing TAP device helper scripts..."

cat > "${INSTALL_DIR}/bin/create-tap" <<'TAPSCRIPT'
#!/bin/bash
# Usage: create-tap <tap-name> <vm-ip>
# Creates a TAP device, attaches it to br0, and assigns an IP to the VM.
set -euo pipefail

TAP_NAME="$1"
VM_IP="$2"
BRIDGE_IF="${BRIDGE_IF:-br0}"

if ip link show "$TAP_NAME" &>/dev/null; then
  ip link delete "$TAP_NAME"
fi

ip tuntap add dev "$TAP_NAME" mode tap
ip link set "$TAP_NAME" master "$BRIDGE_IF"
ip link set "$TAP_NAME" up

echo "Created TAP $TAP_NAME attached to $BRIDGE_IF (VM IP: $VM_IP)"
TAPSCRIPT
chmod +x "${INSTALL_DIR}/bin/create-tap"

cat > "${INSTALL_DIR}/bin/destroy-tap" <<'TAPSCRIPT'
#!/bin/bash
# Usage: destroy-tap <tap-name>
set -euo pipefail

TAP_NAME="$1"

if ip link show "$TAP_NAME" &>/dev/null; then
  ip link delete "$TAP_NAME"
  echo "Destroyed TAP $TAP_NAME"
fi
TAPSCRIPT
chmod +x "${INSTALL_DIR}/bin/destroy-tap"

cat > "${INSTALL_DIR}/bin/add-dnat" <<'TAPSCRIPT'
#!/bin/bash
# Usage: add-dnat <host-port> <vm-ip> <vm-port> [protocol]
# Adds iptables DNAT rules for port forwarding from host to VM.
set -euo pipefail

HOST_PORT="$1"
VM_IP="$2"
VM_PORT="$3"
PROTO="${4:-tcp}"

iptables -t nat -A PREROUTING -p "$PROTO" --dport "$HOST_PORT" -j DNAT --to-destination "${VM_IP}:${VM_PORT}"
iptables -t nat -A OUTPUT -p "$PROTO" -d 127.0.0.1 --dport "$HOST_PORT" -j DNAT --to-destination "${VM_IP}:${VM_PORT}"
echo "DNAT: host:${HOST_PORT} -> ${VM_IP}:${VM_PORT} (${PROTO})"
TAPSCRIPT
chmod +x "${INSTALL_DIR}/bin/add-dnat"

cat > "${INSTALL_DIR}/bin/remove-dnat" <<'TAPSCRIPT'
#!/bin/bash
# Usage: remove-dnat <host-port> <vm-ip> <vm-port> [protocol]
set -euo pipefail

HOST_PORT="$1"
VM_IP="$2"
VM_PORT="$3"
PROTO="${4:-tcp}"

iptables -t nat -D PREROUTING -p "$PROTO" --dport "$HOST_PORT" -j DNAT --to-destination "${VM_IP}:${VM_PORT}" 2>/dev/null || true
iptables -t nat -D OUTPUT -p "$PROTO" -d 127.0.0.1 --dport "$HOST_PORT" -j DNAT --to-destination "${VM_IP}:${VM_PORT}" 2>/dev/null || true
echo "Removed DNAT: host:${HOST_PORT} -> ${VM_IP}:${VM_PORT} (${PROTO})"
TAPSCRIPT
chmod +x "${INSTALL_DIR}/bin/remove-dnat"

# --- 7. Create data directories ---

mkdir -p "${DATA_DIR}"
echo "Data directory: ${DATA_DIR}"

# --- 8. Create systemd service for bridge persistence (optional) ---

cat > /etc/systemd/system/deploymagi-bridge.service <<EOF
[Unit]
Description=DeployMagi Bridge Interface
After=network.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/bash -c 'ip link show ${BRIDGE_IF} &>/dev/null || (ip link add name ${BRIDGE_IF} type bridge && ip addr add ${BRIDGE_IP} dev ${BRIDGE_IF} && ip link set ${BRIDGE_IF} up)'
ExecStop=/bin/bash -c 'ip link delete ${BRIDGE_IF} 2>/dev/null || true'

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable deploymagi-bridge.service 2>/dev/null || true

echo ""
echo "=== Setup Complete ==="
echo ""
echo "Installed:"
echo "  - Firecracker:    ${INSTALL_DIR}/bin/firecracker"
echo "  - Jailer:         ${INSTALL_DIR}/bin/jailer"
echo "  - Kernel:         ${KERNEL_DIR}/vmlinux"
echo "  - Bridge:         ${BRIDGE_IF} (${BRIDGE_IP})"
echo "  - TAP helpers:    ${INSTALL_DIR}/bin/{create,destroy}-tap"
echo "  - DNAT helpers:   ${INSTALL_DIR}/bin/{add,remove}-dnat"
echo "  - Data dir:       ${DATA_DIR}"
echo ""
echo "Next steps:"
echo "  1. Build the rootfs:  cd ../vm && sudo ./build-rootfs.sh"
echo "  2. Test a VM manually before wiring up the control plane"
echo "  3. Update .env with FC_INSTALL_DIR=${INSTALL_DIR}"
