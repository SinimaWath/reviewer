import fs from "fs/promises";
import { createHash } from "crypto";
import { Octokit } from "@octokit/rest";
import { GitHubService, buildSnippets } from "./github.ts";
import type { ReviewComment, ReviewData } from "./github.ts";
import { generatePrompt, loadContext } from "./prompt.ts";
import { ModelFactory } from "./provider.ts";
import { estimateTokens, safeParseJson } from "./utils.ts";
import { CONFIG } from "./config.ts";
import { reviewSchema } from "./scheme.ts";

export interface OpenPullRequestItem {
  owner: string;
  repo: string;
  repoUrl: string;
  prUrl: string;
  prNumber: number;
  title: string;
  author: string;
  updatedAt: string;
  headSha: string;
  isDraft: boolean;
}

export interface DraftReviewComment extends ReviewComment {
  id: string;
  snippet: string;
}

export interface PrDisplayStatus {
  label: string;
  emoji: string;
  atIso: string;
  showRunHint: boolean;
}

export interface PreparedReviewRun {
  status: "ready" | "skipped";
  skipReason?: string;
  pr: OpenPullRequestItem;
  provider: string;
  modelName: string;
  reviewData?: ReviewData;
  draftComments?: DraftReviewComment[];
  fileContents?: Map<string, string[]>;
  changedFiles?: Array<any>;
  gitHubService?: GitHubService;
}

export function parsePrUrl(prUrl: string) {
  const url = new URL(prUrl);
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 4 || parts[2] !== "pull") {
    throw new Error(`Invalid PR_URL format: ${prUrl}`);
  }

  const prNumber = Number(parts[3]);
  if (!Number.isFinite(prNumber)) {
    throw new Error(`Invalid PR number in PR_URL: ${prUrl}`);
  }

  return { owner: parts[0], repo: parts[1], prNumber };
}

export function parseRepoUrl(repoUrl: string) {
  const cleaned = repoUrl.trim().replace(/\.git$/, "");
  if (!cleaned) throw new Error("Empty repository url");

  if (!cleaned.startsWith("http")) {
    const [owner, repo] = cleaned.split("/").filter(Boolean);
    if (!owner || !repo) throw new Error(`Invalid repo format: ${repoUrl}`);
    return { owner, repo };
  }

  const url = new URL(cleaned);
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 2) throw new Error(`Invalid repository url: ${repoUrl}`);

  return { owner: parts[0], repo: parts[1] };
}

export function splitRepositoryInput(rawList: string) {
  return rawList
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export async function resolveActor(token: string) {
  if (process.env.GITHUB_ACTOR) return process.env.GITHUB_ACTOR;
  try {
    const octokit = new Octokit({ auth: token });
    const { data } = await octokit.users.getAuthenticated();
    return data.login;
  } catch (err: any) {
    console.warn("Could not resolve actor from token:", err.message);
    return undefined;
  }
}

export async function loadPullRequest(token: string, prUrl: string) {
  const octokit = new Octokit({ auth: token });

  if (prUrl) {
    const { owner, repo, prNumber } = parsePrUrl(prUrl);
    const { data: pr } = await octokit.pulls.get({
      owner,
      repo,
      pull_number: prNumber,
    });
    return { pr, owner, repo };
  }

  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) {
    throw new Error("Missing PR_URL or GITHUB_EVENT_PATH for pull request data");
  }

  const payload = JSON.parse(await fs.readFile(eventPath, "utf8"));
  const pr = payload.pull_request;
  if (!pr) throw new Error("Not a pull_request event");

  const repoEnv = process.env.GITHUB_REPOSITORY;
  let owner = pr?.base?.repo?.owner?.login;
  let repo = pr?.base?.repo?.name;

  if (repoEnv) {
    [owner, repo] = repoEnv.split("/");
  }

  if (!owner || !repo) {
    throw new Error("Missing repo owner/name in payload or GITHUB_REPOSITORY");
  }

  return { pr, owner, repo };
}

export async function resolveGroupRepositories(groupValue?: string) {
  if (!groupValue) return [];
  let rawList = groupValue.trim();

  if (!rawList) return [];

  try {
    const fileUrl = new URL(`./groups/${rawList}`, import.meta.url);
    rawList = await fs.readFile(fileUrl, "utf8");
  } catch {
    // Treat provided value as a direct list if the file does not exist.
  }

  return splitRepositoryInput(rawList);
}

export async function fetchGroupOpenPullRequests(
  token: string,
  repositories: string[]
) {
  if (repositories.length === 0) return [];

  const octokit = new Octokit({ auth: token });
  const pulls: OpenPullRequestItem[] = [];

  for (const repoUrl of repositories) {
    try {
      const { owner, repo } = parseRepoUrl(repoUrl);
      const { data } = await octokit.pulls.list({
        owner,
        repo,
        state: "open",
        sort: "updated",
        direction: "desc",
        per_page: 10,
      });

      if (!data.length) {
        console.log(`No open PRs found for ${owner}/${repo}, skipping.`);
        continue;
      }

      pulls.push(
        ...data.map((pull) => ({
          owner,
          repo,
          repoUrl: `https://github.com/${owner}/${repo}`,
          prUrl: pull.html_url,
          prNumber: pull.number,
          title: pull.title,
          author: pull.user?.login || repo,
          updatedAt:
            pull.updated_at || pull.created_at || new Date().toISOString(),
          headSha: pull.head.sha,
          isDraft: Boolean(pull.draft),
        }))
      );
    } catch (err: any) {
      console.warn(`Failed to fetch PRs for ${repoUrl}: ${err.message}`);
    }
  }

  return pulls;
}

export async function fetchGroupPullRequests(
  token: string,
  repositories: string[]
) {
  const pulls = await fetchGroupOpenPullRequests(token, repositories);
  return pulls.map((pull) => pull.prUrl);
}

export function formatRuTimestamp(iso: string) {
  return new Date(iso).toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function getLatestSubmittedReviewByActor(reviews: Array<any>, actor: string) {
  const normalizedActor = actor.toLowerCase();
  const submittedReviews = reviews.filter((review: any) => {
    const reviewer = review.user?.login?.toLowerCase();
    const state = review.state?.toUpperCase();
    return (
      reviewer === normalizedActor &&
      state &&
      state !== "PENDING" &&
      state !== "DISMISSED"
    );
  });

  if (!submittedReviews.length) return null;

  return submittedReviews.reduce((latest: any, current: any) => {
    const latestTime = new Date(
      latest.submitted_at || latest.created_at || 0
    ).getTime();
    const currentTime = new Date(
      current.submitted_at || current.created_at || 0
    ).getTime();
    return currentTime > latestTime ? current : latest;
  });
}

export async function getPrStatusLine(
  octokit: Octokit,
  prUrl: string,
  actor: string | undefined
): Promise<PrDisplayStatus> {
  const { owner, repo, prNumber } = parsePrUrl(prUrl);
  const [{ data: pr }, reviews] = await Promise.all([
    octokit.pulls.get({ owner, repo, pull_number: prNumber }),
    octokit.paginate(octokit.pulls.listReviews, {
      owner,
      repo,
      pull_number: prNumber,
      per_page: 100,
    }),
  ]);

  const headSha = pr.head.sha;
  const updatedAt = pr.updated_at || pr.created_at || new Date().toISOString();

  const pending = (reviews as any[]).find(
    (review) => review.state?.toUpperCase() === "PENDING"
  );
  if (pending) {
    return {
      label: "Pending review",
      emoji: "⏳",
      atIso: pending.submitted_at || pending.created_at || updatedAt,
      showRunHint: false,
    };
  }

  if (!actor) {
    return {
      label: "Unknown reviewer",
      emoji: "⚠️",
      atIso: updatedAt,
      showRunHint: false,
    };
  }

  const latestReview = getLatestSubmittedReviewByActor(reviews as any[], actor);

  if (!latestReview) {
    return {
      label: "Not Reviewed",
      emoji: "👀",
      atIso: updatedAt,
      showRunHint: true,
    };
  }

  if (latestReview.commit_id && latestReview.commit_id !== headSha) {
    return {
      label: "Have updates",
      emoji: "🔄",
      atIso: updatedAt,
      showRunHint: true,
    };
  }

  const state = String(latestReview.state || "").toUpperCase();
  const reviewTime =
    latestReview.submitted_at || latestReview.created_at || updatedAt;

  if (state === "CHANGES_REQUESTED") {
    return {
      label: "Changes Requested",
      emoji: "🛠️",
      atIso: reviewTime,
      showRunHint: false,
    };
  }

  if (state === "APPROVED") {
    return {
      label: "Approved",
      emoji: "✅",
      atIso: reviewTime,
      showRunHint: false,
    };
  }

  return {
    label: "Reviewed",
    emoji: "📝",
    atIso: reviewTime,
    showRunHint: false,
  };
}

function createCommentId(prUrl: string, comment: ReviewComment) {
  const key = [
    prUrl,
    comment.filepath,
    comment.start_line,
    comment.end_line || "",
    comment.comment,
  ].join("|");

  return createHash("sha1").update(key).digest("hex").slice(0, 16);
}

export function buildCommentSnippet(
  comment: ReviewComment,
  fileContents: Map<string, string[]>,
  padding = 2
) {
  const lines = fileContents.get(comment.filepath);
  if (!lines?.length) return "Snippet unavailable.";

  const startLine = Number(comment.start_line);
  if (!Number.isInteger(startLine) || startLine < 1) {
    return "Snippet unavailable.";
  }

  const endLine =
    Number.isInteger(Number(comment.end_line)) && Number(comment.end_line) >= startLine
      ? Number(comment.end_line)
      : startLine;

  const snippetStart = Math.max(1, startLine - padding);
  const snippetEnd = Math.min(lines.length, endLine + padding);
  const highlighted = new Set<number>();

  for (let line = startLine; line <= endLine; line++) {
    highlighted.add(line);
  }

  return Array.from({ length: snippetEnd - snippetStart + 1 }, (_, index) => {
    const lineNumber = snippetStart + index;
    const marker = highlighted.has(lineNumber) ? ">" : " ";
    return `${marker} ${lineNumber}: ${lines[lineNumber - 1] || ""}`;
  }).join("\n");
}

function buildDraftComments(
  prUrl: string,
  comments: ReviewComment[],
  fileContents: Map<string, string[]>
) {
  return comments.map((comment) => ({
    ...comment,
    id: createCommentId(prUrl, comment),
    snippet: buildCommentSnippet(comment, fileContents),
  }));
}

function toOpenPullRequestItem(pr: any, owner: string, repo: string): OpenPullRequestItem {
  return {
    owner,
    repo,
    repoUrl: `https://github.com/${owner}/${repo}`,
    prUrl: pr.html_url,
    prNumber: pr.number,
    title: pr.title,
    author: pr.user?.login || repo,
    updatedAt: pr.updated_at || pr.created_at || new Date().toISOString(),
    headSha: pr.head.sha,
    isDraft: Boolean(pr.draft),
  };
}

export async function generateReviewDraft(
  prUrl: string,
  options?: {
    respectRemoteSkip?: boolean;
    logger?: Pick<Console, "log" | "warn">;
  }
): Promise<PreparedReviewRun> {
  if (!prUrl) throw new Error("Missing PR URL");

  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("Missing GITHUB_TOKEN");

  const provider = (process.env.AI_PROVIDER || "gemini").toLowerCase();
  const modelName = ModelFactory.defaultModel(provider);
  const apiKey = ModelFactory.resolveApiKey(provider);
  if (!apiKey) throw new Error(`Missing API key for provider ${provider}`);

  const logger = options?.logger || console;
  const { pr, owner, repo } = await loadPullRequest(token, prUrl);
  const actor = await resolveActor(token);
  const context = {
    owner,
    repo,
    prNumber: pr.number,
    ref: pr.head.sha,
    actor,
    prAuthor: pr.user.login,
  };

  const gh = new GitHubService(token, context, Boolean(process.env.DRY_RUN));
  const preparedPr = toOpenPullRequestItem(pr, owner, repo);

  logger.log(`Starting draft review for PR #${pr.number}, url: ${prUrl}`);

  const skipReason = await gh.getReviewSkipReason(context.actor);
  if (skipReason && options?.respectRemoteSkip !== false && !process.env.BYPASS) {
    logger.log(skipReason);
    return {
      status: "skipped",
      skipReason,
      pr: preparedPr,
      provider,
      modelName,
      gitHubService: gh,
    };
  }

  const changedFiles = await gh.getChangedFiles();
  const moduleChangedFiles = changedFiles.filter((file) =>
    CONFIG.MODULE_REGEX.test((file.filename || "").split("/")[0] || "")
  );

  const ctxData = await loadContext(gh.octokit, context, moduleChangedFiles);
  if (!ctxData) {
    const reason = "No relevant coursework files detected. Skipping.";
    logger.log(reason);
    return {
      status: "skipped",
      skipReason: reason,
      pr: preparedPr,
      provider,
      modelName,
      changedFiles: moduleChangedFiles,
      gitHubService: gh,
    };
  }

  const fileContents = await gh.fetchAllFileContents(moduleChangedFiles);
  const snippets = await buildSnippets(
    gh.octokit,
    owner,
    repo,
    context.ref,
    moduleChangedFiles,
    fileContents
  );

  const { prompt, system } = await generatePrompt(
    ctxData.moduleInstructions,
    ctxData.taskInstructions,
    snippets,
    ctxData.taskSolutions
  );

  logger.log(
    `Sending prompt and system instruction (${estimateTokens(prompt)}, ${estimateTokens(
      system
    )}) to ${provider} (${modelName})....`
  );

  const model = ModelFactory.create(provider, apiKey, modelName);
  const responseText = await model.generate(prompt, system, reviewSchema);
  const reviewData = safeParseJson(responseText) as ReviewData;
  const draftComments = buildDraftComments(
    prUrl,
    reviewData.comments || [],
    fileContents
  );

  return {
    status: "ready",
    pr: preparedPr,
    provider,
    modelName,
    reviewData,
    draftComments,
    fileContents,
    changedFiles: moduleChangedFiles,
    gitHubService: gh,
  };
}
