import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config, requireConfig } from "../config.js";

const exec = promisify(execFile);

export interface Commit {
  hash: string;
  date: string;
  subject: string;
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
