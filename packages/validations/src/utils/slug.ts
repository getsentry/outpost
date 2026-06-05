import z from "zod";

export const slugValidation = z.string().min(3).max(50);
