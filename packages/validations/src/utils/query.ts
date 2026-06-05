import z from "zod";

export const SortOrder = {
  ASC: "asc",
  DESC: "desc",
} as const;

export const queryValidation = z
  .object({
    limit: z.coerce.number().int().positive().max(100).default(10).describe("Maximum number of results to return"),
    offset: z.coerce.number().int().min(0).default(0).describe("Number of results to skip"),
    search: z.string().trim().optional().describe("Search query string"),
    orderBy: z
      .string()
      .trim()
      .optional()
      .describe("Sort field, prefix with - for descending")
      .transform((val) => {
        if (!val) return undefined;

        if (val.startsWith("-")) {
          return {
            column: val.slice(1),
            order: SortOrder.DESC,
          };
        }

        return {
          column: val,
          order: SortOrder.ASC,
        };
      }),
  });

export const clientQueryValidation = z.object({
  limit: z
    .string()
    .refine((value) => queryValidation.pick({ limit: true }).parse({ limit: value }), {
      message: "Limit must be a positive integer",
    })
    .optional(),
  offset: z
    .string()
    .optional()
    .refine((value) => queryValidation.pick({ offset: true }).parse({ offset: value }), {
      message: "Offset must be a positive integer",
    }),
  search: z.string().trim().optional(),
  orderBy: z.string().optional(),
});
