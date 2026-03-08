#!/bin/bash
# NumaVM — Ubuntu distro profile
#
# Implements the distro interface for build-rootfs.sh:
#   distro_bootstrap, distro_install_packages, distro_install_node,
#   distro_create_user, distro_cleanup, distro_sftp_path, distro_version_string
#
# Requires: debootstrap installed on the host

UBUNTU_VERSION="${UBUNTU_VERSION:-24.04}"
UBUNTU_CODENAME="${UBUNTU_CODENAME:-noble}"

# Use ports.ubuntu.com for ARM64, archive.ubuntu.com for x86_64
_ubuntu_mirror() {
  local arch
  arch="$(uname -m)"
  if [ "$arch" = "aarch64" ] || [ "$arch" = "arm64" ]; then
    echo "http://ports.ubuntu.com/ubuntu-ports"
  else
    echo "http://archive.ubuntu.com/ubuntu"
  fi
}

distro_version_string() {
  echo "${UBUNTU_VERSION}"
}

distro_bootstrap() {
  local mount="$1"
  local mirror
  mirror="$(_ubuntu_mirror)"

  if ! command -v debootstrap &>/dev/null; then
    echo "ERROR: debootstrap is required to build Ubuntu rootfs" >&2
    echo "  Install with: apt-get install debootstrap" >&2
    exit 1
  fi

  echo "Bootstrapping Ubuntu ${UBUNTU_VERSION} (${UBUNTU_CODENAME})..."
  debootstrap --variant=minbase "${UBUNTU_CODENAME}" "${mount}" "${mirror}"

  # Set up resolv.conf for package installation
  cp /etc/resolv.conf "${mount}/etc/resolv.conf"
}

distro_install_packages() {
  local mount="$1"
  local mirror
  mirror="$(_ubuntu_mirror)"

  echo "Installing packages..."
  # Configure apt sources
  cat > "${mount}/etc/apt/sources.list" <<EOF
deb ${mirror} ${UBUNTU_CODENAME} main restricted universe
deb ${mirror} ${UBUNTU_CODENAME}-updates main restricted universe
deb ${mirror} ${UBUNTU_CODENAME}-security main restricted universe
EOF

  chroot "${mount}" apt-get update

  # Prevent interactive prompts
  chroot "${mount}" env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    openssh-server \
    git tmux \
    build-essential \
    curl wget jq \
    python3 python3-pip \
    socat \
    e2fsprogs \
    iptables \
    iproute2 \
    iputils-ping \
    procps \
    sudo \
    ca-certificates \
    gnupg
}

distro_install_node() {
  local mount="$1"

  echo "Installing Node.js via NodeSource..."
  # Install NodeSource GPG key and repo
  chroot "${mount}" bash -c 'curl -fsSL https://deb.nodesource.com/setup_22.x | bash -'
  chroot "${mount}" env DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs
}

distro_create_user() {
  local mount="$1"

  echo "Setting up dev user..."
  chroot "${mount}" useradd -m -s /bin/bash dev
  chroot "${mount}" passwd -d dev
  chroot "${mount}" sh -c 'echo "dev ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers'
  mkdir -p "${mount}/home/dev/.ssh"
  chmod 700 "${mount}/home/dev/.ssh"
  chroot "${mount}" chown -R dev:dev /home/dev
}

distro_sftp_path() {
  echo "/usr/lib/openssh/sftp-server"
}

distro_cleanup() {
  local mount="$1"

  echo "Cleaning up Ubuntu rootfs..."
  chroot "${mount}" apt-get clean
  rm -rf "${mount}/var/lib/apt/lists/"*
}
