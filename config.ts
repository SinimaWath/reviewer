export const CONFIG = {
  MODEL_NAME: "gemini-2.5-flash",
  MAX_LINES_PER_FILE: 1000,
  CONTEXT_PADDING: 2,
  MODULE_REGEX: /^[0-9]{2}-[\w-]+$/,
  MODULE_SECTION_PATTERN:
    /##\s+([0-9]{2}-[\w-]+)[\s\S]*?(?=\n##\s+[0-9]{2}-|$)/g,
  PATH_TO_SOLUTIONS: `/Users/vlad-tarasov/LearnJs/tasks-js-3`,
};
