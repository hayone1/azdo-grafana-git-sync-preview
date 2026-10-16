import * as yaml from "js-yaml";

export interface Repository {
  path: string;
  name: string;
  /** Branch Grafana syncs, from the manifest. Absent for inline mappings. */
  branch?: string;
}

function normalizePath(path: string): string {
  const trimmed = path.replace(/\\/g, "/").replace(/^\.?\/+|\/+$/g, "");
  return trimmed === "." ? "" : trimmed;
}

function fromManifest(doc: any): Repository | undefined {
  if (!doc || typeof doc !== "object") return undefined;

  if (doc.kind === "Repository" && String(doc.apiVersion ?? "").startsWith("provisioning.grafana.app/")) {
    const spec = doc.spec ?? {};
    const settings = spec[spec.type] ?? spec.git ?? spec.github ?? {};
    return { path: normalizePath(settings.path ?? ""), name: doc.metadata?.name, branch: settings.branch || undefined };
  }

  if (doc.kind === "RepositoryV0Alpha1") {
    const fp = doc.spec?.forProvider ?? {};
    const spec = fp.spec ?? {};
    const settings = spec[spec.type] ?? spec.git ?? spec.github ?? {};
    return { path: normalizePath(settings.path ?? ""), name: fp.metadata?.uid ?? doc.metadata?.name, branch: settings.branch || undefined };
  }

  return undefined;
}

export function parseManifests(text: string, source: string): Repository[] {
  const repos: Repository[] = [];
  for (const doc of yaml.loadAll(text)) {
    const repo = fromManifest(doc);
    if (!repo) continue;
    if (!repo.name) throw new Error(`${source}: Repository manifest has no name`);
    repos.push(repo);
  }
  return repos;
}

export function parseMappings(lines: string[]): Repository[] {
  return lines
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => {
      const i = l.lastIndexOf("=");
      if (i < 0) throw new Error(`Invalid path mapping '${l}', expected folder=repository-name`);
      const name = l.slice(i + 1).trim();
      if (!name) throw new Error(`Path mapping '${l}' has no repository name`);
      return { path: normalizePath(l.slice(0, i).trim()), name };
    });
}

/** Deepest folder wins, so nested Git Sync folders map to the right repository. */
export function findRepository(repos: Repository[], file: string): { repo: Repository; relPath: string } | undefined {
  const sorted = [...repos].sort((a, b) => b.path.length - a.path.length);
  for (const repo of sorted) {
    if (repo.path === "") return { repo, relPath: file };
    if (file.startsWith(repo.path + "/")) return { repo, relPath: file.slice(repo.path.length + 1) };
  }
  return undefined;
}
