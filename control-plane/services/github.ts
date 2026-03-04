import { Octokit } from "octokit";

const octokit = new Octokit({ auth: process.env.GH_PAT });

export async function createRepo(
  name: string,
  isPrivate: boolean
): Promise<{ fullName: string; cloneUrl: string }> {
  try {
    const { data } = await octokit.rest.repos.createForAuthenticatedUser({
      name,
      private: isPrivate,
      auto_init: true,
    });
    return { fullName: data.full_name, cloneUrl: data.clone_url };
  } catch (err: any) {
    // Repo already exists — fetch it
    if (err.status === 422) {
      const { data: user } = await octokit.rest.users.getAuthenticated();
      const { data } = await octokit.rest.repos.get({
        owner: user.login,
        repo: name,
      });
      return { fullName: data.full_name, cloneUrl: data.clone_url };
    }
    throw err;
  }
}

export async function fetchSshKeys(username: string): Promise<string> {
  try {
    const res = await fetch(`https://github.com/${username}.keys`);
    if (!res.ok) return "";
    return (await res.text()).trim();
  } catch {
    return "";
  }
}
