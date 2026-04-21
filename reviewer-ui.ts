import http from "http";
import { Octokit } from "@octokit/rest";
import {
  appendApprovedComment,
  loadReviewerState,
  markReviewRunFinished,
  markReviewRunStarted,
  markStudentReviewRunning,
  replaceGroup,
  saveStudentDraftReview,
  saveStudentReviewError,
  saveStudentSkippedReview,
  setCommentDecision,
  updateCommentText,
  updateStudentPrStatuses,
} from "./reviewer-store.ts";
import {
  fetchGroupOpenPullRequests,
  formatRuTimestamp,
  generateReviewDraft,
  getPrStatusLine,
  resolveActor,
  splitRepositoryInput,
} from "./review-core.ts";

const PORT = Number(process.env.REVIEWER_UI_PORT || 3080);

type JsonRecord = Record<string, any>;

function sendJson(res: http.ServerResponse, statusCode: number, payload: JsonRecord) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

function sendHtml(res: http.ServerResponse, html: string) {
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(html);
}

async function readJsonBody(req: http.IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  return raw ? JSON.parse(raw) : {};
}

async function collectStatuses(prUrls: string[]) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("Missing GITHUB_TOKEN");

  const octokit = new Octokit({ auth: token });
  const actor = await resolveActor(token);
  const statusEntries = await Promise.all(
    prUrls.map(async (prUrl) => {
      try {
        const status = await getPrStatusLine(octokit, prUrl, actor);
        return [prUrl, status] as const;
      } catch (error: any) {
        return [
          prUrl,
          {
            label: `Status error: ${error.message}`,
            emoji: "⚠️",
            atIso: new Date().toISOString(),
            showRunHint: false,
          },
        ] as const;
      }
    })
  );

  return new Map(statusEntries);
}

let reviewRunPromise: Promise<void> | null = null;

async function runBatchReview() {
  const currentState = await loadReviewerState();
  if (!currentState.group?.repositories?.length) {
    throw new Error("Сначала загрузите группу.");
  }

  await markReviewRunStarted();

  try {
    for (const student of currentState.students) {
      await markStudentReviewRunning(student.prUrl);
      try {
        const prepared = await generateReviewDraft(student.prUrl, {
          respectRemoteSkip: false,
        });

        if (prepared.status === "skipped") {
          await saveStudentSkippedReview(
            student.prUrl,
            prepared.skipReason || "Review skipped."
          );
          continue;
        }

        await saveStudentDraftReview(student.prUrl, {
          provider: prepared.provider,
          modelName: prepared.modelName,
          conclusion: prepared.reviewData?.conclusion || "REQUEST_CHANGES",
          generalComment: prepared.reviewData?.general_comment,
          comments: prepared.draftComments || [],
        });
      } catch (error: any) {
        await saveStudentReviewError(
          student.prUrl,
          error?.message || String(error)
        );
      }
    }

    const refreshed = await loadReviewerState();
    const statuses = await collectStatuses(refreshed.students.map((entry) => entry.prUrl));
    await updateStudentPrStatuses(statuses);
    await markReviewRunFinished();
  } catch (error: any) {
    await markReviewRunFinished(error?.message || String(error));
    throw error;
  }
}

function ensureReviewRunStarted() {
  if (reviewRunPromise) {
    return reviewRunPromise;
  }

  reviewRunPromise = runBatchReview().finally(() => {
    reviewRunPromise = null;
  });

  return reviewRunPromise;
}

function buildIndexHtml() {
  return `<!doctype html>
<html lang="ru">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>AI Reviewer Draft UI</title>
    <style>
      :root {
        color-scheme: dark;
        --bg: #0b1020;
        --panel: #121934;
        --panel-2: #192347;
        --panel-3: #22305f;
        --text: #e8ecff;
        --muted: #9eabd6;
        --border: #30406f;
        --accent: #75a3ff;
        --good: #2ca66f;
        --bad: #d34f64;
        --warn: #c6922b;
      }

      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: linear-gradient(180deg, #0a0f1f 0%, #0d1530 100%);
        color: var(--text);
      }

      button, textarea {
        font: inherit;
      }

      a { color: var(--accent); }

      .layout {
        display: grid;
        grid-template-columns: 360px 1fr;
        min-height: 100vh;
      }

      .sidebar {
        border-right: 1px solid var(--border);
        background: rgba(10, 15, 31, 0.85);
        padding: 24px;
        position: sticky;
        top: 0;
        height: 100vh;
        overflow: auto;
      }

      .main {
        padding: 24px;
      }

      .panel {
        background: rgba(18, 25, 52, 0.94);
        border: 1px solid var(--border);
        border-radius: 18px;
        padding: 18px;
        box-shadow: 0 12px 40px rgba(0, 0, 0, 0.25);
      }

      .panel + .panel {
        margin-top: 18px;
      }

      .title {
        margin: 0 0 8px;
        font-size: 28px;
      }

      .subtitle {
        color: var(--muted);
        margin: 0 0 18px;
        line-height: 1.5;
      }

      .toolbar {
        display: flex;
        gap: 12px;
        flex-wrap: wrap;
        margin-top: 14px;
      }

      .toolbar button {
        border: 0;
        border-radius: 12px;
        padding: 12px 16px;
        background: var(--panel-3);
        color: var(--text);
        cursor: pointer;
        transition: transform 0.15s ease, opacity 0.15s ease;
      }

      .toolbar button.primary {
        background: linear-gradient(135deg, #4783ff, #7b67ff);
      }

      .toolbar button:disabled {
        opacity: 0.55;
        cursor: not-allowed;
      }

      .toolbar button:hover:not(:disabled) {
        transform: translateY(-1px);
      }

      textarea.group-input {
        width: 100%;
        min-height: 132px;
        border-radius: 14px;
        border: 1px solid var(--border);
        background: #0c1430;
        color: var(--text);
        padding: 14px;
        resize: vertical;
      }

      .meta-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
        gap: 12px;
      }

      .metric {
        background: rgba(34, 48, 95, 0.45);
        border: 1px solid var(--border);
        border-radius: 16px;
        padding: 14px;
      }

      .metric-label {
        display: block;
        color: var(--muted);
        font-size: 13px;
        margin-bottom: 8px;
      }

      .metric-value {
        font-size: 20px;
        font-weight: 700;
      }

      .student-list {
        display: flex;
        flex-direction: column;
        gap: 10px;
        margin-top: 16px;
      }

      .student-card {
        width: 100%;
        text-align: left;
        border: 1px solid var(--border);
        border-radius: 16px;
        background: rgba(25, 35, 71, 0.7);
        padding: 14px;
        color: var(--text);
        cursor: pointer;
      }

      .student-card.active {
        border-color: var(--accent);
        background: rgba(45, 74, 145, 0.4);
      }

      .student-card-line {
        display: flex;
        justify-content: space-between;
        gap: 12px;
      }

      .student-card small,
      .muted {
        color: var(--muted);
      }

      .chip {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        border-radius: 999px;
        padding: 6px 10px;
        font-size: 12px;
        font-weight: 600;
        background: rgba(48, 64, 111, 0.55);
        border: 1px solid var(--border);
      }

      .chip.good { color: #9ff0c9; border-color: rgba(44,166,111,0.5); }
      .chip.bad { color: #ffb0be; border-color: rgba(211,79,100,0.5); }
      .chip.warn { color: #ffd88a; border-color: rgba(198,146,43,0.5); }

      .comments {
        display: flex;
        flex-direction: column;
        gap: 14px;
        margin-top: 18px;
      }

      .comment-card {
        border: 1px solid var(--border);
        border-radius: 18px;
        padding: 16px;
        background: rgba(16, 24, 49, 0.9);
      }

      .comment-head {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        align-items: center;
        flex-wrap: wrap;
        margin-bottom: 12px;
      }

      .comment-title {
        font-weight: 700;
      }

      .comment-grid {
        display: grid;
        grid-template-columns: minmax(280px, 1fr) minmax(280px, 1fr);
        gap: 14px;
      }

      .comment-card textarea {
        width: 100%;
        min-height: 130px;
        border-radius: 12px;
        border: 1px solid var(--border);
        background: #0b1430;
        color: var(--text);
        padding: 12px;
        resize: vertical;
      }

      pre {
        margin: 0;
        white-space: pre-wrap;
        word-break: break-word;
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 13px;
        line-height: 1.5;
      }

      .snippet-box {
        border: 1px solid var(--border);
        border-radius: 12px;
        background: #0a1126;
        padding: 12px;
        min-height: 130px;
      }

      .actions {
        display: flex;
        gap: 10px;
        margin-top: 12px;
        flex-wrap: wrap;
      }

      .actions button {
        border: 0;
        border-radius: 12px;
        padding: 10px 14px;
        cursor: pointer;
      }

      .approve { background: rgba(44, 166, 111, 0.2); color: #b7ffd9; }
      .reject { background: rgba(211, 79, 100, 0.18); color: #ffc2cc; }
      .save { background: rgba(117, 163, 255, 0.18); color: #d8e5ff; }

      .empty {
        color: var(--muted);
        padding: 26px;
        text-align: center;
      }

      .banner {
        margin-top: 16px;
        padding: 12px 14px;
        border-radius: 14px;
        background: rgba(48, 64, 111, 0.4);
        border: 1px solid var(--border);
      }

      .banner.error {
        border-color: rgba(211,79,100,0.55);
        background: rgba(211,79,100,0.12);
      }

      .summary {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        margin-bottom: 16px;
      }

      @media (max-width: 1024px) {
        .layout { grid-template-columns: 1fr; }
        .sidebar { position: static; height: auto; }
        .comment-grid { grid-template-columns: 1fr; }
      }
    </style>
  </head>
  <body>
    <div id="app"></div>
    <script>
      const app = document.getElementById("app");
      const state = {
        data: null,
        selectedPrUrl: null,
        busy: false,
        message: "",
        error: "",
        groupInput: "",
      };

      function escapeHtml(value) {
        return String(value ?? "")
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;")
          .replaceAll('"', "&quot;")
          .replaceAll("'", "&#39;");
      }

      function statusChipClass(label = "") {
        if (/approved|ready/i.test(label)) return "good";
        if (/error|rejected|changes/i.test(label)) return "bad";
        if (/running|pending|skipped|have updates/i.test(label)) return "warn";
        return "";
      }

      function activeStudent() {
        const students = state.data?.students || [];
        return (
          students.find((student) => student.prUrl === state.selectedPrUrl) ||
          students[0] ||
          null
        );
      }

      function counts() {
        const students = state.data?.students || [];
        const comments = students.flatMap((student) => student.comments || []);
        return {
          students: students.length,
          ready: students.filter((student) => student.reviewStatus === "ready").length,
          approved: comments.filter((comment) => comment.decision === "approved").length,
          rejected: comments.filter((comment) => comment.decision === "rejected").length,
        };
      }

      function render() {
        const data = state.data || { group: null, reviewRun: { running: false }, students: [] };
        const selected = activeStudent();
        const metrics = counts();
        const runMessage = data.reviewRun?.running
          ? "AI reviewer сейчас обрабатывает группу и сохраняет draft-комментарии локально."
          : data.reviewRun?.finishedAt
            ? "Последний запуск завершен."
            : "Запуск ревью еще не выполнялся.";

        app.innerHTML = \`
          <div class="layout">
            <aside class="sidebar">
              <div class="panel">
                <h1 class="title">Reviewer Draft UI</h1>
                <p class="subtitle">
                  Загрузи группу репозиториев, запусти AI reviewer без отправки в GitHub
                  и вручную прими или отклони каждый draft-комментарий.
                </p>

                <label class="muted" for="group-input">Список репозиториев группы</label>
                <textarea id="group-input" class="group-input" placeholder="org/student-repo-1&#10;org/student-repo-2">\${escapeHtml(
                  state.groupInput || (data.group?.repositories || []).join("\\n")
                )}</textarea>

                <div class="toolbar">
                  <button class="primary" id="load-group" \${state.busy ? "disabled" : ""}>Загрузить группу</button>
                  <button id="start-review" \${state.busy || !data.students.length || data.reviewRun?.running ? "disabled" : ""}>Начать ревью</button>
                </div>

                <div class="banner \${state.error ? "error" : ""}" style="\${state.message || state.error ? "" : "display:none;"}">
                  \${escapeHtml(state.error || state.message)}
                </div>
              </div>

              <div class="panel">
                <div class="meta-grid">
                  <div class="metric">
                    <span class="metric-label">Студентов / PR</span>
                    <span class="metric-value">\${metrics.students}</span>
                  </div>
                  <div class="metric">
                    <span class="metric-label">Draft готов</span>
                    <span class="metric-value">\${metrics.ready}</span>
                  </div>
                  <div class="metric">
                    <span class="metric-label">Approve</span>
                    <span class="metric-value">\${metrics.approved}</span>
                  </div>
                  <div class="metric">
                    <span class="metric-label">Reject</span>
                    <span class="metric-value">\${metrics.rejected}</span>
                  </div>
                </div>
                <div class="banner" style="margin-top:14px;">\${escapeHtml(runMessage)}</div>
              </div>

              <div class="panel">
                <div class="student-card-line">
                  <strong>Студенты с открытыми MR</strong>
                  <small>\${escapeHtml(data.group?.loadedAt ? new Date(data.group.loadedAt).toLocaleString("ru-RU") : "")}</small>
                </div>
                <div class="student-list">
                  \${(data.students || []).map((student) => \`
                    <button class="student-card \${selected?.prUrl === student.prUrl ? "active" : ""}" data-select-pr="\${escapeHtml(student.prUrl)}">
                      <div class="student-card-line">
                        <strong>\${escapeHtml(student.author)}</strong>
                        <span class="chip \${statusChipClass(student.reviewStatus)}">\${escapeHtml(student.reviewStatus)}</span>
                      </div>
                      <div class="student-card-line" style="margin-top:8px;">
                        <small>#\${student.prNumber} · \${escapeHtml(student.repo)}</small>
                        <small>\${escapeHtml((student.comments || []).length + " comments")}</small>
                      </div>
                      <div style="margin-top:10px; display:flex; flex-wrap:wrap; gap:8px;">
                        \${student.prStatus ? \`<span class="chip \${statusChipClass(student.prStatus.label)}">\${escapeHtml(student.prStatus.emoji + " " + student.prStatus.label)}</span>\` : ""}
                        \${student.modelName ? \`<span class="chip">\${escapeHtml(student.modelName)}</span>\` : ""}
                      </div>
                    </button>
                  \`).join("") || '<div class="empty">После загрузки группы здесь появятся открытые MR студентов.</div>'}
                </div>
              </div>
            </aside>

            <main class="main">
              \${selected ? \`
                <div class="panel">
                  <div class="student-card-line">
                    <div>
                      <h2 style="margin:0 0 6px;">\${escapeHtml(selected.author)} — \${escapeHtml(selected.title)}</h2>
                      <div class="summary">
                        <span class="chip">\${escapeHtml(selected.repo)}</span>
                        <span class="chip \${statusChipClass(selected.reviewStatus)}">AI: \${escapeHtml(selected.reviewStatus)}</span>
                        \${selected.prStatus ? \`<span class="chip \${statusChipClass(selected.prStatus.label)}">PR: \${escapeHtml(selected.prStatus.emoji + " " + selected.prStatus.label)}</span>\` : ""}
                        \${selected.conclusion ? \`<span class="chip \${statusChipClass(selected.conclusion)}">Conclusion: \${escapeHtml(selected.conclusion)}</span>\` : ""}
                      </div>
                    </div>
                    <div style="text-align:right;">
                      <div><a href="\${escapeHtml(selected.prUrl)}" target="_blank" rel="noreferrer">Открыть PR</a></div>
                      <small>\${escapeHtml(selected.reviewFinishedAt ? "Draft обновлен: " + new Date(selected.reviewFinishedAt).toLocaleString("ru-RU") : "")}</small>
                    </div>
                  </div>

                  <div class="banner" style="\${selected.generalComment ? "" : "display:none;"}">
                    <strong>Общий комментарий AI:</strong><br />
                    \${escapeHtml(selected.generalComment || "")}
                  </div>
                  \${selected.skipReason ? \`<div class="banner">\${escapeHtml(selected.skipReason)}</div>\` : ""}
                  \${selected.error ? \`<div class="banner error">\${escapeHtml(selected.error)}</div>\` : ""}
                </div>

                <div class="comments">
                  \${(selected.comments || []).map((comment) => \`
                    <section class="comment-card">
                      <div class="comment-head">
                        <div>
                          <div class="comment-title">\${escapeHtml(comment.filepath)} · строки \${escapeHtml(comment.start_line)}\${comment.end_line && comment.end_line !== comment.start_line ? "-" + escapeHtml(comment.end_line) : ""}</div>
                          <small class="muted">Decision: \${escapeHtml(comment.decision)}\${comment.decidedAt ? " · " + escapeHtml(new Date(comment.decidedAt).toLocaleString("ru-RU")) : ""}</small>
                        </div>
                        <span class="chip \${statusChipClass(comment.decision)}">\${escapeHtml(comment.decision)}</span>
                      </div>

                      <div class="comment-grid">
                        <div>
                          <label class="muted" for="comment-\${escapeHtml(comment.id)}">Текст комментария</label>
                          <textarea id="comment-\${escapeHtml(comment.id)}" data-comment-input="\${escapeHtml(comment.id)}">\${escapeHtml(comment.currentComment)}</textarea>
                          <div class="actions">
                            <button class="save" data-save-comment="\${escapeHtml(comment.id)}">Сохранить текст</button>
                            <button class="approve" data-approve-comment="\${escapeHtml(comment.id)}">Approve</button>
                            <button class="reject" data-reject-comment="\${escapeHtml(comment.id)}">Reject</button>
                          </div>
                        </div>

                        <div>
                          <label class="muted">Snippet</label>
                          <div class="snippet-box"><pre>\${escapeHtml(comment.snippet)}</pre></div>
                        </div>
                      </div>
                    </section>
                  \`).join("") || '<div class="panel empty">У этого студента пока нет AI draft-комментариев.</div>'}
                </div>
              \` : \`
                <div class="panel empty">
                  Выбери студента слева после загрузки группы, чтобы просматривать и модерировать draft-комментарии.
                </div>
              \`}
            </main>
          </div>
        \`;

        bindEvents();
      }

      async function api(path, options = {}) {
        const response = await fetch(path, {
          headers: { "Content-Type": "application/json" },
          ...options,
        });
        const data = await response.json();
        if (!response.ok) {
          throw new Error(data.error || "Request failed");
        }
        return data;
      }

      async function refreshState({ preserveSelection = true } = {}) {
        const data = await api("/api/state");
        state.data = data.state;
        const students = state.data?.students || [];
        if (!preserveSelection || !students.some((student) => student.prUrl === state.selectedPrUrl)) {
          state.selectedPrUrl = students[0]?.prUrl || null;
        }
        render();
      }

      async function loadGroup() {
        const textarea = document.getElementById("group-input");
        state.groupInput = textarea.value;
        state.busy = true;
        state.error = "";
        state.message = "";
        render();
        try {
          const data = await api("/api/group", {
            method: "POST",
            body: JSON.stringify({ repositories: state.groupInput }),
          });
          state.data = data.state;
          state.selectedPrUrl = data.state.students[0]?.prUrl || null;
          state.message = "Группа загружена, список открытых PR обновлен.";
        } catch (error) {
          state.error = error.message;
        } finally {
          state.busy = false;
          render();
        }
      }

      async function startReview() {
        state.busy = true;
        state.error = "";
        state.message = "";
        render();
        try {
          await api("/api/review/start", { method: "POST" });
          state.message = "Запуск AI reviewer начат. Draft-комментарии будут появляться по мере обработки.";
          await refreshState();
        } catch (error) {
          state.error = error.message;
          state.busy = false;
          render();
        }
      }

      async function saveComment(commentId) {
        const student = activeStudent();
        const textarea = document.querySelector('[data-comment-input="' + commentId + '"]');
        if (!student || !textarea) return;
        try {
          await api("/api/comment/text", {
            method: "POST",
            body: JSON.stringify({
              prUrl: student.prUrl,
              commentId,
              text: textarea.value,
            }),
          });
          state.message = "Текст комментария сохранен.";
          state.error = "";
          await refreshState({ preserveSelection: true });
        } catch (error) {
          state.error = error.message;
          render();
        }
      }

      async function setDecision(commentId, decision) {
        const student = activeStudent();
        const textarea = document.querySelector('[data-comment-input="' + commentId + '"]');
        if (!student || !textarea) return;
        try {
          await api("/api/comment/decision", {
            method: "POST",
            body: JSON.stringify({
              prUrl: student.prUrl,
              commentId,
              decision,
              text: textarea.value,
            }),
          });
          state.message = decision === "approved"
            ? "Комментарий одобрен и сохранен для будущего обучения."
            : "Комментарий отклонен.";
          state.error = "";
          await refreshState({ preserveSelection: true });
        } catch (error) {
          state.error = error.message;
          render();
        }
      }

      function bindEvents() {
        document.getElementById("load-group")?.addEventListener("click", loadGroup);
        document.getElementById("start-review")?.addEventListener("click", startReview);

        document.querySelectorAll("[data-select-pr]").forEach((button) => {
          button.addEventListener("click", () => {
            state.selectedPrUrl = button.getAttribute("data-select-pr");
            render();
          });
        });

        document.querySelectorAll("[data-save-comment]").forEach((button) => {
          button.addEventListener("click", () => saveComment(button.getAttribute("data-save-comment")));
        });

        document.querySelectorAll("[data-approve-comment]").forEach((button) => {
          button.addEventListener("click", () => setDecision(button.getAttribute("data-approve-comment"), "approved"));
        });

        document.querySelectorAll("[data-reject-comment]").forEach((button) => {
          button.addEventListener("click", () => setDecision(button.getAttribute("data-reject-comment"), "rejected"));
        });
      }

      refreshState().catch((error) => {
        state.error = error.message;
        render();
      });

      setInterval(async () => {
        try {
          const wasRunning = Boolean(state.data?.reviewRun?.running);
          await refreshState({ preserveSelection: true });
          if (wasRunning && !state.data?.reviewRun?.running) {
            state.busy = false;
            state.message = "AI reviewer завершил текущий проход по группе.";
            render();
          }
        } catch (error) {
          state.error = error.message;
          render();
        }
      }, 5000);
    </script>
  </body>
</html>`;
}

async function handleApi(req: http.IncomingMessage, res: http.ServerResponse) {
  if (req.method === "GET" && req.url === "/api/state") {
    return sendJson(res, 200, { state: await loadReviewerState() });
  }

  if (req.method === "POST" && req.url === "/api/group") {
    const body = await readJsonBody(req);
    const token = process.env.GITHUB_TOKEN;
    if (!token) {
      return sendJson(res, 400, { error: "Missing GITHUB_TOKEN" });
    }

    const repositories = splitRepositoryInput(String(body.repositories || ""));
    if (!repositories.length) {
      return sendJson(res, 400, { error: "Укажи хотя бы один репозиторий группы." });
    }

    const pulls = await fetchGroupOpenPullRequests(token, repositories);
    const statuses = await collectStatuses(pulls.map((entry) => entry.prUrl));
    const state = await replaceGroup(repositories, pulls, statuses);
    return sendJson(res, 200, { state });
  }

  if (req.method === "POST" && req.url === "/api/review/start") {
    const current = await loadReviewerState();
    if (!current.group?.repositories?.length || !current.students.length) {
      return sendJson(res, 400, {
        error: "Сначала загрузите группу с открытыми PR студентов.",
      });
    }

    if (current.reviewRun.running) {
      return sendJson(res, 409, { error: "Ревью уже запущено." });
    }

    ensureReviewRunStarted().catch((error) => {
      console.error("review batch failed:", error);
    });
    return sendJson(res, 202, { ok: true });
  }

  if (req.method === "POST" && req.url === "/api/comment/text") {
    const body = await readJsonBody(req);
    const prUrl = String(body.prUrl || "");
    const commentId = String(body.commentId || "");
    const text = String(body.text || "");

    if (!prUrl || !commentId) {
      return sendJson(res, 400, { error: "prUrl и commentId обязательны." });
    }

    const state = await updateCommentText(prUrl, commentId, text);
    return sendJson(res, 200, { state });
  }

  if (req.method === "POST" && req.url === "/api/comment/decision") {
    const body = await readJsonBody(req);
    const prUrl = String(body.prUrl || "");
    const commentId = String(body.commentId || "");
    const decision = String(body.decision || "");
    const text = String(body.text || "");

    if (!prUrl || !commentId || !["approved", "rejected"].includes(decision)) {
      return sendJson(res, 400, {
        error: "prUrl, commentId и корректное decision обязательны.",
      });
    }

    const state = await setCommentDecision(
      prUrl,
      commentId,
      decision as "approved" | "rejected",
      text
    );

    if (decision === "approved") {
      const student = state.students.find((entry) => entry.prUrl === prUrl);
      const comment = student?.comments.find((entry) => entry.id === commentId);
      if (student && comment) {
        await appendApprovedComment({
          approvedAt: new Date().toISOString(),
          prUrl,
          repoUrl: student.repoUrl,
          prNumber: student.prNumber,
          commentId,
          filepath: comment.filepath,
          startLine: Number(comment.start_line),
          endLine: comment.end_line ? Number(comment.end_line) : undefined,
          originalComment: comment.originalComment,
          approvedComment: comment.currentComment,
          edited: comment.originalComment !== comment.currentComment,
        });
      }
    }

    return sendJson(res, 200, { state });
  }

  sendJson(res, 404, { error: "Not found" });
}

const server = http.createServer(async (req, res) => {
  try {
    if (!req.url) {
      return sendJson(res, 400, { error: "Missing url" });
    }

    if (req.url.startsWith("/api/")) {
      return await handleApi(req, res);
    }

    if (req.method === "GET" && req.url === "/") {
      return sendHtml(res, buildIndexHtml());
    }

    return sendJson(res, 404, { error: "Not found" });
  } catch (error: any) {
    return sendJson(res, 500, { error: error?.message || String(error) });
  }
});

server.listen(PORT, () => {
  console.log(
    `Reviewer UI started on http://127.0.0.1:${PORT} at ${formatRuTimestamp(
      new Date().toISOString()
    )}`
  );
});
