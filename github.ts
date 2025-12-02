import { Octokit } from "@octokit/rest";
import { CONFIG } from "./config.ts";
import { formatFallbackMarkdown } from "./utils.ts";

export interface GitHubContext {
  owner: string;
  repo: string;
  prNumber: number;
  ref: string;
  actor?: string;
  prAuthor?: string;
}

export interface ReviewComment {
  filepath: string;
  start_line: number;
  end_line?: number;
  comment: string;
}

export interface ReviewData {
  conclusion: string;
  general_comment?: string;
  comments: ReviewComment[];
}

export function parsePatchLineNumbers(patch?: string) {
  if (!patch)
    return { contextLines: new Set<number>(), changedLines: new Set<number>() };

  const lines = patch.split("\n");
  const contextLines = new Set<number>();
  const changedLines = new Set<number>();
  let newLine = 0;

  for (const line of lines) {
    if (line.startsWith("@@")) {
      const match = /@@ -\d+(?:,\d+)? \+(\d+)/.exec(line);
      if (match) newLine = Number(match[1]);
      continue;
    }
    if (line.startsWith("+")) {
      changedLines.add(newLine);
      contextLines.add(newLine);
      newLine++;
    } else if (line.startsWith(" ")) {
      contextLines.add(newLine);
      newLine++;
    }
  }

  return { contextLines, changedLines };
}

export async function buildSnippets(
  octokit: Octokit,
  owner: string,
  repo: string,
  ref: string,
  changedFiles: Array<any>,
  contentsMap: Map<string, string[]>
) {
  const snippets: string[] = [];

  for (const file of changedFiles) {
    if (!file.patch || file.status === "removed") continue;

    const { contextLines, changedLines } = parsePatchLineNumbers(file.patch);
    const seedLines = changedLines.size ? changedLines : contextLines;
    if (seedLines.size === 0) continue;

    let lines = contentsMap.get(file.filename);
    if (!lines) {
      const raw = await GitHubService.fetchFileContent(
        octokit,
        owner,
        repo,
        ref,
        file.filename
      );
      lines = raw.split("\n");
    }

    const linesWithContext = new Set<number>();
    for (const line of seedLines) {
      for (let i = -CONFIG.CONTEXT_PADDING; i <= CONFIG.CONTEXT_PADDING; i++) {
        const candidate = line + i;
        if (candidate >= 1 && candidate <= lines.length)
          linesWithContext.add(candidate);
      }
    }

    const sortedLines = Array.from(linesWithContext)
      .sort((a, b) => a - b)
      .slice(0, CONFIG.MAX_LINES_PER_FILE);

    const codeBlock = sortedLines
      .map(
        (num) =>
          `${changedLines.has(num) ? ">" : " "}${num}: ${lines[num - 1] || ""}`
      )
      .join("\n");

    snippets.push(`File: ${file.filename}\n${codeBlock}`);
  }

  return snippets.join("\n\n") || "No parseable changes found.";
}

export class GitHubService {
  octokit: Octokit;
  context: GitHubContext;
  dryRun: boolean;

  constructor(token: string, context: GitHubContext, dryRun: boolean) {
    this.octokit = new Octokit({ auth: token });
    this.context = context;
    this.dryRun = dryRun;
  }

  static async fetchFileContent(
    octokit: Octokit,
    owner: string,
    repo: string,
    ref: string,
    filePath: string
  ) {
    try {
      const { data } = await octokit.repos.getContent({
        owner,
        repo,
        path: filePath,
        ref,
      });
      return Buffer.from((data as any).content, "base64").toString("utf8");
    } catch (e: any) {
      console.warn(`Could not read ${filePath}: ${e.message}`);
      return "";
    }
  }

  static async fetchDirectoryFiles(
    octokit: Octokit,
    owner: string,
    repo: string,
    ref: string,
    dirPath: string
  ) {
    try {
      const { data } = await octokit.repos.getContent({
        owner,
        repo,
        path: dirPath,
        ref,
      });

      if (!Array.isArray(data)) return [];

      const files: Array<{ path: string; content: string }> = [];
      for (const entry of data) {
        if (entry.type === "dir") {
          const nested = await GitHubService.fetchDirectoryFiles(
            octokit,
            owner,
            repo,
            ref,
            entry.path
          );
          files.push(...nested);
        } else if (entry.type === "file") {
          const content = await GitHubService.fetchFileContent(
            octokit,
            owner,
            repo,
            ref,
            entry.path
          );
          files.push({ path: entry.path, content });
        }
      }
      return files;
    } catch (e: any) {
      console.warn(`Could not read directory ${dirPath}: ${e.message}`);
      return [];
    }
  }

  async getChangedFiles() {
    return await this.octokit.paginate(this.octokit.pulls.listFiles, {
      owner: this.context.owner,
      repo: this.context.repo,
      pull_number: this.context.prNumber,
      per_page: 100,
    });
  }

  async fetchAllFileContents(files: Array<any>) {
    const map = new Map<string, string[]>();
    await Promise.all(
      files.map(async (file) => {
        if (file.status === "removed") return;
        const content = await GitHubService.fetchFileContent(
          this.octokit,
          this.context.owner,
          this.context.repo,
          this.context.ref,
          file.filename
        );
        map.set(file.filename, content.split("\n"));
      })
    );
    return map;
  }

  async submitReview(
    reviewData: ReviewData,
    fileContents: Map<string, string[]>,
    changedFiles: Array<any>
  ) {
    const { conclusion, general_comment, comments } = reviewData;

    let event: "REQUEST_CHANGES" | "COMMENT" | "APPROVE" =
      conclusion === "REQUEST_CHANGES"
        ? ("REQUEST_CHANGES" as const)
        : ("APPROVE" as const);

    const isSelfReview = this.context.actor === this.context.prAuthor;
    if (isSelfReview) event = "COMMENT";

    const ghComments = this.normalizeComments(
      comments || [],
      fileContents,
      changedFiles
    );

    if (!general_comment && ghComments.length === 0) {
      console.log("Empty review generated. Skipping.");
      return;
    }

    console.log(
      `Submitting review: ${event} with ${ghComments.length} inline comments.`
    );

    if (this.dryRun) {
      console.log("General comments", general_comment);
      console.log(ghComments);
      return;
    }

    try {
      await this.octokit.pulls.createReview({
        owner: this.context.owner,
        repo: this.context.repo,
        pull_number: this.context.prNumber,
        body: general_comment || "Automated Review (No summary provided)",
        event,
        comments: ghComments,
      });
      console.log("Review successfully created.");
    } catch (err: any) {
      console.error(
        "Failed to create structured review. Falling back to plain comment.",
        err.message
      );
      const fallbackBody = formatFallbackMarkdown(
        conclusion,
        general_comment || "",
        comments || []
      );
      await this.octokit.issues.createComment({
        owner: this.context.owner,
        repo: this.context.repo,
        issue_number: this.context.prNumber,
        body: fallbackBody,
      });
    }
  }

  private normalizeComments(
    rawComments: Array<ReviewComment>,
    fileContents: Map<string, string[]>,
    changedFiles: Array<any>
  ) {
    const validPaths = new Set(changedFiles.map((f) => f.filename));
    const results: Array<any> = [];

    for (const c of rawComments) {
      if (!c.filepath || !validPaths.has(c.filepath)) continue;

      const lines = fileContents.get(c.filepath);
      const start = Number(c.start_line);
      if (!Number.isInteger(start) || start < 1) continue;
      if (lines && start > lines.length) continue;

      const commentObj: any = {
        path: c.filepath,
        body: c.comment,
        side: "RIGHT",
        line: start,
      };

      if (c.end_line && Number(c.end_line) > start) {
        const end = Math.min(
          Number(c.end_line),
          lines ? lines.length : Number(c.end_line)
        );
        commentObj.start_line = start;
        commentObj.line = end;
        commentObj.start_side = "RIGHT";
      }

      results.push(commentObj);
    }

    return results;
  }
}
