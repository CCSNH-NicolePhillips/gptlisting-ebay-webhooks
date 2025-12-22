/**
 * Tests for critical settings key encoding fix
 * 
 * Bug: User pricing settings were not loading because:
 * - user-settings-save.ts saves to: users/auth0%7C12345/settings.json (encoded)
 * - smartdrafts-create-drafts-background.ts was loading: users/auth0|12345/settings.json (not encoded)
 * 
 * This caused a complete mismatch for Auth0 users (pipe char in userId)
 */

import { userScopedKey } from '../../src/lib/_auth.js';

describe('Settings Key Encoding', () => {
  describe('userScopedKey function', () => {
    it('should encode special characters in userId', () => {
      const userId = 'auth0|12345';
      const key = userScopedKey(userId, 'settings.json');
      
      // The pipe character should be encoded
      expect(key).toBe('users/auth0%7C12345/settings.json');
      expect(key).not.toContain('|');
    });

    it('should encode multiple special characters', () => {
      const userId = 'google-oauth2|user@example.com';
      const key = userScopedKey(userId, 'settings.json');
      
      // Both pipe and @ should be encoded
      expect(key).toContain('%7C'); // encoded pipe
      expect(key).toContain('%40'); // encoded @
      expect(key).not.toContain('|');
      expect(key).not.toContain('@');
    });

    it('should handle simple userIds without special chars', () => {
      const userId = 'simple-user-123';
      const key = userScopedKey(userId, 'settings.json');
      
      expect(key).toBe('users/simple-user-123/settings.json');
    });

    it('should return just the key when sub is null', () => {
      const key = userScopedKey(null, 'settings.json');
      
      expect(key).toBe('settings.json');
    });
  });

  describe('Key consistency between save and load', () => {
    it('should produce identical keys for save and load operations', () => {
      const userId = 'auth0|complex|user@test.com';
      
      // Simulate what user-settings-save does
      const saveKey = userScopedKey(userId, 'settings.json');
      
      // Simulate the FIXED load path (with encodeURIComponent)
      const loadKey = `users/${encodeURIComponent(userId)}/settings.json`;
      
      expect(saveKey).toBe(loadKey);
    });

    it('should NOT match with unencoded load key (the old bug)', () => {
      const userId = 'auth0|12345';
      
      const saveKey = userScopedKey(userId, 'settings.json');
      const buggyLoadKey = `users/${userId}/settings.json`; // OLD BUGGY WAY
      
      // These should NOT match - this is the bug we fixed!
      expect(saveKey).not.toBe(buggyLoadKey);
      expect(saveKey).toBe('users/auth0%7C12345/settings.json');
      expect(buggyLoadKey).toBe('users/auth0|12345/settings.json');
    });
  });
});
