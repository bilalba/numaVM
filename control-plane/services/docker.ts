import Dockerode from "dockerode";

const docker = new Dockerode({
  socketPath: process.env.DOCKER_SOCKET || "/var/run/docker.sock",
});

function getDataDir() {
  return process.env.DATA_DIR || "/data/vms";
}
const envImage = process.env.ENV_IMAGE || "numavm-env";

export interface ContainerStatus {
  running: boolean;
  status: string;
  startedAt: string | null;
}

export interface CreateContainerParams {
  slug: string;
  appPort: number;
  sshPort: number;
  opencodePort: number;
  ghRepo: string;
  ghToken: string;
  sshKeys: string;
  opencodePassword: string;
  openaiApiKey?: string;
}

export async function createAndStartContainer(params: CreateContainerParams): Promise<string> {
  const container = await docker.createContainer({
    name: params.slug,
    Image: envImage,
    Env: [
      `GH_REPO=${params.ghRepo}`,
      `GH_TOKEN=${params.ghToken}`,
      `SSH_AUTHORIZED_KEYS=${params.sshKeys}`,
      `OPENCODE_PASSWORD=${params.opencodePassword}`,
      `OPENAI_API_KEY=${params.openaiApiKey || ""}`,
    ],
    HostConfig: {
      PortBindings: {
        "22/tcp": [{ HostPort: String(params.sshPort) }],
        "4000/tcp": [{ HostPort: String(params.appPort) }],
        "5000/tcp": [{ HostPort: String(params.opencodePort) }],
      },
      Binds: [`${getDataDir()}/${params.slug}:/data`],
      RestartPolicy: { Name: "unless-stopped", MaximumRetryCount: 0 },
    },
  });

  await container.start();
  const info = await container.inspect();
  return info.Id;
}

export async function stopContainer(containerId: string): Promise<void> {
  const container = docker.getContainer(containerId);
  await container.stop();
}

export async function removeContainer(containerId: string): Promise<void> {
  const container = docker.getContainer(containerId);
  await container.remove({ force: true });
}

export async function inspectContainer(containerId: string): Promise<ContainerStatus> {
  const container = docker.getContainer(containerId);
  const info = await container.inspect();
  return {
    running: info.State.Running,
    status: info.State.Status,
    startedAt: info.State.StartedAt || null,
  };
}
