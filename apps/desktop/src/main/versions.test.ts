import { describe, expect, it } from 'vitest';
import { checksumFor, compareVersions } from './versions';

describe('compareVersions', () => {
  it('orders release numbers', () => {
    expect(compareVersions('0.1.0', '0.2.0')).toBeLessThan(0);
    expect(compareVersions('1.10.0', '1.9.3')).toBeGreaterThan(0);
    expect(compareVersions('v1.2.3', '1.2.3')).toBe(0);
  });
  it('orders betas, and puts them before the finished version', () => {
    expect(compareVersions('0.1.0-beta.2', '0.1.0-beta.3')).toBeLessThan(0);
    expect(compareVersions('0.1.0-beta.10', '0.1.0-beta.9')).toBeGreaterThan(0);
    expect(compareVersions('0.1.0-beta.3', '0.1.0')).toBeLessThan(0);
    expect(compareVersions('0.1.0', '0.1.0-beta.3')).toBeGreaterThan(0);
    expect(compareVersions('0.1.0-alpha', '0.1.0-beta')).toBeLessThan(0);
    expect(compareVersions('0.1.0-beta', '0.1.0-beta.1')).toBeLessThan(0);
  });
  it('treats unreadable versions as not newer', () => expect(compareVersions('nightly', '0.1.0')).toBe(0));
});

describe('checksumFor', () => {
  const a = 'a'.repeat(128), b = 'B'.repeat(128);
  const list = `${a}  mac/Action-Cam-Editor-0.1.0-mac-arm64.zip\n${b} *windows/Action-Cam-Editor-0.1.0-setup.exe\n`;
  it('finds a file by name', () => {
    expect(checksumFor(list, 'Action-Cam-Editor-0.1.0-mac-arm64.zip')).toBe(a);
    expect(checksumFor(list, 'Action-Cam-Editor-0.1.0-setup.exe')).toBe('b'.repeat(128));
  });
  it('returns null for a file not listed', () => expect(checksumFor(list, 'other.zip')).toBeNull());
});
