export interface PullRequestContext {
  collectionUri: string;
  project: string;
  repositoryId: string;
  pullRequestId: string;
  token: string;
}

const API = "api-version=7.1";

async function call(ctx: PullRequestContext, method: string, url: string, body?: unknown): Promise<any> {
  const resp = await fetch(url, {
    method,
    // Basic auth with an empty user accepts both System.AccessToken and personal access tokens.
    headers: {
      Authorization: `Basic ${Buffer.from(`:${ctx.token}`).toString("base64")}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    // Azure DevOps answers a token it does not accept with a redirect or an HTML sign-in page.
    redirect: "manual",
  });
  const text = await resp.text();
  const isJson = (resp.headers.get("content-type") ?? "").includes("json");
  if (resp.status === 401 || resp.status === 203 || (resp.status >= 300 && resp.status < 400) || (resp.ok && !isJson)) {
    throw new Error(
      `${method} ${url} failed: ${resp.status}. Azure DevOps did not accept the access token. ` +
        "Check that it is valid and that the build service has Contribute to pull requests on the repository.",
    );
  }
  if (!resp.ok) {
    throw new Error(`${method} ${url} failed: ${resp.status} ${resp.statusText} ${text.slice(0, 1000)}`);
  }
  return text ? JSON.parse(text) : undefined;
}

function threadsUrl(ctx: PullRequestContext): string {
  const base = ctx.collectionUri.endsWith("/") ? ctx.collectionUri : ctx.collectionUri + "/";
  return (
    `${base}${encodeURIComponent(ctx.project)}/_apis/git/repositories/${ctx.repositoryId}` +
    `/pullRequests/${ctx.pullRequestId}/threads`
  );
}

export async function findThread(ctx: PullRequestContext, marker: string): Promise<{ threadId: number; commentId: number } | undefined> {
  const threads = (await call(ctx, "GET", `${threadsUrl(ctx)}?${API}`)).value ?? [];
  for (const thread of threads) {
    const first = (thread.comments ?? [])[0];
    if (first?.content?.includes(marker)) return { threadId: thread.id, commentId: first.id };
  }
  return undefined;
}

export async function updateComment(ctx: PullRequestContext, threadId: number, commentId: number, content: string) {
  await call(ctx, "PATCH", `${threadsUrl(ctx)}/${threadId}/comments/${commentId}?${API}`, { content });
}

export async function createThread(ctx: PullRequestContext, content: string, status: string) {
  await call(ctx, "POST", `${threadsUrl(ctx)}?${API}`, {
    comments: [{ parentCommentId: 0, content, commentType: 1 }],
    status,
  });
}
