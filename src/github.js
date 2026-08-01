/**
 * GitHub REST API helpers (works with github.com and Enterprise via apiBase).
 */

/** Parse "owner/repo" from common git remote URL shapes. */
export function parseGitHubSlug(remoteUrl) {
  if (!remoteUrl) return null;
  const m =
    remoteUrl.match(/github[^/:]*[:/]([^/]+)\/([^/]+?)(?:\.git)?$/) ||
    remoteUrl.match(/^([^/\s]+)\/([^/\s]+?)(?:\.git)?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

async function ghFetch(apiBase, path, { token, method = "GET", body } = {}) {
  const res = await fetch(`${apiBase.replace(/\/$/, "")}${path}`, {
    method,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-github-api-version": "2022-11-28",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON body */
  }
  return { status: res.status, json, text };
}

/**
 * Create a pull request. If one already exists for the head branch
 * (GitHub answers 422), look it up and return it instead of failing.
 */
export async function createPullRequest({ apiBase, token, slug, title, body, head, base }) {
  const created = await ghFetch(apiBase, `/repos/${slug}/pulls`, {
    token,
    method: "POST",
    body: { title, body: body ?? "", head, base },
  });

  if (created.status === 201) {
    const pr = created.json;
    return { existed: false, number: pr.number, url: pr.html_url, title: pr.title, state: pr.state };
  }

  if (created.status === 422) {
    const owner = slug.split("/")[0];
    const existing = await ghFetch(
      apiBase,
      `/repos/${slug}/pulls?head=${encodeURIComponent(`${owner}:${head}`)}&state=open`,
      { token }
    );
    const pr = existing.json?.[0];
    if (pr) {
      return { existed: true, number: pr.number, url: pr.html_url, title: pr.title, state: pr.state };
    }
    const validation = created.json?.errors?.map((e) => e.message).join("; ");
    throw new Error(`GitHub 拒绝了 PR 创建: ${validation || created.text.slice(0, 300)}`);
  }

  throw new Error(
    `GitHub API HTTP ${created.status}: ${created.json?.message ?? created.text.slice(0, 300)}`
  );
}
