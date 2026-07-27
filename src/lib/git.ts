import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config, requireConfig } from "../config.js";

const exec = promisify(execFile);

export interface Commit {
  hash: string;
  date: string;
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
  upstream: string;
  upstreamHead: string;
  previousReportedHead: string | null;
  unpushedCount: number;
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
 * 현재 게임 레포 브랜치의 upstream에 반영된 커밋만 반환한다.
 * Discord 이름이나 로컬 Git author는 수집 기준으로 사용하지 않는다.
 */
export async function gitPushedLog(opts: {
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

    let upstream: string;
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

    const upstreamHead = await runGit(cwd, ["rev-parse", upstream]);
    const storedHead = opts.lastReportedHeads?.[upstream] ?? null;
    let previousReportedHead: string | null = null;
    let revision = upstream;
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

    const countArgs = ["rev-list", "--count", revision];
    if (initialSince) countArgs.push(`--since=${initialSince}`);
    const commitCountRaw = await runGit(cwd, countArgs);
    const commitCount = Number.parseInt(commitCountRaw, 10);
    const limit = opts.limit ?? 200;
    if (Number.isFinite(commitCount) && commitCount > limit) {
      throw new Error(
        `upstream 신규 커밋이 ${commitCount}건으로 수집 한도(${limit}건)를 초과했습니다. ` +
          "회의 보고 주기를 줄이거나 수집 한도를 조정하세요.",
      );
    }

    const logArgs = [
      "log",
      revision,
      "--pretty=format:%H%x09%cI%x09%s",
    ];
    if (initialSince) logArgs.push(`--since=${initialSince}`);
    const stdout = await runGit(cwd, logArgs);
    const commits = stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((line): Commit => {
        const [hash, date, ...rest] = line.split("\t");
        return {
          hash: hash ?? "",
          date: date ?? "",
          subject: rest.join("\t"),
        };
      });

    const unpushedRaw = await runGit(cwd, [
      "rev-list",
      "--count",
      `${upstream}..HEAD`,
    ]);
    const unpushedCount = Number.parseInt(unpushedRaw, 10);

    return {
      commits,
      branch,
      upstream,
      upstreamHead,
      previousReportedHead,
      unpushedCount: Number.isFinite(unpushedCount) ? unpushedCount : 0,
    };
  } catch (e) {
    if (
      e instanceof Error &&
      (e.message.includes("detached HEAD") ||
        e.message.includes("upstream이 없습니다"))
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
