// Renders assets/icon.svg to the 128x128 images/icon.png the Marketplace shows, with headless Chrome or Edge.
//   node scripts/render-icon.mjs [path-to-chrome]
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const candidates = [
  process.argv[2],
  process.env.CHROME,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].filter(Boolean);
const chrome = candidates.find((c) => existsSync(c));
if (!chrome) throw new Error("No Chrome or Edge found. Pass its path as an argument.");

const dir = mkdtempSync(join(tmpdir(), "icon-"));
const html = join(dir, "icon.html");
writeFileSync(html, `<!doctype html><style>html,body{margin:0;background:transparent}</style>${readFileSync("assets/icon.svg", "utf8")}`);
execFileSync(chrome, [
  "--headless=new", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1",
  "--default-background-color=00000000", "--window-size=128,128",
  `--screenshot=${resolve("images/icon.png")}`, pathToFileURL(html).href,
], { stdio: "inherit" });
console.log("Wrote images/icon.png");
