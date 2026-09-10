/**
 * Which account a post is delivered to — the question that had one hard-coded
 * answer for every platform.
 *
 * The production failure this file is written against: an Instagram
 * Professional account connected through Instagram Login authorised, was
 * discovered, was attached, showed CONNECTED with its username on the card —
 * and refused to publish with "No Page is attached to this connection. Choose
 * one first." The connection was never going to have a Page. Both places that
 * resolved a publishing target selected `kind: PAGE` unconditionally, so the
 * lookup could only ever succeed for Facebook.
 *
 * These tests pin the two flows apart, because the fix is only correct if both
 * survive it: a direct Instagram connection resolves its own account with no
 * Page anywhere in the tenant, and a Meta connection keeps resolving its Page
 * and the Instagram account discovered underneath it.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { ExternalAccountKind, IntegrationStatus, Platform } from '@prisma/client';

import { agent, createTenant, prisma, resetDatabase, type Tenant } from './helpers.js';
import {
  noTargetMessage,
  resolvePublishingTarget,
  resolveTargetForIntegration,
  targetKindFor,
} from '../src/services/publishing/target.js';
import { encryptSecret } from '../src/lib/crypto.js';
import { INSTAGRAM_LOGIN_API } from '../src/services/integrations/instagram.js';

const KEY = 'Zm9yLXRlc3Rpbmctb25seS0zMi1ieXRlLWtleS0hIQ==';

/** The exact account from the production report, minus the real token. */
const IG_PROFESSIONAL_ID = '17841427409088548';
const IG_USERNAME = 'norivaglobal';

describe('publishing target resolution', () => {
  /** Instagram Login: one integration, one Instagram account, no Page at all. */
  let direct: Tenant;
  /** Meta: a Page, with an Instagram account discovered underneath it. */
  let meta: Tenant;
  let directIntegrationId = '';
  let metaIntegrationId = '';

  beforeAll(async () => {
    process.env.TOKEN_ENCRYPTION_KEY = KEY;
    await resetDatabase();
    direct = await createTenant('target-direct');
    meta = await createTenant('target-meta');

    const directIntegration = await prisma.integration.create({
      data: {
        organizationId: direct.organizationId,
        clientId: direct.clientId,
        platform: Platform.INSTAGRAM,
        status: IntegrationStatus.CONNECTED,
        accountName: IG_USERNAME,
        accountId: IG_PROFESSIONAL_ID,
        scopes: ['instagram_business_basic', 'instagram_business_content_publish'],
        accessTokenEnc: encryptSecret('ig-login-token'),
        accounts: {
          create: [
            {
              clientId: direct.clientId,
              kind: ExternalAccountKind.INSTAGRAM,
              externalId: IG_PROFESSIONAL_ID,
              name: IG_USERNAME,
              username: IG_USERNAME,
              selected: true,
              accessTokenEnc: encryptSecret('ig-login-token'),
              metadata: { api: INSTAGRAM_LOGIN_API, accountType: 'BUSINESS' },
            },
          ],
        },
      },
    });
    directIntegrationId = directIntegration.id;

    const metaIntegration = await prisma.integration.create({
      data: {
        organizationId: meta.organizationId,
        clientId: meta.clientId,
        platform: Platform.FACEBOOK,
        status: IntegrationStatus.CONNECTED,
        accountName: 'Meta Operator',
        accessTokenEnc: encryptSecret('user-token'),
        accounts: {
          create: [
            {
              clientId: meta.clientId,
              kind: ExternalAccountKind.PAGE,
              externalId: 'page-900',
              name: 'Zaytoun Kitchen',
              selected: true,
              accessTokenEnc: encryptSecret('page-token'),
            },
            {
              clientId: meta.clientId,
              kind: ExternalAccountKind.INSTAGRAM,
              externalId: 'ig-under-page-900',
              name: 'zaytoun.kitchen',
              parentExternalId: 'page-900',
              selected: true,
              accessTokenEnc: encryptSecret('page-token'),
            },
          ],
        },
      },
    });
    metaIntegrationId = metaIntegration.id;
  });

  // ------------------------------------------------- the reported failure

  it('resolves a direct Instagram Login account with no Facebook Page anywhere', async () => {
    // The tenant has no PAGE row at all — the state the production account is in.
    const pages = await prisma.integrationAccount.count({
      where: { clientId: direct.clientId, kind: ExternalAccountKind.PAGE },
    });
    expect(pages).toBe(0);

    const target = await resolvePublishingTarget({
      prisma,
      organizationId: direct.organizationId,
      clientId: direct.clientId,
      platform: Platform.INSTAGRAM,
    });

    expect(target).not.toBeNull();
    expect(target!.externalId).toBe(IG_PROFESSIONAL_ID);
    expect(target!.name).toBe(IG_USERNAME);
    expect(target!.kind).toBe(ExternalAccountKind.INSTAGRAM);
    expect(target!.accessTokenEnc).toBeTruthy();
    // The marker the publisher reads to pick graph.instagram.com.
    expect(target!.metadata.api).toBe(INSTAGRAM_LOGIN_API);
  });

  it('resolves the same account from the connection itself, as test-publish does', async () => {
    const target = await resolveTargetForIntegration({
      prisma,
      integrationId: directIntegrationId,
      platform: Platform.INSTAGRAM,
    });

    expect(target).not.toBeNull();
    expect(target!.externalId).toBe(IG_PROFESSIONAL_ID);
  });

  it('never asks a direct Instagram connection for a Page', async () => {
    expect(targetKindFor(Platform.INSTAGRAM)).toBe(ExternalAccountKind.INSTAGRAM);
    expect(noTargetMessage(Platform.INSTAGRAM)).toBe(
      'No Instagram account is attached to this connection. Choose one first.',
    );
    expect(noTargetMessage(Platform.INSTAGRAM)).not.toMatch(/Page/);
  });

  it('reaches the publisher instead of refusing at the target lookup', async () => {
    // The end of the reported path: POST /test-publish on the Instagram
    // connection. It must get past target resolution — the provider's own
    // answer about the post is a different matter, and Instagram's refusal of a
    // text-only post is a true statement about Instagram, not a missing Page.
    const client = agent();
    await client.login(direct.adminEmail);

    const response = await client.post(`/api/integrations/${directIntegrationId}/test-publish`, {
      message: 'Marketing OS connection check.',
    });

    expect(response.status).not.toBe(400);
    expect(JSON.stringify(response.body)).not.toMatch(/No Page is attached/);
    /*
     * What it gets instead is Instagram's own constraint: the Content
     * Publishing API has no text-only post. That is a true statement about
     * Instagram rather than a missing Page, it arrives from the publisher
     * (which the request had to reach to produce it), and the dialog now says
     * it before the button is pressed.
     */
    expect(response.status).toBe(502);
    expect(response.body.error.message).toMatch(/image/i);
  });

  // --------------------------------------------------- the Meta flow, intact

  it('still resolves the Facebook Page for a Meta connection', async () => {
    const target = await resolvePublishingTarget({
      prisma,
      organizationId: meta.organizationId,
      clientId: meta.clientId,
      platform: Platform.FACEBOOK,
    });

    expect(target!.kind).toBe(ExternalAccountKind.PAGE);
    expect(target!.externalId).toBe('page-900');
    expect(noTargetMessage(Platform.FACEBOOK)).toMatch(/Facebook Page/);
  });

  it('resolves the Instagram account discovered under a Page, which has no Instagram integration', async () => {
    // The second Instagram path: the account is an asset of the Meta
    // connection, so the lookup has to cross from Platform.INSTAGRAM to the
    // FACEBOOK integration that owns it. Before this resolver existed, nothing
    // did — Instagram publishing was unreachable through Meta as well.
    const integrations = await prisma.integration.count({
      where: { clientId: meta.clientId, platform: Platform.INSTAGRAM },
    });
    expect(integrations).toBe(0);

    const target = await resolvePublishingTarget({
      prisma,
      organizationId: meta.organizationId,
      clientId: meta.clientId,
      platform: Platform.INSTAGRAM,
    });

    expect(target).not.toBeNull();
    expect(target!.externalId).toBe('ig-under-page-900');
    expect(target!.kind).toBe(ExternalAccountKind.INSTAGRAM);
    // No Instagram-Login marker: this token came from Meta and must be used
    // against graph.facebook.com.
    expect(target!.metadata.api).toBeUndefined();
  });

  it('still refuses the Meta connection a test publish when no Page is chosen', async () => {
    await prisma.integrationAccount.updateMany({
      where: { integrationId: metaIntegrationId, kind: ExternalAccountKind.PAGE },
      data: { selected: false },
    });

    const client = agent();
    await client.login(meta.adminEmail);
    const response = await client.post(`/api/integrations/${metaIntegrationId}/test-publish`, {
      message: 'Marketing OS connection check.',
    });

    expect(response.status).toBe(400);
    // Facebook's target is a Page, and it says so.
    expect(response.body.error.message).toMatch(/No Facebook Page is attached/);

    await prisma.integrationAccount.updateMany({
      where: { integrationId: metaIntegrationId, kind: ExternalAccountKind.PAGE },
      data: { selected: true },
    });
  });

  // --------------------------------------------------------- tenant scoping

  it('never resolves a target belonging to another tenant', async () => {
    const target = await resolvePublishingTarget({
      prisma,
      // Direct's organization, Meta's client: a lookup that ignored either
      // would return an account this tenant may not publish to.
      organizationId: direct.organizationId,
      clientId: meta.clientId,
      platform: Platform.INSTAGRAM,
    });

    expect(target).toBeNull();
  });
});
