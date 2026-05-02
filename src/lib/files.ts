import { promises as fs } from "node:fs";
import path from "node:path";
import { config, requireConfig } from "../config.js";

export const GAME_FILES = {
  agents: "AGENTS.md",
  spec: "기획서.md",
  myPart: "내파트.md",
  plan: "플랜.md",
  checklist: "체크리스트.md",
} as const;

export type GameFileName = (typeof GAME_FILES)[keyof typeof GAME_FILES];

function gameRoot(): string {
  return path.resolve(requireConfig(config.gameProjectPath, "GAME_PROJECT_PATH"));
}

function resolveSafe(name: string): string {
  if (!name) throw new Error("File name is required");
  const root = gameRoot();
  const target = path.resolve(root, name);
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (target !== root && !target.startsWith(rootWithSep)) {
    throw new Error(`Path escape blocked: ${name}`);
  }
  return target;
}

export async function readGameFile(name: string): Promise<string> {
  return fs.readFile(resolveSafe(name), "utf8");
}

export async function writeGameFile(
  name: string,
  content: string,
  opts: { overwrite?: boolean } = {},
): Promise<void> {
  const target = resolveSafe(name);
  if (!opts.overwrite) {
    if (await pathExists(target)) {
      throw new Error(`File already exists: ${name}. Pass overwrite=true to replace.`);
    }
  }
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, "utf8");
}

export async function gameFileExists(name: string): Promise<boolean> {
  return pathExists(resolveSafe(name));
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
