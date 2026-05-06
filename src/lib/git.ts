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

export async function gitLog(opts: {
  author?: string;
  since?: string | null;
  limit?: number;
}): Promise<Commit[]> {
  const cwd = requireConfig(config.gameProjectPath, "GAME_PROJECT_PATH");
  const args = [
    "log",
    "--pretty=format:%H%x09%cI%x09%s",
    "-n",
    String(opts.limit ?? 50),
    `--since=${opts.since ?? "7.days.ago"}`,
  ];
  if (opts.author) args.push(`--author=${opts.author}`);

  try {
    const { stdout } = await exec("git", args, {
      cwd,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
    });
    return stdout
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
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("not a git repository")) {
      throw new Error(`GAME_PROJECT_PATH가 git 레포가 아님: ${cwd}`);
    }
    if (msg.toLowerCase().includes("enoent")) {
      throw new Error("git 실행 파일을 찾지 못함. PATH 확인 필요.");
    }
    throw new Error(`git log 실패: ${msg}`);
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
