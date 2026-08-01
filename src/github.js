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
export async function listIssues({apiBase,token,slug,state="open"}) {
  const r=await ghFetch(apiBase,`/repos/${slug}/issues?state=${encodeURIComponent(state)}`,{token});
  if(r.status!==200) throw new Error(`GitHub issues HTTP ${r.status}: ${r.json?.message??r.text}`);
  return r.json.filter((item)=>!item.pull_request);
}

export async function listPullRequests({apiBase,token,slug,state="open"}) {
  const r=await ghFetch(apiBase,`/repos/${slug}/pulls?state=${encodeURIComponent(state)}`,{token});
  if(r.status!==200) throw new Error(`GitHub pulls HTTP ${r.status}: ${r.json?.message??r.text}`);
  return r.json;
}

export async function createCheckRun({apiBase,token,slug,name,headSha,status="completed",conclusion="neutral",summary,annotations=[]}) {
  const output={title:name,summary,annotations:annotations.slice(0,50).map((a)=>({path:a.path,start_line:a.startLine??1,end_line:a.endLine??a.startLine??1,annotation_level:a.level??"warning",message:a.message,title:a.title}))};
  const r=await ghFetch(apiBase,`/repos/${slug}/check-runs`,{token,method:"POST",body:{name,head_sha:headSha,status,conclusion,output}});
  if(r.status!==201)throw new Error(`GitHub check run HTTP ${r.status}: ${r.json?.message??r.text}`);return r.json;
}

export async function createPullRequestReview({apiBase,token,slug,number,body,event="COMMENT",comments=[]}) {
  const r=await ghFetch(apiBase,`/repos/${slug}/pulls/${number}/reviews`,{token,method:"POST",body:{body,event,comments:comments.slice(0,100)}});
  if(r.status!==200)throw new Error(`GitHub pull request review HTTP ${r.status}: ${r.json?.message??r.text}`);return r.json;
}

export async function postPullRequestComment({apiBase,token,slug,number,body}) {
  const r=await ghFetch(apiBase,`/repos/${slug}/issues/${number}/comments`,{token,method:"POST",body:{body}});
  if(r.status!==201) throw new Error(`GitHub comment HTTP ${r.status}: ${r.json?.message??r.text}`);
  return r.json;
}

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
