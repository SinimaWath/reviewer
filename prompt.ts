import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { CONFIG } from "./config.ts";
import { GitHubService } from "./github.ts";

export interface PromptContext {
  moduleInstructions: string;
  taskInstructions: string;
  taskSolutions: string;
}

let templateCache: string | null = null;
let systemTemplateCache: string | null = null;

const SOLUTION_REPO = {
  owner: "SinimaWath",
  repo: "tasks-js-3",
  ref: "master",
};

export async function loadContext(
  octokit: any,
  context: any,
  changedFiles: Array<any>
): Promise<PromptContext | null> {
  const modules = new Set<string>();
  changedFiles.forEach((f) => {
    const root = f.filename.split("/")[0];
    if (CONFIG.MODULE_REGEX.test(root)) modules.add(root);
  });
  const moduleList = [...modules];

  const tasks = new Set<string>();
  changedFiles.forEach((f) => {
    const [mod, task] = f.filename.split("/");
    if (CONFIG.MODULE_REGEX.test(mod) && task) tasks.add(`${mod}/${task}`);
  });

  if (moduleList.length === 0) return null;

  const taskPrompts: string[] = [];
  const solutionPrompts: string[] = [];
  for (const t of tasks) {
    const readmePath = `${t}/README.md`;
    const content = await GitHubService.fetchFileContent(
      octokit,
      context.owner,
      context.repo,
      context.ref,
      readmePath
    );
    if (content) taskPrompts.push(`### Task: ${t}\n${content}`);

    const solutionPath = `${t}/solution`;
    const solutionFiles = await GitHubService.fetchDirectoryFiles(
      octokit,
      SOLUTION_REPO.owner,
      SOLUTION_REPO.repo,
      SOLUTION_REPO.ref,
      solutionPath
    );
    if (solutionFiles.length) {
      const formatted = solutionFiles
        .map((file) => {
          const relativePath =
            path.relative(solutionPath, file.path) || path.basename(file.path);
          return `#### ${relativePath}\n${file.content}`;
        })
        .join("\n\n");
      solutionPrompts.push(`### Task Solution: ${t}\n${formatted}`);
    }
  }

  let moduleInstructions = "";
  try {
    const currentDir = path.dirname(fileURLToPath(import.meta.url));
    const instructionsPath = path.resolve(
      currentDir,
      "instructions/modules.md"
    );
    const fileContent = await fs.readFile(instructionsPath, "utf8");

    const sections: Record<string, string> = {};
    let match;
    while ((match = CONFIG.MODULE_SECTION_PATTERN.exec(fileContent)) !== null) {
      sections[match[1]] = match[0].trim();
    }

    const getModuleNumber = (id: string) => {
      const matchNumber = /^(\d{2})-/.exec(id);
      return matchNumber ? Number(matchNumber[1]) : null;
    };

    const moduleNumbers = moduleList
      .map(getModuleNumber)
      .filter((num): num is number => Number.isFinite(num));
    const maxModuleNumber = moduleNumbers.length
      ? Math.max(...moduleNumbers)
      : null;

    if (maxModuleNumber === null) {
      moduleInstructions = moduleList
        .map((id) => sections[id] || "")
        .join("\n\n");
    } else {
      const orderedIds = Object.keys(sections).sort(
        (a, b) =>
          (getModuleNumber(a) ?? Infinity) - (getModuleNumber(b) ?? Infinity)
      );

      const idsToInclude = orderedIds.filter((id) => {
        const num = getModuleNumber(id);
        return Number.isFinite(num) && num <= maxModuleNumber;
      });

      moduleInstructions = idsToInclude
        .map((id) => sections[id])
        .filter(Boolean)
        .join("\n\n");
    }
  } catch (e: any) {
    console.warn("Could not load local module instructions:", e.message);
  }

  return {
    moduleInstructions,
    taskInstructions: taskPrompts.join("\n\n"),
    taskSolutions: solutionPrompts.join("\n\n"),
  };
}

async function loadPromptTemplate() {
  if (templateCache) return templateCache;
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const promptPath = path.resolve(currentDir, "instructions/rules/student.md");
  templateCache = await fs.readFile(promptPath, "utf8");
  return templateCache;
}

async function loadSystemPromptTemplate() {
  if (systemTemplateCache) return systemTemplateCache;
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const promptPath = path.resolve(currentDir, "instructions/rules/system.md");
  systemTemplateCache = await fs.readFile(promptPath, "utf8");
  return systemTemplateCache;
}

export async function generatePrompt(
  moduleCtx: string,
  taskCtx: string,
  snippets: string,
  taskSolution: string
) {
  const prompt = (await loadPromptTemplate()).replace(
    /{{SNIPPETS}}/g,
    snippets || "No parseable changes found."
  );

  const system = (await loadSystemPromptTemplate())
    .replace(/{{MODULE_CTX}}/g, moduleCtx || "Нет данных по модулям.")
    .replace(/{{TASK_CTX}}/g, taskCtx || "Нет описания задач.")
    .replace(/{{TASK_SOLUTION}}/g, taskSolution || "Нет решений по задачам.");

  return { prompt, system };
}
