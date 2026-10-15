import * as yaml from "js-yaml";

export interface Dashboard {
  uid: string;
  title: string;
}

/** Returns undefined for files that are not dashboards; throws for dashboards Git Sync cannot sync. */
export function parseDashboard(text: string, path: string): Dashboard | undefined {
  const doc: any = /\.ya?ml$/i.test(path) ? yaml.load(text) : JSON.parse(text);
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return undefined;

  if (doc.kind === "Dashboard") {
    const uid = doc.metadata?.name;
    if (!uid) throw new Error("no metadata.name, so Grafana cannot give it a uid");
    return { uid, title: doc.spec?.title || uid };
  }

  const isClassic = doc.kind === undefined && Array.isArray(doc.panels) && "schemaVersion" in doc;
  if (isClassic) {
    if (!doc.uid) throw new Error("no uid");
    return { uid: doc.uid, title: doc.title || doc.uid };
  }

  return undefined;
}
