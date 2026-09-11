/**
 * The account picker, per provider.
 *
 * These exist because the drawer was Meta's for every connection and nothing
 * failed: it type-checked, it rendered, and it told an operator who had just
 * authorised Google Ads that publishing needs a Facebook Page. A wrong sentence
 * in front of a correct list is a bug no compiler can see, so the assertions
 * below are about words as much as about structure.
 *
 * The rule every case here enforces: no provider's screen may name another
 * provider's product.
 */

import { describe, expect, it } from 'vitest';

import {
  accountKindLabel,
  accountPickerCopy,
  compareAccountKinds,
  formatExternalId,
  parentAccountLine,
} from './account-picker';

describe('account picker vocabulary', () => {
  it('speaks Google Ads, never Meta, on a Google Ads connection', () => {
    const copy = accountPickerCopy('GOOGLE_ADS');

    expect(copy.provider).toBe('Google Ads');
    for (const sentence of [copy.intro('ops@noriva.sa'), copy.empty]) {
      expect(sentence).not.toMatch(/meta|facebook|\bpage\b|instagram/i);
    }
    expect(copy.intro('ops@noriva.sa')).toMatch(/Google Ads/);
  });

  it('keeps Meta\'s own wording on the Meta connection', () => {
    const copy = accountPickerCopy('FACEBOOK');

    expect(copy.intro('Noriva')).toMatch(/Meta returned everything Noriva can see/);
    expect(copy.intro('Noriva')).toMatch(/one ad account and one Page/);
    expect(copy.empty).toMatch(/administers a Page and an ad account/);
  });

  it('reads neutrally for a provider with no entry, never as Facebook', () => {
    const copy = accountPickerCopy('SNAPCHAT');

    expect(copy.intro('this login')).not.toMatch(/meta|facebook|page/i);
    expect(copy.empty).not.toMatch(/meta|facebook|page/i);
  });

  it('survives a platform that has not loaded yet', () => {
    expect(() => accountPickerCopy(null).intro('this login')).not.toThrow();
    expect(accountKindLabel(null, 'AD_ACCOUNT')).toBe('Ad account');
  });

  // ------------------------------------------------------------- kind labels

  it('calls an AD_ACCOUNT a Google Ads account on Google Ads and an ad account elsewhere', () => {
    expect(accountKindLabel('GOOGLE_ADS', 'AD_ACCOUNT')).toBe('Google Ads account');
    expect(accountKindLabel('FACEBOOK', 'AD_ACCOUNT')).toBe('Ad account');
  });

  it('keeps the shared labels for kinds a provider does not rename', () => {
    expect(accountKindLabel('FACEBOOK', 'PAGE')).toBe('Facebook Page');
    expect(accountKindLabel('FACEBOOK', 'INSTAGRAM')).toBe('Instagram Professional');
  });

  it('humanises a kind nobody has named rather than printing the enum', () => {
    expect(accountKindLabel('GOOGLE_ADS', 'SOMETHING_NEW')).toBe('something new');
  });

  // ------------------------------------------------------------------ order

  it('puts Pages before ad accounts on Meta', () => {
    expect(compareAccountKinds('FACEBOOK', 'PAGE', 'AD_ACCOUNT')).toBeLessThan(0);
    expect(compareAccountKinds('FACEBOOK', 'AD_ACCOUNT', 'INSTAGRAM')).toBeGreaterThan(0);
  });

  it('orders deterministically for kinds outside a provider\'s list', () => {
    // Equal rank must not compare as "same": a Map iteration order is not a
    // sort, and two unranked groups swapping places between renders is churn.
    expect(compareAccountKinds('GOOGLE_ADS', 'LOCATION', 'BUSINESS')).toBeGreaterThan(0);
    expect(compareAccountKinds('GOOGLE_ADS', 'BUSINESS', 'LOCATION')).toBeLessThan(0);
  });

  // ------------------------------------------------------------------- ids

  it('prints a Google Ads customer id the way Google Ads prints it', () => {
    expect(formatExternalId('GOOGLE_ADS', '1234567890')).toBe('123-456-7890');
  });

  it('leaves every other provider\'s id exactly as the provider gave it', () => {
    expect(formatExternalId('FACEBOOK', '1234567890')).toBe('1234567890');
    expect(formatExternalId('GOOGLE_BUSINESS', 'accounts/1234567890')).toBe('accounts/1234567890');
  });

  it('does not mangle a customer id that is not ten digits', () => {
    expect(formatExternalId('GOOGLE_ADS', '12345')).toBe('12345');
  });

  // ---------------------------------------------------------------- parents

  it('names an Instagram account\'s parent as its Page', () => {
    expect(parentAccountLine({
      platform: 'FACEBOOK',
      parentExternalId: '99',
      parentName: 'Pawse Kitchen',
    })).toBe('via Pawse Kitchen');

    expect(parentAccountLine({
      platform: 'FACEBOOK',
      parentExternalId: '99',
      parentName: undefined,
    })).toBe('via Page 99');
  });

  it('names a Google Ads parent as a manager account, never as a Page', () => {
    const line = parentAccountLine({
      platform: 'GOOGLE_ADS',
      parentExternalId: '1234567890',
      parentName: undefined,
    });

    expect(line).toBe('via manager account 123-456-7890');
    expect(line).not.toMatch(/page/i);
  });

  it('says nothing about a parent for a provider that has none', () => {
    expect(parentAccountLine({
      platform: 'TIKTOK',
      parentExternalId: 'abc',
      parentName: undefined,
    })).toBeNull();

    expect(parentAccountLine({
      platform: 'GOOGLE_ADS',
      parentExternalId: null,
      parentName: undefined,
    })).toBeNull();
  });
});
