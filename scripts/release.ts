/**
 * Builds a release package locally (icons included) and optionally publishes it as a GitHub
 * Release. The repository's deploy workflow then publishes the package to GitHub Pages.
 *
 * Usage:
 *   pnpm release                      build + zip only → release/mitigation-monitoring-v<version>.zip
 *   pnpm release --publish            also create GitHub Release v<version> (needs `gh`)
 *   pnpm release --publish --repo owner/name
 *                                     target another repo; defaults to RELEASE_REPO, then the current repo
 *
 * Icons come from the local game unpack (FFXIV_ICON_DIR), which is why this runs locally and
 * not in CI.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const publish = args.includes("--publish");
const repoArg = args[args.indexOf("--repo") + 1];
const repo = args.includes("--repo") ? repoArg : process.env.RELEASE_REPO;

const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string };
const tag = `v${version}`;
const releaseDir = join(root, "release");
const zipPath = join(releaseDir, `mitigation-monitoring-${tag}.zip`);

function run(cmd: string, cmdArgs: string[], cwd = root) {
  console.log(`\n> ${cmd} ${cmdArgs.join(" ")}`);
  const result = spawnSync(cmd, cmdArgs, { cwd, stdio: "inherit", shell: process.platform === "win32" });
  if (result.status !== 0) throw new Error(`${cmd} failed with exit code ${result.status}`);
}

function zipDirectory(dir: string, out: string) {
  // Windows 10+ ships bsdtar, which writes zip archives with -a; elsewhere use `zip`.
  if (process.platform === "win32") {
    execFileSync("C:\\Windows\\System32\\tar.exe", ["-a", "-c", "-f", out, "-C", dir, "."], { stdio: "inherit" });
  } else {
    execFileSync("zip", ["-qr", out, "."], { cwd: dir, stdio: "inherit" });
  }
}

run("pnpm", ["copy-icons"]);
run("pnpm", ["test"]);
run("pnpm", ["build"]);
// End-to-end checks against the built files, loaded from file:// as the ACT overlay does.
run("node", ["tests/e2e/smoke.e2e.mjs"]);

if (!existsSync(join(root, "dist", "icons"))) throw new Error("dist/icons missing; icons were not packaged");
mkdirSync(releaseDir, { recursive: true });
rmSync(zipPath, { force: true });
zipDirectory(join(root, "dist"), zipPath);
console.log(`\nRelease package: ${zipPath}`);

if (!publish) {
  console.log("Skipped publishing. Re-run with --publish, or upload the zip as a GitHub Release asset manually.");
  process.exit(0);
}

const gh = spawnSync("gh", ["--version"], { shell: process.platform === "win32" });
if (gh.status !== 0) {
  console.error("`gh` CLI not found. Install it (https://cli.github.com) or create the release in the GitHub web UI.");
  process.exit(1);
}
run("gh", [
  "release", "create", tag, zipPath,
  "--title", tag,
  "--notes", `Release ${tag}`,
  ...(repo ? ["--repo", repo] : []),
]);
