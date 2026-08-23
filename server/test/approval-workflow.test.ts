/**
 * The approval loop, and the transitions it has to refuse.
 *
 * Approval is the only thing standing between a draft and a customer's feed, so
 * most of what matters here is what the workflow will not do: it will not accept
 * the same post for review twice, it will not let a decision be quietly redecided
 * by whoever presses last, and it will not treat published work as something
 * still awaiting sign-off.
 *
 * The history assertions matter for the same reason. An approval record whose
 * decisions can be overwritten in place is not a record — it is only ever the
 * most recent opinion, and nobody can tell afterwards that a rejection happened
 * at all.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { ApprovalStatus, ContentStatus, Platform } from '@prisma/client';

import { agent, createTenant, prisma, resetDatabase, type Tenant } from './helpers.js';

describe('the approval workflow', () => {
  let tenant: Tenant;

  beforeAll(async () => {
    await resetDatabase();
    tenant = await createTenant('approval-flow');
  });

  const admin = async () => {
    const client = agent();
    await client.login(tenant.adminEmail);
    return client;
  };

  const reviewer = async () => {
    const client = agent();
    await client.login(tenant.clientAdminEmail);
    return client;
  };

  /** A fresh draft, so each test starts from a known place in the lifecycle. */
  const draft = async (name: string) => {
    const client = await admin();
    const response = await client.post('/api/content', {
      clientId: tenant.clientId,
      name,
      type: 'POST',
      platform: Platform.FACEBOOK,
      language: 'EN',
      caption: 'Less mess, happier dog.',
      hashtags: [],
      mediaIds: [],
    });
    expect(response.status).toBe(201);
    return { client, id: response.body.content.id as string };
  };

  const pendingApprovalFor = (contentId: string) =>
    prisma.approval.findFirstOrThrow({
      where: { contentId, status: ApprovalStatus.PENDING },
      select: { id: true },
    });

  // ------------------------------------------------------------- submitting

  it('moves a draft to submitted and opens exactly one approval', async () => {
    const { client, id } = await draft('Submit once');

    const response = await client.post(`/api/content/${id}/submit`);

    expect(response.status).toBe(200);
    expect(response.body.content.status).toBe(ContentStatus.SUBMITTED);
    expect(await prisma.approval.count({ where: { contentId: id } })).toBe(1);
  });

  it('refuses a second submission while one is already pending', async () => {
    const { client, id } = await draft('Submit twice');
    await client.post(`/api/content/${id}/submit`);

    const again = await client.post(`/api/content/${id}/submit`);

    // The status guard answers first: SUBMITTED is not a submittable state.
    expect(again.status).toBe(400);
    // The critical assertion: no second reviewer queue entry for the same post.
    expect(await prisma.approval.count({ where: { contentId: id } })).toBe(1);
  });

  it('refuses when a pending approval exists but the status disagrees', async () => {
    const { client, id } = await draft('Divergent state');
    await client.post(`/api/content/${id}/submit`);

    /*
     * Force the two out of step, which is the case the status guard alone cannot
     * catch: a row left mid-flight by a crash, or edited directly. The pending
     * approval is the authority — the post is genuinely with a reviewer.
     */
    await prisma.content.update({ where: { id }, data: { status: ContentStatus.DRAFT } });

    const again = await client.post(`/api/content/${id}/submit`);

    expect(again.status).toBe(409);
    expect(again.body.error.message).toMatch(/already waiting/i);
    expect(await prisma.approval.count({ where: { contentId: id } })).toBe(1);
  });

  it('refuses to send approved content back for approval', async () => {
    const { client, id } = await draft('Already approved');
    await client.post(`/api/content/${id}/submit`);

    const review = await reviewer();
    const approval = await pendingApprovalFor(id);
    await review.post(`/api/approvals/${approval.id}/decision`, { status: ApprovalStatus.APPROVED });

    const resubmit = await client.post(`/api/content/${id}/submit`);
    expect(resubmit.status).toBe(400);
    expect(resubmit.body.error.message).toMatch(/cannot be submitted/i);
  });

  // -------------------------------------------------------------- deciding

  it('approves, and says who decided and when', async () => {
    const { client, id } = await draft('Approve me');
    await client.post(`/api/content/${id}/submit`);
    const approval = await pendingApprovalFor(id);

    const review = await reviewer();
    const decided = await review.post(`/api/approvals/${approval.id}/decision`, {
      status: ApprovalStatus.APPROVED,
      note: 'Looks good.',
    });

    expect(decided.status).toBe(200);
    expect(decided.body.approval.decidedBy.name).toBeTruthy();
    expect(decided.body.approval.decidedAt).toBeTruthy();

    const after = await client.get(`/api/content/${id}`);
    expect(after.body.content.status).toBe(ContentStatus.APPROVED);
  });

  it('refuses to decide the same approval twice', async () => {
    const { client, id } = await draft('Decide once');
    await client.post(`/api/content/${id}/submit`);
    const approval = await pendingApprovalFor(id);

    const review = await reviewer();
    await review.post(`/api/approvals/${approval.id}/decision`, { status: ApprovalStatus.REJECTED, note: 'No.' });

    // Reversing a decision in place would erase that the rejection happened.
    const reversal = await review.post(`/api/approvals/${approval.id}/decision`, {
      status: ApprovalStatus.APPROVED,
      note: 'Actually yes.',
    });

    expect(reversal.status).toBe(409);

    const stored = await prisma.approval.findFirstOrThrow({ where: { id: approval.id } });
    expect(stored.status).toBe(ApprovalStatus.REJECTED);
    expect(stored.note).toBe('No.');
  });

  it('runs the changes-requested loop and keeps both decisions', async () => {
    const { client, id } = await draft('Changes loop');
    await client.post(`/api/content/${id}/submit`);
    const first = await pendingApprovalFor(id);

    const review = await reviewer();
    await review.post(`/api/approvals/${first.id}/decision`, {
      status: ApprovalStatus.CHANGES_REQUESTED,
      note: 'Brighten the photo.',
    });

    const afterChanges = await client.get(`/api/content/${id}`);
    expect(afterChanges.body.content.status).toBe(ContentStatus.CHANGES_REQUESTED);

    // Content sent back is submittable again — that is the whole point of it.
    const resubmit = await client.post(`/api/content/${id}/submit`);
    expect(resubmit.status).toBe(200);

    const second = await pendingApprovalFor(id);
    await review.post(`/api/approvals/${second.id}/decision`, { status: ApprovalStatus.APPROVED });

    // Two rows, not one row twice: the first decision is still on the record.
    const all = await prisma.approval.findMany({ where: { contentId: id }, orderBy: { createdAt: 'asc' } });
    expect(all).toHaveLength(2);
    expect(all[0]?.status).toBe(ApprovalStatus.CHANGES_REQUESTED);
    expect(all[1]?.status).toBe(ApprovalStatus.APPROVED);
  });

  it('will not schedule content that was never approved', async () => {
    const { client, id } = await draft('Unapproved');

    const response = await client.post(`/api/content/${id}/schedule`, {
      scheduledAt: new Date('2026-09-10T17:00:00.000Z').toISOString(),
    });

    expect(response.status).toBe(400);
    expect(response.body.error.message).toMatch(/must be approved/i);
  });

  // -------------------------------------------------------------- timeline

  it('tells the whole story in order', async () => {
    const { client, id } = await draft('Full story');
    await client.post(`/api/content/${id}/submit`);
    const approval = await pendingApprovalFor(id);

    const review = await reviewer();
    await review.post(`/api/approvals/${approval.id}/decision`, {
      status: ApprovalStatus.APPROVED,
      note: 'Ship it.',
    });
    await client.post(`/api/content/${id}/schedule`, {
      scheduledAt: new Date('2026-09-12T17:00:00.000Z').toISOString(),
    });

    const timeline = await client.get(`/api/content/${id}/timeline`);
    expect(timeline.status).toBe(200);

    const kinds = timeline.body.events.map((event: { kind: string }) => event.kind);
    expect(kinds).toContain('CREATED');
    expect(kinds).toContain('SUBMITTED');
    expect(kinds).toContain('APPROVED');
    expect(kinds).toContain('SCHEDULED');

    // Oldest first, and creation cannot come after anything.
    expect(kinds[0]).toBe('CREATED');
    const times = timeline.body.events.map((event: { at: string }) => new Date(event.at).getTime());
    expect([...times].sort((a, b) => a - b)).toEqual(times);

    // The reviewer's own words, attributed.
    const approved = timeline.body.events.find((event: { kind: string }) => event.kind === 'APPROVED');
    expect(approved.note).toBe('Ship it.');
    expect(approved.actor).toBeTruthy();
  });

  it('never leaks the audit log\'s IP addresses into the timeline', async () => {
    const { client, id } = await draft('No leaks');
    const timeline = await client.get(`/api/content/${id}/timeline`);

    // The timeline is built for client reviewers, and the audit log it draws
    // scheduling from carries request IPs and arbitrary metadata.
    const serialized = JSON.stringify(timeline.body);
    expect(serialized).not.toContain('ip');
    expect(serialized).not.toContain('meta');
  });

  it('cannot read another tenant\'s timeline', async () => {
    const { id } = await draft('Private history');
    const other = await createTenant('approval-intruder');

    const intruder = agent();
    await intruder.login(other.adminEmail);

    expect((await intruder.get(`/api/content/${id}/timeline`)).status).toBe(404);
  });
});
