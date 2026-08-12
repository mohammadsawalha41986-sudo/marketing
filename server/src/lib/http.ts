/** Shared request/response helpers. */

import { z } from 'zod';

export const idParam = z.object({ id: z.string().min(1).max(40) });

export const paginationQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().max(200).optional(),
});

export type Pagination = z.infer<typeof paginationQuery>;

export function paginate({ page, pageSize }: Pagination) {
  return { skip: (page - 1) * pageSize, take: pageSize };
}

export function pageResult<T>(items: T[], total: number, { page, pageSize }: Pagination) {
  return {
    items,
    pagination: { page, pageSize, total, pages: Math.max(1, Math.ceil(total / pageSize)) },
  };
}

/** ISO date (YYYY-MM-DD) parsed as UTC midnight. */
export const dateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD')
  .transform((value) => new Date(`${value}T00:00:00.000Z`))
  .refine((date) => !Number.isNaN(date.getTime()), 'Invalid date');

export const dateRangeQuery = z.object({
  from: dateString.optional(),
  to: dateString.optional(),
});

/** Defaults to the trailing 30 days when the caller gives no range. */
export function resolveRange(input: { from?: Date; to?: Date }): { from: Date; to: Date } {
  const to = input.to ?? new Date();
  const from = input.from ?? new Date(to.getTime() - 29 * 86400000);
  return {
    from: new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate())),
    to: new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate())),
  };
}

export const hexColor = z
  .string()
  .regex(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, 'Expected a hex colour such as #6366F1');

/** Decimal columns arrive as Prisma.Decimal; the API always emits numbers. */
export function decimalToNumber<T extends Record<string, unknown>>(row: T, keys: (keyof T)[]): T {
  const output = { ...row };
  for (const key of keys) {
    const value = output[key];
    if (value && typeof value === 'object' && 'toString' in value) {
      output[key] = Number(value.toString()) as T[keyof T];
    }
  }
  return output;
}
