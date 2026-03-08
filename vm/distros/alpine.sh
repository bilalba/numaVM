#!/bin/bash
# NumaVM — Alpine Linux distro profile
#
# Implements the distro interface for build-rootfs.sh:
#   distro_bootstrap, distro_install_packages, distro_install_node,
#   distro_create_user, distro_cleanup, distro_sftp_path, distro_version_string

ALPINE_VERSION="${ALPINE_VERSION:-3.21}"
ALPINE_MIRROR="${ALPINE_MIRROR:-https://dl-cdn.alpinelinux.org/alpine}"

# Map arch for Alpine
case "$ARCH" in
  x86_64) ALPINE_ARCH="x86_64" ;;
  aarch64) ALPINE_ARCH="aarch64" ;;
  *) echo "Unsupported architecture: $ARCH" >&2; exit 1 ;;
esac

distro_version_string() {
  echo "${ALPINE_VERSION}"
}

distro_bootstrap() {
  local mount="$1"

  echo "Bootstrapping Alpine Linux ${ALPINE_VERSION}..."
  MINIROOTFS_URL="${ALPINE_MIRROR}/v${ALPINE_VERSION}/releases/${ALPINE_ARCH}/alpine-minirootfs-${ALPINE_VERSION}.0-${ALPINE_ARCH}.tar.gz"
  echo "Downloading: ${MINIROOTFS_URL}"
  curl -fsSL "${MINIROOTFS_URL}" | tar -xz -C "${mount}"

  # Set up resolv.conf for package installation
  cp /etc/resolv.conf "${mount}/etc/resolv.conf"

  # Configure Alpine repositories (edge for Node.js + matching libssl/libcrypto)
  cat > "${mount}/etc/apk/repositories" <<EOF
${ALPINE_MIRROR}/v${ALPINE_VERSION}/main
${ALPINE_MIRROR}/v${ALPINE_VERSION}/community
${ALPINE_MIRROR}/edge/main
${ALPINE_MIRROR}/edge/community
${ALPINE_MIRROR}/edge/testing
EOF
}

distro_install_packages() {
  local mount="$1"

  echo "Installing packages..."
  chroot "${mount}" apk update

  chroot "${mount}" apk add --no-cache \
    bash coreutils util-linux \
    openrc \
    openssh openssh-server \
    sudo shadow \
    curl wget jq \
    git tmux \
    python3 py3-pip \
    build-base \
    socat \
    e2fsprogs \
    iptables \
    procps
}

distro_install_node() {
  local mount="$1"

  echo "Installing Node.js from Alpine edge..."
  # Must upgrade libssl3/libcrypto3 first to match edge's Node
  chroot "${mount}" apk upgrade --no-cache \
    --repository="${ALPINE_MIRROR}/edge/main" \
    libssl3 libcrypto3
  chroot "${mount}" apk add --no-cache nodejs npm
}

distro_create_user() {
  local mount="$1"

  echo "Setting up dev user..."
  chroot "${mount}" adduser -D -s /bin/bash dev
  # Unlock account — OpenSSH 10+ rejects pubkey auth for locked accounts ("!" in shadow)
  chroot "${mount}" sed -i 's/^dev:!:/dev:*:/' /etc/shadow
  chroot "${mount}" sh -c 'echo "dev ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers'
  mkdir -p "${mount}/home/dev/.ssh"
  chmod 700 "${mount}/home/dev/.ssh"
  chroot "${mount}" chown -R dev:dev /home/dev
}

distro_sftp_path() {
  echo "/usr/lib/ssh/sftp-server"
}

distro_cleanup() {
  local mount="$1"

  echo "Cleaning up Alpine rootfs..."
  rm -rf "${mount}/var/cache/apk/"*
}
