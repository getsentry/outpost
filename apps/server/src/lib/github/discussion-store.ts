import { and, asc, eq } from "drizzle-orm"
import type { DrizzleD1Database } from "drizzle-orm/d1"
import * as dbSchema from "@/db/schema"
import {
  type DiscussionObligation,
  type DiscussionResponseEvidence,
  type DiscussionSourceReference,
  type OpenDiscussionObligation,
  responseMatchesDiscussion,
} from "./discussions"

type Db = DrizzleD1Database<typeof dbSchema>

export type DiscussionRecordInput = {
  eventId: string
  entityKey: string
  repo: string
  installationId: number | null
  obligation: DiscussionObligation
  now?: Date
}

export function makeDiscussionRecord(input: DiscussionRecordInput) {
  const now = input.now ?? new Date()
  const { obligation } = input
  return {
    id: crypto.randomUUID(),
    repo: input.repo,
    prNumber: obligation.prNumber,
    entityKey: input.entityKey,
    sourceKind: obligation.kind,
    sourceCommentId: obligation.sourceCommentId,
    replyToCommentId: obligation.replyToCommentId,
    author: obligation.author,
    body: obligation.body,
    url: obligation.url,
    eventId: input.eventId,
    installationId: input.installationId,
    status: "open",
    outcome: null,
    verifiedAt: null,
    reminderCount: 0,
    // The initial webhook already prompted Jared. Do not turn the first cron
    // after a comment into an immediate duplicate delivery.
    lastRemindedAt: now,
    createdAt: now,
    updatedAt: now,
  }
}

/**
 * Persist an inbound discussion before admitting it to the agent. A redelivery
 * refreshes the current message but never makes a second inbox item.
 */
export async function recordDiscussionObligation(db: Db, input: DiscussionRecordInput): Promise<void> {
  const record = makeDiscussionRecord(input)
  await db
    .insert(dbSchema.githubDiscussionObligations)
    .values(record)
    .onConflictDoUpdate({
      target: [
        dbSchema.githubDiscussionObligations.repo,
        dbSchema.githubDiscussionObligations.sourceKind,
        dbSchema.githubDiscussionObligations.sourceCommentId,
      ],
      set: {
        sourceKind: record.sourceKind,
        replyToCommentId: record.replyToCommentId,
        author: record.author,
        body: record.body,
        url: record.url,
        eventId: record.eventId,
        installationId: record.installationId,
        status: "open",
        outcome: null,
        verifiedAt: null,
        reminderCount: 0,
        lastRemindedAt: record.lastRemindedAt,
        updatedAt: record.updatedAt,
      },
    })
}

export async function listOpenDiscussionObligations(
  db: Db,
  repo: string,
  prNumber: number,
): Promise<OpenDiscussionObligation[]> {
  const rows = await db
    .select({
      id: dbSchema.githubDiscussionObligations.id,
      kind: dbSchema.githubDiscussionObligations.sourceKind,
      sourceCommentId: dbSchema.githubDiscussionObligations.sourceCommentId,
      replyToCommentId: dbSchema.githubDiscussionObligations.replyToCommentId,
      author: dbSchema.githubDiscussionObligations.author,
      body: dbSchema.githubDiscussionObligations.body,
      url: dbSchema.githubDiscussionObligations.url,
    })
    .from(dbSchema.githubDiscussionObligations)
    .where(
      and(
        eq(dbSchema.githubDiscussionObligations.repo, repo),
        eq(dbSchema.githubDiscussionObligations.prNumber, prNumber),
        eq(dbSchema.githubDiscussionObligations.status, "open"),
      ),
    )
    .orderBy(asc(dbSchema.githubDiscussionObligations.createdAt))

  return rows.map((row) => ({
    ...row,
    kind: row.kind as OpenDiscussionObligation["kind"],
  }))
}

/** A deleted comment or dismissed review must not remain in Jared's inbox. */
export async function cancelDiscussionObligation(
  db: Db,
  repo: string,
  source: DiscussionSourceReference,
  now = new Date(),
): Promise<void> {
  await db
    .update(dbSchema.githubDiscussionObligations)
    .set({ status: "cancelled", updatedAt: now })
    .where(
      and(
        eq(dbSchema.githubDiscussionObligations.repo, repo),
        eq(dbSchema.githubDiscussionObligations.sourceKind, source.kind),
        eq(dbSchema.githubDiscussionObligations.sourceCommentId, source.sourceCommentId),
        eq(dbSchema.githubDiscussionObligations.status, "open"),
      ),
    )
}

/** Mark a row closed only after GitHub has delivered Jared's marked reply. */
export async function verifyDiscussionResponse(
  db: Db,
  repo: string,
  response: DiscussionResponseEvidence,
  now = new Date(),
): Promise<void> {
  const obligation = await db.query.githubDiscussionObligations.findFirst({
    where: and(
      eq(dbSchema.githubDiscussionObligations.id, response.obligationId),
      eq(dbSchema.githubDiscussionObligations.repo, repo),
      eq(dbSchema.githubDiscussionObligations.status, "open"),
    ),
    columns: {
      id: true,
      sourceKind: true,
      prNumber: true,
      sourceCommentId: true,
    },
  })
  if (!obligation) return
  if (
    !responseMatchesDiscussion(
      {
        kind: obligation.sourceKind as DiscussionObligation["kind"],
        prNumber: obligation.prNumber,
        sourceCommentId: obligation.sourceCommentId,
        replyToCommentId: obligation.replyToCommentId,
      },
      response,
    )
  ) {
    return
  }

  await db
    .update(dbSchema.githubDiscussionObligations)
    .set({ status: "verified", outcome: response.outcome, verifiedAt: now, updatedAt: now })
    .where(
      and(
        eq(dbSchema.githubDiscussionObligations.id, response.obligationId),
        eq(dbSchema.githubDiscussionObligations.repo, repo),
        eq(dbSchema.githubDiscussionObligations.status, "open"),
      ),
    )
}
