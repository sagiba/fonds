import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

// Tests and the processes they spawn never resolve the real per-user data
// directory. HOME and XDG_DATA_HOME point into this worker's temporary home,
// so even a child given a minimal environment that keeps HOME (as the MCP
// SDK's default child environment does) lands there, and an omitted --db and
// the default state directory land in its FONDS_HOME.
const home = mkdtempSync(join(tmpdir(), "fonds-test-home-"));
process.env.HOME = home;
process.env.XDG_DATA_HOME = join(home, ".local", "share");
process.env.FONDS_HOME = join(home, "fonds");
delete process.env.FONDS_STATE_DIR;
delete process.env.FONDS_DATABASE_URL;
if (homedir() !== home) {
  throw new Error("Tests must not resolve the real home directory");
}
