#!/bin/bash
# NumaVM Setup — networking, hostname, swap, SSH keys
# Runs as a oneshot systemd service before ssh and numavm-app.
set -e

# --- Parse kernel cmdline ---
source /opt/numavm/parse-cmdline.sh

VM_IP="${DM_ip:-172.16.0.2}"
GATEWAY="${DM_gateway:-172.16.0.1}"
DNS="${DM_dns:-8.8.8.8}"

# --- Hostname ---
ENV_NAME=""
if [ -n "${DM_env_name:-}" ]; then
  ENV_NAME=$(echo "${DM_env_name}" | base64 -d 2>/dev/null || echo "")
fi
# Sanitize for hostname: lowercase, replace non-alnum with hyphens, collapse, trim
HOSTNAME=$(echo "${ENV_NAME:-numavm}" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g; s/--*/-/g; s/^-//; s/-$//')
[ -z "${HOSTNAME}" ] && HOSTNAME="numavm"
# Truncate to 63 chars (max hostname length)
HOSTNAME="${HOSTNAME:0:63}"

hostname "${HOSTNAME}"
echo "${HOSTNAME}" > /etc/hostname
# Ensure hostname resolves
if ! grep -q "${HOSTNAME}" /etc/hosts 2>/dev/null; then
  echo "127.0.0.1 ${HOSTNAME}" >> /etc/hosts
fi

# --- Networking ---
ip link set lo up 2>/dev/null || true

ip addr add "${VM_IP}/16" dev eth0 2>/dev/null || true
ip link set eth0 up 2>/dev/null || true
ip route add default via "${GATEWAY}" 2>/dev/null || true

# IPv6 (only if dm.ipv6 was passed)
if [ -n "${DM_ipv6:-}" ]; then
  IPV6_PREFIX_LEN="${DM_ipv6_prefix_len:-64}"
  ip -6 addr add "${DM_ipv6}/${IPV6_PREFIX_LEN}" dev eth0 2>/dev/null || true
  IPV6_GW=$(echo "${DM_ipv6}" | sed 's/::[0-9a-fA-F]*$/::1/')
  ip -6 route add default via "${IPV6_GW}" 2>/dev/null || true
fi

# DNS
echo "nameserver ${DNS}" > /etc/resolv.conf
echo "nameserver 8.8.4.4" >> /etc/resolv.conf

# --- Swap ---
if [ -f /swapfile ]; then
  swapon /swapfile 2>/dev/null || true
fi

# --- SSH Setup ---
mkdir -p /home/dev/.ssh
chmod 700 /home/dev/.ssh
chown dev:dev /home/dev/.ssh

if [ -n "${DM_ssh_keys:-}" ]; then
  echo "${DM_ssh_keys}" | base64 -d > /home/dev/.ssh/authorized_keys 2>/dev/null || {
    echo "${DM_ssh_keys}" > /home/dev/.ssh/authorized_keys
  }
fi

if [ -n "${DM_internal_ssh_key:-}" ]; then
  [ -s /home/dev/.ssh/authorized_keys ] && printf '\n' >> /home/dev/.ssh/authorized_keys
  echo "${DM_internal_ssh_key}" | base64 -d >> /home/dev/.ssh/authorized_keys 2>/dev/null || {
    echo "${DM_internal_ssh_key}" >> /home/dev/.ssh/authorized_keys
  }
fi

if [ -f /home/dev/.ssh/authorized_keys ]; then
  chmod 600 /home/dev/.ssh/authorized_keys
  chown dev:dev /home/dev/.ssh/authorized_keys
fi

mkdir -p /run/sshd
