/**
 * Media compatibility, checked before the platform gets a chance to refuse.
 *
 * The case that motivates the whole file: a Reel scheduled with a landscape
 * video. Meta rejects it, but not until publication, which by design is when
 * nobody is watching. Every rule here is checkable from what is already stored.
 *
 * The distinction the tests keep insisting on is WARNING versus INCOMPATIBLE. A
 * ratio a platform will crop is not the same as a file it will not accept, and
 * collapsing both into "invalid" would either block work that would have
 * succeeded or wave through work that cannot.
 */

import { describe, expect, it } from 'vitest';
import { MediaType, Platform } from '@prisma/client';

import { overall, validateMediaForPlatform } from '../src/services/social/media-rules.js';

const video = (over: Partial<Parameters<typeof validateMediaForPlatform>[0]> = {}) => ({
  type: MediaType.VIDEO,
  mimeType: 'video/mp4',
  sizeBytes: 20 * 1024 * 1024,
  width: 1080,
  height: 1920,
  durationSeconds: 30,
  ...over,
});

const image = (over: Partial<Parameters<typeof validateMediaForPlatform>[0]> = {}) => ({
  type: MediaType.IMAGE,
  mimeType: 'image/jpeg',
  sizeBytes: 2 * 1024 * 1024,
  width: 1080,
  height: 1350,
  ...over,
});

describe('media compatibility', () => {
  it('accepts a vertical video for a Reel', () => {
    expect(validateMediaForPlatform(video(), Platform.INSTAGRAM, 'REEL')).toEqual([]);
  });

  it('refuses a still image where the surface needs video', () => {
    const findings = validateMediaForPlatform(image(), Platform.INSTAGRAM, 'REEL');

    expect(overall(findings)).toBe('INCOMPATIBLE');
    expect(findings[0]?.message).toMatch(/needs a video/i);
  });

  it('warns rather than refuses when a ratio will be cropped', () => {
    // A panorama, well outside Instagram's 1.91:1 ceiling. 16:9 would pass —
    // it is inside the range, which is the rule working, not a gap.
    const findings = validateMediaForPlatform(
      image({ width: 2400, height: 800 }), Platform.INSTAGRAM, 'FEED',
    );

    expect(overall(findings)).toBe('WARNING');
    expect(findings[0]?.message).toMatch(/cropped/i);
  });

  it('refuses a landscape video for TikTok', () => {
    const findings = validateMediaForPlatform(
      video({ width: 1920, height: 1080 }), Platform.TIKTOK,
    );

    // The ratio is a warning; TikTok still takes it and crops.
    expect(findings.some((finding) => /9:16/.test(finding.message))).toBe(true);
  });

  it('refuses a video that is too long for the surface', () => {
    const findings = validateMediaForPlatform(
      video({ durationSeconds: 300 }), Platform.INSTAGRAM, 'REEL',
    );

    expect(overall(findings)).toBe('INCOMPATIBLE');
    expect(findings.some((f) => /allows up to 90s/.test(f.message))).toBe(true);
  });

  it('refuses a video that is too short', () => {
    const findings = validateMediaForPlatform(video({ durationSeconds: 1 }), Platform.TIKTOK);
    expect(findings.some((f) => /at least 3s/.test(f.message))).toBe(true);
  });

  it('refuses a file the platform does not accept', () => {
    const findings = validateMediaForPlatform(
      image({ mimeType: 'image/gif' }), Platform.INSTAGRAM, 'FEED',
    );

    expect(overall(findings)).toBe('INCOMPATIBLE');
    expect(findings[0]?.message).toMatch(/does not accept image\/gif/);
  });

  it('refuses a file over the size limit and says both numbers', () => {
    const findings = validateMediaForPlatform(
      image({ sizeBytes: 40 * 1024 * 1024 }), Platform.INSTAGRAM, 'FEED',
    );

    expect(overall(findings)).toBe('INCOMPATIBLE');
    // Both the actual size and the limit, so the operator knows how far over.
    expect(findings[0]?.message).toMatch(/40MB/);
    expect(findings[0]?.message).toMatch(/8MB/);
  });

  it('refuses video where a platform takes only stills', () => {
    const findings = validateMediaForPlatform(video(), Platform.GOOGLE_BUSINESS, 'UPDATE');
    expect(findings[0]?.message).toMatch(/does not accept video/i);
  });

  it('says so honestly when a platform has no rules yet', () => {
    const findings = validateMediaForPlatform(image(), Platform.SNAPCHAT);
    // Not silence, and not a false pass.
    expect(findings[0]?.level).toBe('WARNING');
    expect(findings[0]?.message).toMatch(/no media rules/i);
  });

  it('reports the worst finding across a set', () => {
    expect(overall([
      { level: 'OK', message: '' },
      { level: 'WARNING', message: '' },
    ])).toBe('WARNING');

    expect(overall([
      { level: 'WARNING', message: '' },
      { level: 'INCOMPATIBLE', message: '' },
    ])).toBe('INCOMPATIBLE');

    expect(overall([])).toBe('OK');
  });
});
