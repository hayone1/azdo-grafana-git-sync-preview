export interface Organization {
  label?: string;
  id: number;
}

export type Change = "added" | "modified" | "deleted";

export interface Row {
  path: string;
  title: string;
  uid: string;
  repository: string;
  relPath: string;
  /** Absent in branch mode, where every dashboard is listed regardless of changes. */
  change?: Change;
}

export interface LinkOptions {
  grafanaUrl: string;
  organizations: Organization[];
  ref: string;
  pullRequestUrl?: string;
  showCurrent: boolean;
  showPreview: boolean;
}

export interface CommentOptions {
  key?: string;
  title: string;
  ref: string;
  withChange?: boolean;
}

export function parseOrganizations(lines: string[]): Organization[] {
  const orgs = lines
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => {
      const i = l.lastIndexOf("=");
      const label = i < 0 ? undefined : l.slice(0, i).trim() || undefined;
      const id = Number(i < 0 ? l : l.slice(i + 1).trim());
      if (!Number.isInteger(id) || id < 1) throw new Error(`Invalid organization '${l}', expected orgId or label=orgId`);
      return { label, id };
    });
  if (orgs.length === 0) throw new Error("At least one organization is required");
  return orgs;
}

export function marker(key: string): string {
  return `<!-- ${key} -->`;
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

export function links(row: Row, o: LinkOptions): string {
  return linkUrls(row, o)
    .map(({ label, urls }) => (label ? `${label}: ` : "") + (urls.map((u) => `[${u.kind}](${u.url})`).join(" · ") || "—"))
    .join("<br>");
}

export interface OrgLinks {
  label?: string;
  urls: { kind: "current" | "preview"; url: string }[];
}

export function linkUrls(row: Row, o: LinkOptions): OrgLinks[] {
  const base = o.grafanaUrl.replace(/\/+$/, "");
  const current = o.showCurrent && row.change !== "added";
  const preview = o.showPreview && row.change !== "deleted";

  return o.organizations.map((org) => {
    const urls: OrgLinks["urls"] = [];
    if (current) urls.push({ kind: "current", url: `${base}/d/${encodeURIComponent(row.uid)}?orgId=${org.id}` });
    if (preview) {
      const q = new URLSearchParams({ ref: o.ref });
      if (o.pullRequestUrl) q.set("pull_request_url", o.pullRequestUrl);
      q.set("orgId", String(org.id));
      urls.push({
        kind: "preview",
        url: `${base}/dashboard/provisioning/${encodeURIComponent(row.repository)}/preview/${encodePath(row.relPath)}?${q}`,
      });
    }
    return { label: org.label ?? (o.organizations.length > 1 ? `org ${org.id}` : undefined), urls };
  });
}

export function buildComment(rows: string[], errors: [string, string][], o: CommentOptions): string {
  const lines = o.key ? [marker(o.key), o.title, ""] : [o.title, ""];
  if (rows.length) {
    if (o.withChange === false) lines.push("| Dashboard | Links |", "|---|---|", ...rows, "");
    else lines.push("| Dashboard | Change | Links |", "|---|---|---|", ...rows, "");
    lines.push(
      `Previews render \`${o.ref}\` without saving anything to Grafana. ` +
        "A new push can take a minute to reach the preview.",
    );
  } else {
    lines.push(o.withChange === false ? "No Git Sync dashboards found." : "No Git Sync dashboard files changed.");
  }
  if (errors.length) {
    lines.push("", "**These files could not be parsed and will fail to sync:**", "");
    lines.push(...errors.map(([path, err]) => `- \`${path}\`: ${err}`));
  }
  return lines.join("\n");
}

export function row(r: Row, o: LinkOptions): string {
  const change = r.change ? ` ${r.change} |` : "";
  return `| **${escapeCell(r.title)}**<br>\`${r.path}\` |${change} ${links(r, o)} |`;
}
