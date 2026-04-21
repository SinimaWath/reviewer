import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import type {
  DraftReviewComment,
  OpenPullRequestItem,
  PrDisplayStatus,
} from "./review-core.ts";

export type ReviewerDecision = "pending" | "approved" | "rejected";
export type ReviewerRunStatus = "idle" | "running" | "ready" | "skipped" | "error";

export interface StoredDraftComment extends DraftReviewComment {
  originalComment: string;
  currentComment: string;
  decision: ReviewerDecision;
  decidedAt?: string;
}

export interface StoredStudentReview {
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
  prStatus?: PrDisplayStatus;
  reviewStatus: ReviewerRunStatus;
  reviewStartedAt?: string;
  reviewFinishedAt?: string;
  skipReason?: string;
  error?: string;
  provider?: string;
  modelName?: string;
  conclusion?: string;
  generalComment?: string;
  comments: StoredDraftComment[];
}

export interface ReviewerState {
  group: {
    repositories: string[];
    loadedAt: string;
  } | null;
  reviewRun: {
    running: boolean;
    startedAt?: string;
    finishedAt?: string;
    currentPrUrl?: string;
    error?: string;
  };
  students: StoredStudentReview[];
}

export interface ApprovedCommentRecord {
  approvedAt: string;
  prUrl: string;
  repoUrl: string;
  prNumber: number;
  commentId: string;
  filepath: string;
  startLine: number;
  endLine?: number;
  originalComment: string;
  approvedComment: string;
  edited: boolean;
}

const CURRENT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(CURRENT_DIR, ".reviewer-data");
const STATE_FILE = path.join(DATA_DIR, "state.json");
const APPROVALS_LOG_FILE = path.join(DATA_DIR, "approved-comments.ndjson");
let mutationChain: Promise<any> = Promise.resolve();

function createEmptyState(): ReviewerState {
  return {
    group: null,
    reviewRun: {
      running: false,
    },
    students: [],
  };
}

async function ensureDataDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

function normalizeComment(comment: DraftReviewComment): StoredDraftComment {
  return {
    ...comment,
    originalComment: comment.comment,
    currentComment: comment.comment,
    decision: "pending",
  };
}

function mergeStudentState(
  existing: StoredStudentReview | undefined,
  incoming: OpenPullRequestItem,
  prStatus?: PrDisplayStatus
): StoredStudentReview {
  const base: StoredStudentReview = {
    owner: incoming.owner,
    repo: incoming.repo,
    repoUrl: incoming.repoUrl,
    prUrl: incoming.prUrl,
    prNumber: incoming.prNumber,
    title: incoming.title,
    author: incoming.author,
    updatedAt: incoming.updatedAt,
    headSha: incoming.headSha,
    isDraft: incoming.isDraft,
    prStatus,
    reviewStatus: "idle",
    comments: [],
  };

  if (!existing) {
    return base;
  }

  if (existing.headSha !== incoming.headSha) {
    return {
      ...base,
      reviewStatus: "idle",
      comments: [],
    };
  }

  return {
    ...existing,
    ...base,
    comments: existing.comments || [],
    reviewStatus: existing.reviewStatus || "idle",
    reviewStartedAt: existing.reviewStartedAt,
    reviewFinishedAt: existing.reviewFinishedAt,
    skipReason: existing.skipReason,
    error: existing.error,
    provider: existing.provider,
    modelName: existing.modelName,
    conclusion: existing.conclusion,
    generalComment: existing.generalComment,
  };
}

async function writeState(state: ReviewerState) {
  await ensureDataDir();
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}

export async function loadReviewerState(): Promise<ReviewerState> {
  try {
    const raw = await fs.readFile(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw) as ReviewerState;
    return {
      group: parsed.group || null,
      reviewRun: {
        running: false,
        startedAt: parsed.reviewRun?.startedAt,
        finishedAt: parsed.reviewRun?.finishedAt,
        currentPrUrl: undefined,
        error: parsed.reviewRun?.error,
      },
      students: Array.isArray(parsed.students) ? parsed.students : [],
    };
  } catch {
    return createEmptyState();
  }
}

export async function replaceGroup(
  repositories: string[],
  pulls: OpenPullRequestItem[],
  statuses: Map<string, PrDisplayStatus>
) {
  return updateReviewerState((state) => {
    const previous = new Map(
      state.students.map((student) => [student.prUrl, student])
    );

    state.group = {
      repositories,
      loadedAt: new Date().toISOString(),
    };
    state.students = pulls.map((pull) =>
      mergeStudentState(previous.get(pull.prUrl), pull, statuses.get(pull.prUrl))
    );
  });
}

export async function updateReviewerState(
  updater: (state: ReviewerState) => void | ReviewerState
) {
  const runMutation = async () => {
    const state = await loadReviewerState();
    const next = (await updater(state)) || state;
    await writeState(next);
    return next;
  };

  const pending = mutationChain.then(runMutation, runMutation);
  mutationChain = pending.then(
    () => undefined,
    () => undefined
  );
  return pending;
}

export async function markReviewRunStarted() {
  return updateReviewerState((state) => {
    state.reviewRun = {
      running: true,
      startedAt: new Date().toISOString(),
      finishedAt: undefined,
      currentPrUrl: undefined,
      error: undefined,
    };
  });
}

export async function markReviewRunFinished(error?: string) {
  return updateReviewerState((state) => {
    state.reviewRun = {
      ...state.reviewRun,
      running: false,
      currentPrUrl: undefined,
      finishedAt: new Date().toISOString(),
      error,
    };
  });
}

export async function markStudentReviewRunning(prUrl: string) {
  return updateReviewerState((state) => {
    state.reviewRun.currentPrUrl = prUrl;
    const student = state.students.find((entry) => entry.prUrl === prUrl);
    if (!student) return;
    student.reviewStatus = "running";
    student.reviewStartedAt = new Date().toISOString();
    student.reviewFinishedAt = undefined;
    student.skipReason = undefined;
    student.error = undefined;
  });
}

export async function saveStudentDraftReview(
  prUrl: string,
  payload: {
    provider: string;
    modelName: string;
    conclusion: string;
    generalComment?: string;
    comments: DraftReviewComment[];
  }
) {
  return updateReviewerState((state) => {
    const student = state.students.find((entry) => entry.prUrl === prUrl);
    if (!student) return;
    student.reviewStatus = "ready";
    student.reviewFinishedAt = new Date().toISOString();
    student.provider = payload.provider;
    student.modelName = payload.modelName;
    student.conclusion = payload.conclusion;
    student.generalComment = payload.generalComment;
    student.skipReason = undefined;
    student.error = undefined;

    const existingComments = new Map(
      student.comments.map((comment) => [comment.id, comment])
    );

    student.comments = payload.comments.map((comment) => {
      const previous = existingComments.get(comment.id);
      if (!previous) return normalizeComment(comment);
      return {
        ...previous,
        ...comment,
        originalComment: previous.originalComment || comment.comment,
        currentComment: previous.currentComment || comment.comment,
        decision: previous.decision || "pending",
        decidedAt: previous.decidedAt,
      };
    });
  });
}

export async function saveStudentSkippedReview(prUrl: string, skipReason: string) {
  return updateReviewerState((state) => {
    const student = state.students.find((entry) => entry.prUrl === prUrl);
    if (!student) return;
    student.reviewStatus = "skipped";
    student.skipReason = skipReason;
    student.reviewFinishedAt = new Date().toISOString();
    student.error = undefined;
  });
}

export async function saveStudentReviewError(prUrl: string, error: string) {
  return updateReviewerState((state) => {
    const student = state.students.find((entry) => entry.prUrl === prUrl);
    if (!student) return;
    student.reviewStatus = "error";
    student.error = error;
    student.reviewFinishedAt = new Date().toISOString();
  });
}

export async function updateStudentPrStatuses(statuses: Map<string, PrDisplayStatus>) {
  return updateReviewerState((state) => {
    for (const student of state.students) {
      const status = statuses.get(student.prUrl);
      if (status) student.prStatus = status;
    }
  });
}

export async function updateCommentText(
  prUrl: string,
  commentId: string,
  text: string
) {
  return updateReviewerState((state) => {
    const student = state.students.find((entry) => entry.prUrl === prUrl);
    const comment = student?.comments.find((entry) => entry.id === commentId);
    if (!comment) return;
    comment.currentComment = text;
  });
}

export async function setCommentDecision(
  prUrl: string,
  commentId: string,
  decision: ReviewerDecision,
  text?: string
) {
  return updateReviewerState((state) => {
    const student = state.students.find((entry) => entry.prUrl === prUrl);
    const comment = student?.comments.find((entry) => entry.id === commentId);
    if (!comment) return;
    if (typeof text === "string") {
      comment.currentComment = text;
    }
    comment.decision = decision;
    comment.decidedAt = new Date().toISOString();
  });
}

export async function appendApprovedComment(record: ApprovedCommentRecord) {
  await ensureDataDir();
  await fs.appendFile(APPROVALS_LOG_FILE, `${JSON.stringify(record)}\n`);
}
