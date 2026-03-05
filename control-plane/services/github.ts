import { Octokit } from "octokit";

export async function createRepo(
  name: string,
  isPrivate: boolean,
  token: string,
): Promise<{ fullName: string; cloneUrl: string }> {
  const octokit = new Octokit({ auth: token });
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

export interface RepoInfo {
  fullName: string;
  name: string;
  owner: string;
  private: boolean;
  updatedAt: string;
}

export async function listRepos(
  token: string,
  opts?: { query?: string; page?: number },
): Promise<{ repos: RepoInfo[]; hasMore: boolean }> {
  const octokit = new Octokit({ auth: token });
  const perPage = 30;
  const page = opts?.page || 1;

  if (opts?.query) {
    const { data } = await octokit.rest.search.repos({
      q: `${opts.query} user:@me`,
      sort: "updated",
      per_page: perPage,
      page,
    });
    return {
      repos: data.items.map((r) => ({
        fullName: r.full_name,
        name: r.name,
        owner: r.owner?.login || "",
        private: r.private,
        updatedAt: r.updated_at || "",
      })),
      hasMore: data.total_count > page * perPage,
    };
  }

  const { data } = await octokit.rest.repos.listForAuthenticatedUser({
    sort: "updated",
    affiliation: "owner,collaborator,organization_member",
    per_page: perPage,
    page,
  });
  return {
    repos: data.map((r) => ({
      fullName: r.full_name,
      name: r.name,
      owner: r.owner.login,
      private: r.private,
      updatedAt: r.updated_at || "",
    })),
    hasMore: data.length === perPage,
  };
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
