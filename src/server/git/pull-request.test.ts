import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { hostOf, pullRequestStatus, reviewOf, summarizeChecks, toPullRequest } from "./pull-request.ts";
import { initRepo, isolateGit, removeDir, sh, tempDir } from "./testing.ts";

beforeAll(isolateGit);

const run = (conclusion: string | null, status = "COMPLETED") => ({
  __typename: "CheckRun",
  name: "build",
  status,
  conclusion,
});
const context = (state: string) => ({ __typename: "StatusContext", context: "ci/legacy", state });

describe("summarizeChecks", () => {
  it("is passing only when every check finished well", () => {
    expect(summarizeChecks([run("SUCCESS"), run("SKIPPED"), context("SUCCESS")])).toEqual({
      state: "passing",
      total: 3,
      passed: 2,
      failed: 0,
      pending: 0,
      skipped: 1,
      cancelled: 0,
    });
  });

  it("fails on any failure, whatever else is pending", () => {
    expect(summarizeChecks([run("SUCCESS"), run(null, "IN_PROGRESS"), run("TIMED_OUT")]).state).toBe(
      "failing",
    );
    expect(summarizeChecks([context("ERROR"), run("SUCCESS")]).state).toBe("failing");
  });

  it("is pending while anything runs, cancelled when something was cancelled", () => {
    expect(summarizeChecks([run("SUCCESS"), run(null, "QUEUED")]).state).toBe("pending");
    expect(summarizeChecks([context("PENDING")]).state).toBe("pending");
    expect(summarizeChecks([run("SUCCESS"), run("CANCELLED")]).state).toBe("cancelled");
  });

  it("never reports missing or unrecognized data as passing", () => {
    expect(summarizeChecks([]).state).toBe("none");
    expect(summarizeChecks(null).state).toBe("none");
    expect(summarizeChecks(undefined).state).toBe("none");
    expect(summarizeChecks("nope").state).toBe("unknown");
    expect(summarizeChecks([run("SUCCESS"), run("SOMETHING_NEW")]).state).toBe("unknown");
    expect(summarizeChecks([run("SUCCESS"), run(null, "MYSTERY")]).state).toBe("unknown");
    expect(summarizeChecks([run("SUCCESS"), 42]).state).toBe("unknown");
    expect(summarizeChecks([context("SUCCESS"), context("WEIRD")]).state).toBe("unknown");
  });
});

describe("reviewOf", () => {
  it("maps GitHub's review decision, and never guesses approval", () => {
    expect(reviewOf("APPROVED")).toBe("approved");
    expect(reviewOf("CHANGES_REQUESTED")).toBe("changes_requested");
    expect(reviewOf("REVIEW_REQUIRED")).toBe("review_required");
    expect(reviewOf("")).toBe("none");
    expect(reviewOf(null)).toBe("none");
    expect(reviewOf(undefined)).toBe("unknown");
    expect(reviewOf("SOMETHING")).toBe("unknown");
  });
});

describe("toPullRequest", () => {
  const base = {
    number: 7,
    title: "Fix cart totals",
    url: "https://github.com/acme/shop/pull/7",
    author: { login: "ada" },
    headRefName: "fix/cart",
    baseRefName: "main",
    reviewDecision: "APPROVED",
    statusCheckRollup: [],
    updatedAt: "2026-09-28T14:06:25Z",
  };

  it("reads open, draft, merged and closed", () => {
    expect(toPullRequest({ ...base, state: "OPEN", isDraft: false })?.state).toBe("open");
    expect(toPullRequest({ ...base, state: "OPEN", isDraft: true })?.state).toBe("draft");
    expect(toPullRequest({ ...base, state: "MERGED", isDraft: false })?.state).toBe("merged");
    expect(toPullRequest({ ...base, state: "CLOSED", isDraft: false })?.state).toBe("closed");
    expect(toPullRequest({ ...base, state: "OPEN", isDraft: false })).toMatchObject({
      number: 7,
      author: "ada",
      head: "fix/cart",
      base: "main",
      review: "approved",
      checks: { state: "none" },
      updatedAt: Date.parse("2026-09-28T14:06:25Z"),
    });
  });

  it("refuses what isn't a pull request", () => {
    expect(toPullRequest(null)).toBeNull();
    expect(toPullRequest([])).toBeNull();
    expect(toPullRequest({ ...base, state: "WHATEVER" })).toBeNull();
    expect(toPullRequest({ ...base, number: "7", state: "OPEN" })).toBeNull();
  });
});

describe("hostOf", () => {
  it("finds the host of https, ssh and scp-like remotes, and none for local paths", () => {
    expect(hostOf("https://github.com/acme/shop.git")).toBe("github.com");
    expect(hostOf("https://token@GitHub.com/acme/shop")).toBe("github.com");
    expect(hostOf("ssh://git@github.example.com:2222/acme/shop.git")).toBe("github.example.com");
    expect(hostOf("git@github.com:acme/shop.git")).toBe("github.com");
    expect(hostOf("gitlab.com:acme/shop.git")).toBe("gitlab.com");
    expect(hostOf("/srv/git/shop.git")).toBeNull();
    expect(hostOf("../shop")).toBeNull();
    expect(hostOf("file:///srv/git/shop.git")).toBeNull();
    expect(hostOf("C:\\repos\\shop")).toBeNull();
  });
});

describe("pullRequestStatus", () => {
  let tmp: string;
  let repo: string;
  let gh: string;
  beforeEach(() => {
    tmp = tempDir();
    repo = initRepo(tmp, "repo");
    sh(repo, "remote", "add", "origin", "https://github.com/acme/shop.git");
    gh = path.join(tmp, "gh");
  });
  afterEach(() => removeDir(tmp));

  const fakeGh = (script: string): void => {
    fs.writeFileSync(gh, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  };

  it("gives up on a gh that doesn't answer in time", async () => {
    fakeGh("sleep 5");
    const started = Date.now();
    const status = await pullRequestStatus({ dir: repo, gh, timeoutMs: 300 });
    expect(status).toMatchObject({
      state: "error",
      message: "gh didn't answer within 0.3 s.",
      branch: "main",
    });
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("says when gh's answer isn't JSON", async () => {
    fakeGh("echo 'not json'");
    expect((await pullRequestStatus({ dir: repo, gh })).state).toBe("error");
  });

  it("tells an unknown host from a missing sign-in", async () => {
    fakeGh(
      "echo 'none of the git remotes configured for this repository point to a known GitHub host. To tell gh about a new GitHub host, please use `gh auth login`' >&2; exit 1",
    );
    expect((await pullRequestStatus({ dir: repo, gh })).state).toBe("unsupported");
    fakeGh("echo 'To get started with GitHub CLI, please run:  gh auth login' >&2; exit 4");
    expect((await pullRequestStatus({ dir: repo, gh })).state).toBe("signed-out");
  });
});
