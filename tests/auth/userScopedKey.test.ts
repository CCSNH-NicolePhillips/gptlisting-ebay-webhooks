import { userScopedKey } from '../../src/lib/_auth.js';

describe('userScopedKey', () => {
  it('should create user-scoped key with auth0 sub', () => {
    const sub = 'auth0|1234567890';
    const key = userScopedKey(sub, 'ebay.json');
    expect(key).toBe('users/auth0%7C1234567890/ebay.json');
  });

  it('should handle different file types', () => {
    const sub = 'auth0|abc123';
    expect(userScopedKey(sub, 'ebay.json')).toBe('users/auth0%7Cabc123/ebay.json');
    expect(userScopedKey(sub, 'dropbox.json')).toBe('users/auth0%7Cabc123/dropbox.json');
    expect(userScopedKey(sub, 'settings.json')).toBe('users/auth0%7Cabc123/settings.json');
  });

  it('should URL-encode special characters in sub', () => {
    const sub = 'google-oauth2|123456789012345678901';
    const key = userScopedKey(sub, 'ebay.json');
    expect(key).toBe('users/google-oauth2%7C123456789012345678901/ebay.json');
  });

  it('should return non-scoped key when sub is null', () => {
    const key = userScopedKey(null, 'ebay.json');
    expect(key).toBe('ebay.json');
  });

  it('should return non-scoped key when sub is empty string', () => {
    const key = userScopedKey('', 'ebay.json');
    expect(key).toBe('ebay.json');
  });

  it('should handle empty filename', () => {
    const sub = 'auth0|test';
    const key = userScopedKey(sub, '');
    expect(key).toBe('users/auth0%7Ctest/');
  });

  it('should be consistent for same inputs', () => {
    const sub = 'auth0|same';
    const key1 = userScopedKey(sub, 'ebay.json');
    const key2 = userScopedKey(sub, 'ebay.json');
    expect(key1).toBe(key2);
  });

  it('should create different keys for different users', () => {
    const key1 = userScopedKey('auth0|user1', 'ebay.json');
    const key2 = userScopedKey('auth0|user2', 'ebay.json');
    expect(key1).not.toBe(key2);
    expect(key1).toBe('users/auth0%7Cuser1/ebay.json');
    expect(key2).toBe('users/auth0%7Cuser2/ebay.json');
  });

  it('should properly encode slashes and other special chars', () => {
    const sub = 'provider/with/slashes';
    const key = userScopedKey(sub, 'test.json');
    expect(key).toContain('users/');
    expect(key).toContain('%2F'); // URL-encoded slash
  });
});
