#!/bin/bash
set -euo pipefail

# NumaVM — Host Setup for Firecracker
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

FC_VERSION="${FC_VERSION:-1.14.2}"
ARCH="$(uname -m)"
INSTALL_DIR="${INSTALL_DIR:-/opt/firecracker}"
KERNEL_DIR="${INSTALL_DIR}/kernel"
DATA_DIR="${DATA_DIR:-/data/envs}"
BRIDGE_IF="br0"
BRIDGE_SUBNET="172.16.0.0/16"
BRIDGE_IP="172.16.0.1/16"

echo "=== NumaVM Host Setup ==="
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
  if [ "${CURRENT_VERSION}" = "${FC_VERSION}" ]; then
    echo "Firecracker v${FC_VERSION} already installed"
  else
    echo "Firecracker upgrade: ${CURRENT_VERSION} -> ${FC_VERSION}"
    rm -f "${INSTALL_DIR}/bin/firecracker" "${INSTALL_DIR}/bin/jailer"
  fi
fi

if [ ! -f "${INSTALL_DIR}/bin/firecracker" ]; then
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
  # Firecracker CI publishes pre-built kernels per minor version
  FC_MINOR="v$(echo ${FC_VERSION} | cut -d. -f1,2)"
  # Find the latest 6.1.x kernel for this Firecracker version
  KERNEL_KEY=$(curl -s "http://spec.ccfc.min.s3.amazonaws.com/?prefix=firecracker-ci/${FC_MINOR}/${ARCH}/vmlinux-6.1&list-type=2" \
    | grep -oP "(?<=<Key>)(firecracker-ci/${FC_MINOR}/${ARCH}/vmlinux-[0-9]+\.[0-9]+\.[0-9]{1,3})(?=</Key>)" \
    | sort -V | tail -1)
  if [ -n "${KERNEL_KEY}" ]; then
    KERNEL_URL="https://s3.amazonaws.com/spec.ccfc.min/${KERNEL_KEY}"
    echo "  Found kernel: ${KERNEL_KEY}"
  else
    echo "  WARNING: Could not find kernel in CI for ${FC_MINOR}/${ARCH}, trying fallback..."
    KERNEL_URL="https://s3.amazonaws.com/spec.ccfc.min/img/quickstart_guide/${ARCH}/kernels/vmlinux.bin"
  fi
  curl -fsSL "${KERNEL_URL}" -o "${KERNEL_DIR}/vmlinux"
  echo "Kernel downloaded to ${KERNEL_DIR}/vmlinux"
fi

# --- 3. Ensure /dev/kvm is accessible ---

echo "Configuring /dev/kvm access..."

# Allow the numavm user/group to access KVM
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
cat > /etc/sysctl.d/99-numavm.conf <<EOF
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

# --- 5b. Optional IPv6 setup (when VM_IPV6_PREFIX or VM_IPV6_POOL_FILE is set) ---

# Determine if IPv6 is needed (either prefix-based or pool-based)
IPV6_ENABLED=false
if [ -n "${VM_IPV6_PREFIX:-}" ] || [ -n "${VM_IPV6_POOL_FILE:-}" ] || [ -n "${VM_IPV6_POOL:-}" ]; then
  IPV6_ENABLED=true
fi

if [ "${IPV6_ENABLED}" = "true" ]; then
  # Default ULA prefix when pool is configured but prefix isn't explicitly set
  if [ -z "${VM_IPV6_PREFIX:-}" ]; then
    VM_IPV6_PREFIX="fd00::"
  fi
  echo "Configuring IPv6 for VMs (ULA prefix: ${VM_IPV6_PREFIX})..."

  # Enable IPv6 forwarding
  sysctl -w net.ipv6.conf.all.forwarding=1 > /dev/null
  echo "net.ipv6.conf.all.forwarding=1" >> /etc/sysctl.d/99-numavm.conf

  # Add ULA gateway address to bridge (fd00::1 or prefix::1)
  IPV6_GW="${VM_IPV6_PREFIX}1"
  if ! ip -6 addr show dev "${BRIDGE_IF}" | grep -q "${IPV6_GW}"; then
    ip -6 addr add "${IPV6_GW}/64" dev "${BRIDGE_IF}"
    echo "  Added ${IPV6_GW}/64 to ${BRIDGE_IF}"
  else
    echo "  ${IPV6_GW}/64 already on ${BRIDGE_IF}"
  fi

  # Enable NDP proxy on bridge (host answers NDP for absent/snapshotted VMs)
  sysctl -w net.ipv6.conf.${BRIDGE_IF}.proxy_ndp=1 > /dev/null
  echo "net.ipv6.conf.${BRIDGE_IF}.proxy_ndp=1" >> /etc/sysctl.d/99-numavm.conf

  # Allow forwarding between bridge and external (IPv6)
  if ! ip6tables -C FORWARD -i "${BRIDGE_IF}" -o "${DEFAULT_IF}" -j ACCEPT 2>/dev/null; then
    ip6tables -A FORWARD -i "${BRIDGE_IF}" -o "${DEFAULT_IF}" -j ACCEPT
    ip6tables -A FORWARD -i "${DEFAULT_IF}" -o "${BRIDGE_IF}" -m state --state RELATED,ESTABLISHED -j ACCEPT
    echo "  Added ip6tables FORWARD rules"
  else
    echo "  ip6tables FORWARD rules already exist"
  fi

  # Load ip6table_nat kernel module (needed for DNAT/SNAT with pool-based allocation)
  if [ -n "${VM_IPV6_POOL_FILE:-}" ] || [ -n "${VM_IPV6_POOL:-}" ]; then
    echo "  Loading ip6table_nat kernel module for pool-based DNAT/SNAT..."
    modprobe ip6table_nat 2>/dev/null || true
    if ! grep -q "ip6table_nat" /etc/modules-load.d/*.conf 2>/dev/null; then
      echo "ip6table_nat" >> /etc/modules-load.d/numavm.conf
    fi

    # Populate pool file from EC2 metadata if not already present
    if [ -n "${VM_IPV6_POOL_FILE:-}" ] && [ ! -f "${VM_IPV6_POOL_FILE}" ]; then
      echo "  Attempting to populate ${VM_IPV6_POOL_FILE} from EC2 metadata..."
      mkdir -p "$(dirname "${VM_IPV6_POOL_FILE}")"
      MAC_ADDR=$(cat /sys/class/net/${DEFAULT_IF}/address 2>/dev/null || echo "")
      if [ -n "${MAC_ADDR}" ]; then
        TOKEN=$(curl -sf -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 21600' 2>/dev/null || echo "")
        if [ -n "${TOKEN}" ]; then
          curl -sf -H "X-aws-ec2-metadata-token: ${TOKEN}" \
            "http://169.254.169.254/latest/meta-data/network/interfaces/macs/${MAC_ADDR}/ipv6s" \
            > "${VM_IPV6_POOL_FILE}" 2>/dev/null || echo "  WARNING: Could not fetch IPv6 addresses from EC2 metadata"
          if [ -s "${VM_IPV6_POOL_FILE}" ]; then
            POOL_COUNT=$(wc -l < "${VM_IPV6_POOL_FILE}")
            echo "  Populated ${VM_IPV6_POOL_FILE} with ${POOL_COUNT} IPv6 addresses"
          fi
        else
          echo "  WARNING: Could not get EC2 metadata token (not running on EC2?)"
        fi
      fi
    fi
  fi
else
  echo "Skipping IPv6 setup (VM_IPV6_PREFIX and VM_IPV6_POOL not set)"
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

cat > "${INSTALL_DIR}/bin/apply-ipv6-sg" <<'SGSCRIPT'
#!/bin/bash
# Usage: apply-ipv6-sg <slug> <vm-ipv6> [proto:port:source ...]
# Creates/flushes a per-VM ip6tables chain and applies security group rules.
# Always allows ICMPv6 and established connections. Default deny.
set -euo pipefail

SLUG="$1"
VM_IPV6="$2"
shift 2

CHAIN="numavm-${SLUG}"

# Create chain (ignore if exists) then flush
ip6tables -N "$CHAIN" 2>/dev/null || true
ip6tables -F "$CHAIN"

# Ensure FORWARD jump exists
ip6tables -C FORWARD -d "$VM_IPV6" -j "$CHAIN" 2>/dev/null || \
  ip6tables -I FORWARD -d "$VM_IPV6" -j "$CHAIN"

# Always allow ICMPv6 (NDP, path MTU)
ip6tables -A "$CHAIN" -p icmpv6 -j ACCEPT

# Allow established/related
ip6tables -A "$CHAIN" -m state --state RELATED,ESTABLISHED -j ACCEPT

# Per-rule ACCEPT entries (format: proto:port:source)
for RULE in "$@"; do
  IFS=: read -r PROTO PORT SOURCE <<< "$RULE"
  ip6tables -A "$CHAIN" -p "$PROTO" --dport "$PORT" -s "${SOURCE:-::/0}" -j ACCEPT
done

# Default deny
ip6tables -A "$CHAIN" -j DROP
echo "Applied IPv6 security group for ${SLUG} (${VM_IPV6}): $# rules"
SGSCRIPT
chmod +x "${INSTALL_DIR}/bin/apply-ipv6-sg"

cat > "${INSTALL_DIR}/bin/remove-ipv6-sg" <<'SGSCRIPT'
#!/bin/bash
# Usage: remove-ipv6-sg <slug> <vm-ipv6>
# Removes a per-VM ip6tables chain.
set -euo pipefail

SLUG="$1"
VM_IPV6="$2"
CHAIN="numavm-${SLUG}"

ip6tables -D FORWARD -d "$VM_IPV6" -j "$CHAIN" 2>/dev/null || true
ip6tables -F "$CHAIN" 2>/dev/null || true
ip6tables -X "$CHAIN" 2>/dev/null || true
echo "Removed IPv6 security group for ${SLUG}"
SGSCRIPT
chmod +x "${INSTALL_DIR}/bin/remove-ipv6-sg"

# --- 7. Install build dependencies for rootfs images ---

echo "Installing rootfs build dependencies..."
if command -v apt-get &>/dev/null; then
  apt-get install -y debootstrap 2>/dev/null || echo "  WARNING: Failed to install debootstrap (needed for Ubuntu rootfs)"
elif command -v yum &>/dev/null; then
  yum install -y debootstrap 2>/dev/null || echo "  WARNING: Failed to install debootstrap (needed for Ubuntu rootfs)"
else
  echo "  NOTE: Install debootstrap manually if you plan to build Ubuntu rootfs images"
fi

# --- 8. Build rootfs images ---

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_ROOTFS="${SCRIPT_DIR}/../vm/build-rootfs.sh"

if [ -x "$BUILD_ROOTFS" ] || [ -f "$BUILD_ROOTFS" ]; then
  echo "Building Alpine rootfs image..."
  bash "$BUILD_ROOTFS" --distro alpine --output-dir "${INSTALL_DIR}/rootfs"

  echo "Building Ubuntu rootfs image..."
  bash "$BUILD_ROOTFS" --distro ubuntu --output-dir "${INSTALL_DIR}/rootfs"
else
  echo "WARNING: build-rootfs.sh not found at ${BUILD_ROOTFS}"
  echo "  You will need to build rootfs images manually."
fi

# --- 9. Create data directories ---

mkdir -p "${DATA_DIR}"
echo "Data directory: ${DATA_DIR}"

# --- 10. Create systemd service for bridge persistence (optional) ---

cat > /etc/systemd/system/numavm-bridge.service <<EOF
[Unit]
Description=NumaVM Bridge Interface
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
systemctl enable numavm-bridge.service 2>/dev/null || true

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
echo "  - IPv6 SG:       ${INSTALL_DIR}/bin/{apply,remove}-ipv6-sg"
echo "  - Data dir:       ${DATA_DIR}"
echo ""
echo "Next steps:"
echo "  1. Test a VM manually before wiring up the control plane"
echo "  2. Update .env with FC_INSTALL_DIR=${INSTALL_DIR}"
