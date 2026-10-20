import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { parseEnv } from "node:util";

import { build } from "esbuild";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  prepareEnvironmentFile,
  scheduleSource,
  scheduleSummary,
  setup,
  setupReport,
} from "../../../deploy/neon/setup.mjs";
import { smokeChecks } from "../../../deploy/neon/smoke.mjs";
import { assertGraph, root } from "../../../scripts/build-targets.mjs";
import { parseCollectionSchedule } from "../../../src/runtime/collection-schedule.js";

const required = [
  "FONDS_PUBLIC_ORIGIN=https://fonds.synthetic.invalid",
  "FONDS_NEON_GOOGLE_AUTH_URL=https://ep-synthetic.neonauth.neon.tech/auth",
  "FONDS_GOOGLE_OWNER_EMAIL=owner@synthetic.invalid",
  "FONDS_COLLECTION_CONNECTION_ID=primary",
  "FONDS_COLLECTION_PROVIDER=cal",
].join("\n");

describe("Neon setup env file", () => {
  let directory;
  let path;

  beforeEach(async () => {
    directory = await mkdtemp(resolve(tmpdir(), "fonds-neon-setup-"));
    path = resolve(directory, "neon.env");
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("generates missing secrets once and keeps the file private", async () => {
    await writeFile(path, `${required}\n`, { mode: 0o600 });
    const first = await prepareEnvironmentFile(path);
    expect(first.generated).toEqual([
      "FONDS_AUTH_SECRET",
      "FONDS_OWNER_ID",
      "FONDS_CREDENTIALS_KEY",
      "FONDS_COLLECTION_SECRET",
      "FONDS_COLLECTION_TIME",
    ]);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const saved = parseEnv(await readFile(path, "utf8"));
    expect(saved.FONDS_AUTH_SECRET?.length).toBeGreaterThanOrEqual(32);
    expect(saved.FONDS_COLLECTION_SECRET).toMatch(/^[A-Za-z0-9_-]{32,256}$/);
    expect(saved.FONDS_COLLECTION_TIME).toMatch(/^([01]\d|2[0-3]):[0-5]\d$/);

    const second = await prepareEnvironmentFile(path);
    expect(second.generated).toEqual([]);
    expect(second.values).toEqual(saved);
  });

  it("keeps an operator's schedule and pinned time, and adds a missing time only in setup", async () => {
    const secrets = [
      "FONDS_AUTH_SECRET=synthetic-auth-secret-00000000000000000000",
      "FONDS_OWNER_ID=synthetic-owner",
      `FONDS_CREDENTIALS_KEY=${"A".repeat(43)}`,
      "FONDS_COLLECTION_SECRET=synthetic-collection-secret-000000000000",
      "FONDS_COLLECTION_SCHEDULE=9,13,18",
      "FONDS_COLLECTION_TIMEZONE=Asia/Jerusalem",
    ].join("\n");
    await writeFile(path, `${required}\n${secrets}\n`, { mode: 0o600 });
    // A login link needs no collection time and never writes the file.
    const linkOnly = await prepareEnvironmentFile(path, { generate: false });
    expect(linkOnly.generated).toEqual([]);
    expect(await readFile(path, "utf8")).toBe(`${required}\n${secrets}\n`);
    const added = await prepareEnvironmentFile(path);
    expect(added.generated).toEqual(["FONDS_COLLECTION_TIME"]);
    expect(added.values.FONDS_COLLECTION_SCHEDULE).toBe("9,13,18");

    await writeFile(
      path,
      `${required}\n${secrets}\nFONDS_COLLECTION_TIME=07:45\n`,
      {
        mode: 0o600,
      },
    );
    const pinned = await prepareEnvironmentFile(path);
    expect(pinned.generated).toEqual([]);
    expect(pinned.values.FONDS_COLLECTION_TIME).toBe("07:45");
  });

  it("names missing required settings without generating anything", async () => {
    await writeFile(
      path,
      "FONDS_PUBLIC_ORIGIN=https://fonds.synthetic.invalid\n",
      {
        mode: 0o600,
      },
    );
    await expect(prepareEnvironmentFile(path)).rejects.toThrow(
      "Add FONDS_NEON_GOOGLE_AUTH_URL, FONDS_GOOGLE_OWNER_EMAIL, FONDS_COLLECTION_CONNECTION_ID, FONDS_COLLECTION_PROVIDER",
    );
    expect(await readFile(path, "utf8")).not.toContain("FONDS_AUTH_SECRET");
  });

  it("rejects in-repository names, shared directories and concurrent setup", async () => {
    await expect(
      prepareEnvironmentFile(resolve(root, "..private.env")),
    ).rejects.toThrow("outside the repository");
    await writeFile(path, `${required}\n`, { mode: 0o600 });
    await chmod(directory, 0o755);
    await expect(prepareEnvironmentFile(path)).rejects.toThrow("0700");
    await chmod(directory, 0o700);
    const options = [
      "--env-file",
      path,
      "--project-id",
      "synthetic-project",
      "--branch-id",
      "synthetic-branch",
    ];
    await expect(setup(options)).rejects.toThrow("--profile is required.");
    await writeFile(`${path}.lock`, "", { mode: 0o600 });
    await expect(
      setup([...options, "--profile", "synthetic-profile"]),
    ).rejects.toThrow("Another setup holds");
    expect(await readFile(path, "utf8")).not.toContain("FONDS_AUTH_SECRET");
  });

  it("issues login links only after setup generated the secrets, without changing the file", async () => {
    await writeFile(path, `${required}\n`, { mode: 0o600 });
    const args = [
      "--env-file",
      path,
      "--project-id",
      "synthetic-project",
      "--branch-id",
      "synthetic-branch",
      "--profile",
      "synthetic-profile",
    ];
    await expect(setup(["login-link", ...args])).rejects.toThrow(
      "Run setup first",
    );
    expect(await readFile(path, "utf8")).toBe(`${required}\n`);
    await expect(setup(["rotate", ...args])).rejects.toThrow("Unknown action");
  });

  it("rejects readable files and paths inside the repository", async () => {
    await writeFile(path, `${required}\n`, { mode: 0o600 });
    await chmod(path, 0o644);
    await expect(prepareEnvironmentFile(path)).rejects.toThrow("0600");
    await expect(
      prepareEnvironmentFile(resolve(root, "neon.env")),
    ).rejects.toThrow("outside the repository");
  });
});

const secrets = [
  "FONDS_AUTH_SECRET=synthetic-auth-secret-00000000000000000000",
  "FONDS_OWNER_ID=synthetic-owner",
  `FONDS_CREDENTIALS_KEY=${"A".repeat(43)}`,
  "FONDS_COLLECTION_SECRET=synthetic-collection-secret-000000000000",
].join("\n");
const target = [
  "--project-id",
  "synthetic-project",
  "--branch-id",
  "synthetic-branch",
  "--profile",
  "synthetic-profile",
];
/** Where setup stops once the env file is final: the Neon CLI cannot start. */
const stopsAtDatabase = "Database setup failed; the env file was kept.";

/**
 * A fake terminal that types each scripted answer once a prompt appears;
 * after the script it types `then`, or closes the input when that is unset.
 */
function terminal(answers, { then } = {}) {
  const input = new PassThrough();
  input.isTTY = true;
  const prompts = [];
  let transcript = "";
  const output = new Writable({
    write(chunk, _encoding, done) {
      const text = chunk.toString();
      transcript += text;
      if (text.endsWith("]: ")) {
        prompts.push(text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, ""));
        const answer = answers.length ? answers.shift() : then;
        setImmediate(() =>
          answer === undefined ? input.end() : input.write(`${answer}\n`),
        );
      }
      done();
    },
  });
  output.isTTY = true;
  output.columns = 500;
  return {
    io: { input, output },
    prompts,
    transcript: () => transcript.replace(/\u001b\[[0-9;]*[A-Za-z]/g, ""),
  };
}

/** The names of an env file's entries, in file order. */
function names(text) {
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("=")[0]);
}

/** Standard streams that are not a terminal, recording anything written. */
function pipes({ inputTTY = false } = {}) {
  const input = new PassThrough();
  input.isTTY = inputTTY;
  let transcript = "";
  const output = new Writable({
    write(chunk, _encoding, done) {
      transcript += chunk.toString();
      done();
    },
  });
  return { io: { input, output }, transcript: () => transcript };
}

describe("Neon setup schedule", () => {
  let directory;
  let path;

  beforeEach(async () => {
    directory = await mkdtemp(resolve(tmpdir(), "fonds-neon-schedule-"));
    path = resolve(directory, "neon.env");
    // An empty PATH: setup's Neon CLI call cannot start, so every setup run
    // stops after the env file is final and before any network or database.
    const empty = resolve(directory, "empty-path");
    await mkdir(empty);
    vi.stubEnv("PATH", empty);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  });

  async function written(text) {
    await writeFile(path, text, { mode: 0o600 });
  }

  it("asks on a terminal, keeps refreshes off on Enter and adds no schedule", async () => {
    await written(`${required}\n`);
    const tty = terminal([""]);
    await expect(
      setup(["--env-file", path, ...target], tty.io),
    ).rejects.toThrow(stopsAtDatabase);
    expect(tty.prompts).toHaveLength(1);
    expect(tty.prompts[0]).toContain("daily (recommended");
    expect(tty.prompts[0]).toMatch(/\[off\]: $/);
    const saved = parseEnv(await readFile(path, "utf8"));
    expect(saved.FONDS_AUTH_SECRET).toBeDefined();
    expect(saved.FONDS_COLLECTION_SCHEDULE).toBeUndefined();
    expect(saved.FONDS_COLLECTION_TIMEZONE).toBeUndefined();
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("re-asks until each answer is valid and replaces only the schedule entries", async () => {
    const before = `${required}\n${secrets}\nFONDS_COLLECTION_TIME=07:45\nFONDS_SYNTHETIC_EXTRA=kept\n`;
    await written(before);
    const tty = terminal([
      "dialy",
      "24",
      "18, 9,13",
      "Mars/Base",
      "asia/jerusalem",
      "7:45",
      "06:30",
    ]);
    await expect(
      setup(["--env-file", path, ...target], tty.io),
    ).rejects.toThrow(stopsAtDatabase);
    expect(tty.prompts).toHaveLength(7);
    const transcript = tty.transcript();
    expect(transcript).toContain(
      "FONDS_COLLECTION_SCHEDULE must be off, daily, hourly or hours 0-23 such as 9,13,18.",
    );
    expect(transcript).toContain(
      "FONDS_COLLECTION_SCHEDULE must be daily, hourly or hours 0-23 such as 9,13,18.",
    );
    expect(transcript).toContain(
      "FONDS_COLLECTION_TIMEZONE must be an IANA time zone such as Europe/London.",
    );
    expect(transcript).toContain(
      "FONDS_COLLECTION_TIME must be a 24-hour HH:MM time.",
    );
    expect(tty.prompts[6]).toMatch(/\[07:45\]: $/);
    const after = await readFile(path, "utf8");
    expect(parseEnv(after)).toEqual({
      ...parseEnv(before),
      FONDS_COLLECTION_SCHEDULE: "9,13,18",
      FONDS_COLLECTION_TIMEZONE: "Asia/Jerusalem",
      FONDS_COLLECTION_TIME: "06:30",
    });
    expect(new Set(names(after)).size).toBe(names(after).length);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("offers the file's values on a rerun, and Enter leaves the file byte-identical", async () => {
    const before = `${required}\n${secrets}\nFONDS_COLLECTION_SCHEDULE=09,13,18\nFONDS_COLLECTION_TIMEZONE=Asia/Jerusalem\nFONDS_COLLECTION_TIME=07:45\n`;
    await written(before);
    const { ino } = await stat(path);
    const tty = terminal(["", "", ""]);
    await expect(
      setup(["--env-file", path, ...target], tty.io),
    ).rejects.toThrow(stopsAtDatabase);
    expect(tty.prompts.map((prompt) => prompt.match(/\[(.*)\]: $/)[1])).toEqual(
      ["9,13,18", "Asia/Jerusalem", "07:45"],
    );
    expect(await readFile(path, "utf8")).toBe(before);
    expect((await stat(path)).ino).toBe(ino);
  });

  it("asks only for the time when hourly, and suggests the machine's zone when daily", async () => {
    vi.stubEnv("TZ", "Asia/Tokyo");
    const before = `${required}\n${secrets}\nFONDS_COLLECTION_TIME=07:45\n`;
    await written(before);
    const hourly = terminal(["hourly", ""]);
    await expect(
      setup(["--env-file", path, ...target], hourly.io),
    ).rejects.toThrow(stopsAtDatabase);
    expect(hourly.prompts).toHaveLength(2);
    expect(parseEnv(await readFile(path, "utf8"))).toEqual({
      ...parseEnv(before),
      FONDS_COLLECTION_SCHEDULE: "hourly",
    });

    const daily = terminal(["daily", "", ""]);
    await expect(
      setup(["--env-file", path, ...target], daily.io),
    ).rejects.toThrow(stopsAtDatabase);
    expect(daily.prompts[0]).toMatch(/\[hourly\]: $/);
    expect(daily.prompts[1]).toMatch(/\[Asia\/Tokyo\]: $/);
    expect(parseEnv(await readFile(path, "utf8"))).toEqual({
      ...parseEnv(before),
      FONDS_COLLECTION_SCHEDULE: "daily",
      FONDS_COLLECTION_TIMEZONE: "Asia/Tokyo",
    });
  });

  it("stops without writing anything when the terminal closes mid-answer", async () => {
    await written(`${required}\n`);
    const tty = terminal(["daily"]);
    await expect(
      setup(["--env-file", path, ...target], tty.io),
    ).rejects.toThrow("Setup stopped; the env file was not changed.");
    expect(await readFile(path, "utf8")).toBe(`${required}\n`);
    await expect(access(`${path}.lock`)).rejects.toThrow();
  });

  it("accepts and refuses the same values as flags and prompts, as the runtime does", async () => {
    const values = parseEnv(
      `${required}\n${secrets}\nFONDS_COLLECTION_TIME=07:45\n`,
    );
    // Each kind's prompt is reached with these answers, then the value under
    // test, then a valid fallback for when it is refused; later prompts take
    // their defaults.
    const scripts = {
      schedule: { before: [], fallback: "off" },
      timeZone: { before: ["daily"], fallback: "UTC" },
      time: { before: ["hourly"], fallback: "00:00" },
    };
    const accepted = [
      ["schedule", "daily", "daily"],
      ["schedule", " hourly ", "hourly"],
      ["schedule", "off", "off"],
      ["schedule", "18, 9,13,9", "9,13,18"],
      ["schedule", "0,23", "0,23"],
      ["timeZone", "Asia/Jerusalem", "Asia/Jerusalem"],
      ["timeZone", "utc", "UTC"],
      ["time", "00:00", "00:00"],
      ["time", "23:59", "23:59"],
    ];
    // Refused by the runtime parser itself, with the message it gives.
    const runtimeRefused = [
      ["schedule", "24"],
      ["schedule", "9,,13"],
      ["schedule", "9 13"],
      ["schedule", "-1"],
      ["schedule", "9=FONDS_OWNER_ID"],
      ["timeZone", "Mars/Base"],
      ["timeZone", "UTC=FONDS_OWNER_ID"],
      ["time", "24:00"],
      ["time", "7:45"],
      ["time", "07:60"],
      ["time", "07:45=FONDS_OWNER_ID"],
    ];
    // Words the runtime silently reads as off; setup refuses them instead.
    const offWords = ["dialy", "Daily", "weekly", "daily=FONDS_OWNER_ID"];
    const settingName = {
      schedule: "FONDS_COLLECTION_SCHEDULE",
      timeZone: "FONDS_COLLECTION_TIMEZONE",
      time: "FONDS_COLLECTION_TIME",
    };
    const runtime = (kind, text) =>
      parseCollectionSchedule(
        {
          FONDS_COLLECTION_SCHEDULE: "daily",
          FONDS_COLLECTION_TIME: "00:00",
          [settingName[kind]]: text,
        },
        "missing",
      );
    const viaFlag = (kind, text) =>
      scheduleSource({ [kind]: text }, pipes().io)()[kind];

    async function viaPrompt(kind, text) {
      const { before, fallback } = scripts[kind];
      const tty = terminal([...before, text, fallback], { then: "" });
      const answers = await scheduleSource({}, tty.io)({ ...values });
      return { answer: answers[kind], transcript: tty.transcript() };
    }

    for (const [kind, text, expected] of accepted) {
      expect(viaFlag(kind, text)).toBe(expected);
      expect((await viaPrompt(kind, text)).answer).toBe(expected);
    }
    for (const [kind, text] of runtimeRefused) {
      let message;
      try {
        runtime(kind, text);
      } catch (error) {
        message = `${error.message}.`;
      }
      expect(message, `${kind} ${text}`).toBeDefined();
      expect(() => viaFlag(kind, text)).toThrow(message);
      const prompted = await viaPrompt(kind, text);
      expect(prompted.transcript).toContain(message);
      expect(prompted.answer).toBe(scripts[kind].fallback);
    }
    for (const text of offWords) {
      expect(runtime("schedule", text)).toBeUndefined();
      const message =
        "FONDS_COLLECTION_SCHEDULE must be off, daily, hourly or hours 0-23 such as 9,13,18.";
      expect(() => viaFlag("schedule", text)).toThrow(message);
      const prompted = await viaPrompt("schedule", text);
      expect(prompted.transcript).toContain(message);
      expect(prompted.answer).toBe("off");
    }
  });

  it("refuses invalid or injected flags before touching the env file", async () => {
    await written(`${required}\n`);
    for (const flag of [
      ["--schedule", "24"],
      ["--schedule", "daily\nFONDS_OWNER_ID=attacker"],
      ["--schedule", "9\nFONDS_OWNER_ID=attacker"],
      ["--timezone", "UTC\nFONDS_OWNER_ID=attacker"],
      ["--time", "07:45\nFONDS_OWNER_ID=attacker"],
      ["--time", "07:45=attacker"],
    ]) {
      await expect(
        setup(["--env-file", path, ...target, ...flag], pipes().io),
        flag.join(" "),
      ).rejects.toThrow(/^FONDS_COLLECTION_(SCHEDULE|TIMEZONE|TIME) must be/);
    }
    expect(await readFile(path, "utf8")).toBe(`${required}\n`);
    // The env file refuses an unvalidated answer too.
    await expect(
      prepareEnvironmentFile(path, {
        schedule: () => ({ schedule: "daily\nFONDS_OWNER_ID=attacker" }),
      }),
    ).rejects.toThrow("FONDS_COLLECTION_SCHEDULE must be");
    expect(await readFile(path, "utf8")).toBe(`${required}\n`);
  });

  it("cannot be given another key through a pasted multi-line answer", async () => {
    await written(`${required}\n${secrets}\nFONDS_COLLECTION_TIME=07:45\n`);
    const tty = terminal(["daily\nFONDS_OWNER_ID=attacker", "UTC", ""]);
    await expect(
      setup(["--env-file", path, ...target], tty.io),
    ).rejects.toThrow(stopsAtDatabase);
    // The pasted line answers no question, so each prompt is still asked.
    expect(tty.prompts).toHaveLength(3);
    const text = await readFile(path, "utf8");
    expect(text).not.toContain("attacker");
    expect(text.match(/^FONDS_OWNER_ID=/gm)).toHaveLength(1);
    expect(parseEnv(text)).toMatchObject({
      FONDS_OWNER_ID: "synthetic-owner",
      FONDS_COLLECTION_SCHEDULE: "daily",
    });
  });

  it("never prompts with flags or without a terminal on both streams", async () => {
    const before = `${required}\n${secrets}\nFONDS_COLLECTION_SCHEDULE=09,13,18\nFONDS_COLLECTION_TIMEZONE=Asia/Jerusalem\nFONDS_COLLECTION_TIME=07:45\n`;
    await written(before);
    const { ino } = await stat(path);

    // Equal flag values keep the file byte-identical.
    const flagged = terminal(["daily"]);
    await expect(
      setup(
        [
          "--env-file",
          path,
          ...target,
          "--schedule",
          "9,13,18",
          "--timezone",
          "asia/jerusalem",
          "--time",
          "07:45",
        ],
        flagged.io,
      ),
    ).rejects.toThrow(stopsAtDatabase);
    expect(flagged.transcript()).toBe("");
    expect(await readFile(path, "utf8")).toBe(before);
    expect((await stat(path)).ino).toBe(ino);

    // No flags and no terminal output: the file's schedule stays.
    const piped = pipes({ inputTTY: true });
    await expect(
      setup(["--env-file", path, ...target], piped.io),
    ).rejects.toThrow(stopsAtDatabase);
    expect(piped.transcript()).toBe("");
    expect(await readFile(path, "utf8")).toBe(before);

    // A flag replaces only its own entry.
    await expect(
      setup(
        ["--env-file", path, ...target, "--schedule", "daily"],
        terminal([]).io,
      ),
    ).rejects.toThrow(stopsAtDatabase);
    expect(parseEnv(await readFile(path, "utf8"))).toEqual({
      ...parseEnv(before),
      FONDS_COLLECTION_SCHEDULE: "daily",
    });
    expect((await stat(path)).mode & 0o777).toBe(0o600);

    // Without flags or a terminal a fresh file stays off.
    await written(`${required}\n`);
    await expect(
      setup(["--env-file", path, ...target], pipes().io),
    ).rejects.toThrow(stopsAtDatabase);
    expect(
      parseEnv(await readFile(path, "utf8")).FONDS_COLLECTION_SCHEDULE,
    ).toBe(undefined);
  });

  it("never prompts for a login link", async () => {
    const before = `${required}\n${secrets}\nFONDS_COLLECTION_TIME=07:45\n`;
    await written(before);
    const tty = terminal(["daily", "UTC", ""]);
    await expect(
      setup(["login-link", "--env-file", path, ...target], tty.io),
    ).rejects.toThrow("Login link failed.");
    expect(tty.transcript()).toBe("");
    await expect(
      setup(
        ["login-link", "--env-file", path, ...target, "--schedule", "daily"],
        tty.io,
      ),
    ).rejects.toThrow("--schedule, --timezone and --time apply only to setup.");
    expect(tty.transcript()).toBe("");
    expect(await readFile(path, "utf8")).toBe(before);
  });

  it("describes the schedule and the next deploy without printing a secret", async () => {
    await written(`${required}\n`);
    const tty = terminal(["9,13,18", "Asia/Jerusalem", "06:17"]);
    const environment = await prepareEnvironmentFile(path, {
      schedule: scheduleSource({}, tty.io),
    });
    const summary = scheduleSummary(environment.values);
    expect(summary).toBe(
      "Scheduled refreshes: every day at 09:17, 13:17, 18:17 (Asia/Jerusalem).",
    );
    const report = setupReport({
      ...environment,
      schedule: summary,
      deploy: "npm run neon:deploy -- --env /private/neon.env",
    });
    expect(report).toContain(
      "Updated FONDS_COLLECTION_SCHEDULE, FONDS_COLLECTION_TIMEZONE, FONDS_COLLECTION_TIME.",
    );
    expect(report).toContain("npm run neon:deploy -- --env /private/neon.env");
    const printed = `${tty.transcript()}\n${report}`;
    for (const name of [
      "FONDS_AUTH_SECRET",
      "FONDS_OWNER_ID",
      "FONDS_CREDENTIALS_KEY",
      "FONDS_COLLECTION_SECRET",
    ]) {
      expect(printed).not.toContain(environment.values[name]);
    }
    expect(
      scheduleSummary({
        FONDS_COLLECTION_SCHEDULE: "daily",
        FONDS_COLLECTION_TIME: "07:05",
      }),
    ).toBe("Scheduled refreshes: daily at 07:05 (UTC).");
    expect(scheduleSummary({ FONDS_COLLECTION_TIME: "07:05" })).toBe(
      "Scheduled refreshes: off.",
    );
  });
});

describe("Neon Function bundle", () => {
  it("reaches only the PostgreSQL driver", async () => {
    const result = await build({
      absWorkingDir: root,
      entryPoints: ["deploy/neon/function.ts"],
      bundle: true,
      platform: "node",
      target: "node24",
      format: "esm",
      metafile: true,
      write: false,
      logLevel: "silent",
    });
    expect(() => assertGraph("postgres", result.metafile)).not.toThrow();
  }, 60_000);
});

describe("Neon smoke checks", () => {
  it("targets only the configured public origin", () => {
    const origin = "https://fonds.synthetic.invalid";
    for (const [, request] of smokeChecks(origin)) {
      expect(new URL(request.url).origin).toBe(origin);
    }
  });
});
