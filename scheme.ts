import z from "zod";

export const reviewSchema = z.object({
  conclusion: z.enum(["APPROVE", "REQUEST_CHANGES"]),
  general_comment: z
    .string()
    .min(1)
    .describe(`Russian. Concise summary, MAXIMUM 2 sentences`),
  comments: z
    .array(
      z.object({
        filepath: z.string().min(1).describe("Путь к файлу"),
        start_line: z.number().int().nonnegative(),
        end_line: z.number().int().nonnegative(),
        comment: z
          .string()
          .min(1)
          .describe("Russian. Use markdown `code` for variables/suggestions."),
      })
    )
    .describe("Список точечных комментариев"),
});
