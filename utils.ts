import { jsonrepair } from "jsonrepair";

export function cleanModelJson(raw?: string | null): string {
  if (!raw) return "";
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  const content = fenced ? fenced[1].trim() : raw.trim();

  const firstBrace = content.indexOf("{");
  const lastBrace = content.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    return content.slice(firstBrace, lastBrace + 1);
  }
  return content;
}

export function safeParseJson(raw: string) {
  const cleaned = cleanModelJson(raw);
  try {
    return JSON.parse(cleaned);
  } catch (err) {
    try {
      return JSON.parse(jsonrepair(cleaned));
    } catch (err2: any) {
      throw new Error(`Failed to parse AI response: ${err2.message}`);
    }
  }
}

export function formatFallbackMarkdown(
  conclusion: string,
  general: string,
  comments: Array<any>
) {
  const lines = [`**Review Result:** ${conclusion}`];
  if (general) lines.push(`\n**Overview:** ${general}`);
  if (comments.length) {
    lines.push("\n**Inline Comments:**");
    comments.forEach((c) =>
      lines.push(`- ${c.filepath}:${c.start_line} ${c.comment}`)
    );
  }
  return lines.join("\n");
}
