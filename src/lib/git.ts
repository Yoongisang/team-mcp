import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config, requireConfig } from "../config.js";

const exec = promisify(execFile);

export interface Commit {
  hash: string;
  date: string;
  authorName: string;
  authorEmail: string;
  subject: string;
  body?: string;
  filesChanged?: number;
  insertions?: number;
  deletions?: number;
  topFiles?: string[];
}

export interface PushedCommitLog {
  commits: Commit[];
  branch: string;
  baseRef: string;
  upstream: string;
  upstreamHead: string;
  previousReportedHead: string | null;
  reportAuthor: string;
  trackingKey: string;
  totalCommitCount: number;
  authorKnown: boolean;
  availableAuthors: string[];
  unpushedCount: number;
}

function normalizeIdentity(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

export function matchesGitAuthor(
  commit: Pick<Commit, "authorName" | "authorEmail">,
  author: string,
): boolean {
  const target = normalizeIdentity(author);
  if (!target) return false;
  const emailLocalPart = commit.authorEmail.split("@")[0] ?? "";
  return [commit.authorName, commit.authorEmail, emailLocalPart]
    .map(normalizeIdentity)
    .includes(target);
}

export function gitReportTrackingKey(
  ref: string,
  author: string,
): string {
  return `${ref}::${normalizeIdentity(author)}`;
}

export function initialGitReportRevision(
  baseRef: string,
  upstream: string,
): string {
  return baseRef === upstream ? upstream : `${baseRef}..${upstream}`;
}

function parseCommitLog(stdout: string): Commit[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line): Commit => {
      const [hash, date, authorName, authorEmail, ...rest] = line.split("\t");
      return {
        hash: hash ?? "",
        date: date ?? "",
        authorName: authorName ?? "",
        authorEmail: authorEmail ?? "",
        subject: rest.join("\t"),
      };
    });
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, {
    cwd,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  });
  return stdout.trim();
}

function gitFailure(error: unknown, cwd: string): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("not a git repository")) {
    return new Error(`GAME_PROJECT_PATH가 git 레포가 아님: ${cwd}`);
  }
  if (message.toLowerCase().includes("enoent")) {
    return new Error("git 실행 파일을 찾지 못함. PATH 확인 필요.");
  }
  return new Error(`git 조회 실패: ${message}`);
}

/**
 * 게임 레포의 현재 브랜치 upstream에 push된 커밋 중 지정한 Git 작성자의 것만 반환한다.
 * 보고 기준 ref는 작업 범위의 시작점으로만 사용하고, push 여부는 upstream으로 판정한다.
 * 마지막 보고 HEAD는 upstream + 작성자별로 독립 추적한다.
 */
export async function gitPushedLog(opts: {
  author: string;
  ref?: string;
  lastReportedHeads?: Record<string, string>;
  limit?: number;
}): Promise<PushedCommitLog> {
  const cwd = requireConfig(config.gameProjectPath, "GAME_PROJECT_PATH");

  try {
    const branch = await runGit(cwd, ["branch", "--show-current"]);
    if (!branch) {
      throw new Error(
        "현재 게임 레포가 detached HEAD 상태입니다. 브랜치를 checkout한 뒤 다시 시도하세요.",
      );
    }

    const baseRef = opts.ref?.trim() || "origin/develop";
    try {
      await runGit(cwd, ["rev-parse", "--verify", baseRef]);
    } catch {
      throw new Error(
        `Git 보고 기준 ref '${baseRef}'를 찾을 수 없습니다. ` +
          "`git fetch` 후 GIT_REPORT_REF 설정을 확인하세요.",
      );
    }

    let upstream = "";
    try {
      upstream = await runGit(cwd, [
        "rev-parse",
        "--abbrev-ref",
        "--symbolic-full-name",
        "@{upstream}",
      ]);
    } catch {
      throw new Error(
        `현재 브랜치 '${branch}'에 upstream이 없습니다. ` +
          "`git push -u <remote> <branch>`로 원격 추적 브랜치를 설정한 뒤 다시 시도하세요.",
      );
    }

    try {
      await runGit(cwd, ["rev-parse", "--verify", upstream]);
    } catch {
      throw new Error(
        `현재 브랜치의 upstream '${upstream}'를 찾을 수 없습니다. ` +
          "`git fetch` 또는 `git push -u <remote> <branch>` 후 다시 시도하세요.",
      );
    }

    const upstreamHead = await runGit(cwd, ["rev-parse", upstream]);
    const trackingKey = gitReportTrackingKey(upstream, opts.author);
    const legacyTrackingKey = gitReportTrackingKey(baseRef, opts.author);
    const storedHead =
      opts.lastReportedHeads?.[trackingKey] ??
      opts.lastReportedHeads?.[legacyTrackingKey] ??
      null;
    let previousReportedHead: string | null = null;
    let revision = initialGitReportRevision(baseRef, upstream);
    let initialSince: string | undefined = "7.days.ago";

    if (storedHead) {
      try {
        await runGit(cwd, ["cat-file", "-e", `${storedHead}^{commit}`]);
        previousReportedHead = storedHead;
        revision = `${storedHead}..${upstream}`;
        initialSince = undefined;
      } catch {
        // force-push나 GC로 이전 HEAD를 찾을 수 없으면 최근 7일을 다시 수집한다.
      }
    }

    const limit = opts.limit ?? 200;
    const logArgs = [
      "log",
      revision,
      "--pretty=format:%H%x09%cI%x09%an%x09%ae%x09%s",
    ];
    if (initialSince) logArgs.push(`--since=${initialSince}`);
    const stdout = await runGit(cwd, logArgs);
    const allCommits = parseCommitLog(stdout);
    const commits = allCommits.filter((commit) =>
      matchesGitAuthor(commit, opts.author),
    );
    if (commits.length > limit) {
      throw new Error(
        `작성자 '${opts.author}'의 신규 커밋이 ${commits.length}건으로 ` +
          `수집 한도(${limit}건)를 초과했습니다. 회의 보고 주기를 줄이세요.`,
      );
    }
    const knownAuthorsRaw = await runGit(cwd, [
      "log",
      upstream,
      "--pretty=format:%an%x09%ae",
    ]);
    const availableAuthors = [
      ...new Set(
        knownAuthorsRaw
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean)
          .map((line) => {
            const [name, email] = line.split("\t");
            return `${name ?? ""} <${email ?? ""}>`;
          }),
      ),
    ].sort();
    const authorKnown = knownAuthorsRaw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .some((line) => {
        const [authorName, authorEmail] = line.split("\t");
        return matchesGitAuthor(
          {
            authorName: authorName ?? "",
            authorEmail: authorEmail ?? "",
          },
          opts.author,
        );
      });

    const unpushedRaw = await runGit(cwd, [
      "log",
      `${upstream}..HEAD`,
      "--pretty=format:%H%x09%cI%x09%an%x09%ae%x09%s",
    ]);
    const unpushedCount = parseCommitLog(unpushedRaw).filter((commit) =>
      matchesGitAuthor(commit, opts.author),
    ).length;

    return {
      commits,
      branch,
      baseRef,
      upstream,
      upstreamHead,
      previousReportedHead,
      reportAuthor: opts.author,
      trackingKey,
      totalCommitCount: allCommits.length,
      authorKnown,
      availableAuthors,
      unpushedCount,
    };
  } catch (e) {
    if (
      e instanceof Error &&
      (e.message.includes("detached HEAD") ||
        e.message.includes("upstream이 없습니다") ||
        e.message.includes("Git 보고 기준 ref"))
    ) {
      throw e;
    }
    throw gitFailure(e, cwd);
  }
}

/**
 * 단일 커밋의 상세 정보 (body + 파일 변경 통계).
 * stat 정보는 `--shortstat`, body는 `%b`, 파일 목록은 `--name-only`로 별도 호출.
 */
export async function gitShowDetails(hash: string): Promise<{
  body: string;
  filesChanged: number;
  insertions: number;
  deletions: number;
  topFiles: string[];
}> {
  const cwd = requireConfig(config.gameProjectPath, "GAME_PROJECT_PATH");
  const baseOpts = { cwd, maxBuffer: 4 * 1024 * 1024, windowsHide: true };

  // body
  let body = "";
  try {
    const { stdout } = await exec("git", ["show", "-s", "--pretty=format:%b", hash], baseOpts);
    body = stdout.trim();
  } catch {}

  // shortstat: " 3 files changed, 42 insertions(+), 7 deletions(-)"
  let filesChanged = 0, insertions = 0, deletions = 0;
  try {
    const { stdout } = await exec("git", ["show", "--shortstat", "--pretty=format:", hash], baseOpts);
    const stat = stdout.trim();
    const fm = stat.match(/(\d+)\s+files?\s+changed/);
    const im = stat.match(/(\d+)\s+insertions?\(\+\)/);
    const dm = stat.match(/(\d+)\s+deletions?\(-\)/);
    filesChanged = fm ? +fm[1]! : 0;
    insertions = im ? +im[1]! : 0;
    deletions = dm ? +dm[1]! : 0;
  } catch {}

  // 변경 파일 목록 (상위 5개)
  let topFiles: string[] = [];
  try {
    const { stdout } = await exec("git", ["show", "--name-only", "--pretty=format:", hash], baseOpts);
    topFiles = stdout.split("\n").map(s => s.trim()).filter(Boolean).slice(0, 5);
  } catch {}

  return { body, filesChanged, insertions, deletions, topFiles };
}
