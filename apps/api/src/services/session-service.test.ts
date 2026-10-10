import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "node:crypto";

vi.mock("../db/client.js", () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock("../db/schema.js", () => ({
  wsUpgradeTokens: {
    tokenHash: "ws_upgrade_tokens.token_hash",
    userId: "ws_upgrade_tokens.user_id",
    workspaceId: "ws_upgrade_tokens.workspace_id",
    expiresAt: "ws_upgrade_tokens.expires_at",
  },
  users: {
    id: "users.id",
    provider: "users.provider",
    externalId: "users.external_id",
    email: "users.email",
    displayName: "users.display_name",
    avatarUrl: "users.avatar_url",
    defaultWorkspaceId: "users.default_workspace_id",
  },
  sessions: {
    id: "sessions.id",
    userId: "sessions.user_id",
    tokenHash: "sessions.token_hash",
    expiresAt: "sessions.expires_at",
    createdAt: "sessions.created_at",
  },
}));

/** Helper to compute SHA-256 hex hash (mirrors session-service internals). */
function testHashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

import { db } from "../db/client.js";
import {
  createSession,
  validateSession,
  revokeSession,
  revokeAllUserSessions,
  createWsToken,
  validateWsToken,
  cleanupExpiredSessions,
} from "./session-service.js";

/**
 * The WS upgrade token table, as the mocked db sees it: `insert().values()`
 * stores a row; `delete().where().returning()` consumes it (the hash is the
 * only thing the where clause carries, so the stand-in keys rows by the
 * hash it finds in the drizzle `eq`).
 */
// Expiry is computed and compared on the database's clock (`now()`), so the
// stand-in keeps only whether the row is still live.
const wsTokenRows = new Map<string, { userId: string; live: boolean }>();
function mockWsTokenTable() {
  (db.insert as any) = vi.fn().mockReturnValue({
    values: vi.fn().mockImplementation(async (row: any) => {
      wsTokenRows.set(row.tokenHash, { userId: row.userId, live: true });
    }),
  });
  (db.delete as any) = vi.fn().mockReturnValue({
    where: vi.fn().mockImplementation((cond: any) => ({
      returning: vi.fn().mockImplementation(async () => {
        // drizzle's eq() keeps the right-hand value in its query chunks.
        const hash = JSON.stringify(cond).match(/[0-9a-f]{64}/)?.[0];
        const row = hash ? wsTokenRows.get(hash) : undefined;
        if (!row) return [];
        wsTokenRows.delete(hash!);
        return [row];
      }),
    })),
  });
}

describe("session-service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    wsTokenRows.clear();
  });

  describe("createSession", () => {
    it("creates new user and session when user not found", async () => {
      // User lookup returns empty
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      });

      // Insert user
      (db.insert as any) = vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([
            {
              id: "user-1",
              provider: "github",
              externalId: "ext-1",
              email: "test@test.com",
              displayName: "Test User",
              avatarUrl: null,
              defaultWorkspaceId: null,
            },
          ]),
        }),
      });

      const result = await createSession("github", {
        externalId: "ext-1",
        email: "test@test.com",
        displayName: "Test User",
      });

      expect(result.user.email).toBe("test@test.com");
      expect(result.user.provider).toBe("github");
      expect(result.token).toBeDefined();
      expect(result.token.length).toBe(64); // 32 bytes hex
    });

    it("updates existing user on login", async () => {
      // User lookup returns existing
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([
              {
                id: "user-1",
                provider: "github",
                externalId: "ext-1",
                email: "old@test.com",
                displayName: "Old Name",
              },
            ]),
          }),
        }),
      });

      // Update user
      (db.update as any) = vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([
              {
                id: "user-1",
                provider: "github",
                externalId: "ext-1",
                email: "new@test.com",
                displayName: "New Name",
                avatarUrl: null,
                defaultWorkspaceId: "ws-1",
              },
            ]),
          }),
        }),
      });

      // Insert session
      (db.insert as any) = vi.fn().mockReturnValue({
        values: vi.fn().mockResolvedValue(undefined),
      });

      const result = await createSession("github", {
        externalId: "ext-1",
        email: "new@test.com",
        displayName: "New Name",
      });

      expect(result.user.email).toBe("new@test.com");
      expect(result.user.workspaceId).toBe("ws-1");
    });
  });

  describe("validateSession", () => {
    const VALID_TOKEN = "some-token";
    const VALID_TOKEN_HASH = testHashToken(VALID_TOKEN);

    function mockValidSessionRow(overrides: Record<string, unknown> = {}) {
      return {
        sessionId: "sess-1",
        tokenHash: VALID_TOKEN_HASH,
        sessionCreatedAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000), // 1 day ago
        expiresAt: new Date(Date.now() + 6 * 24 * 60 * 60 * 1000), // 6 days from now
        userId: "user-1",
        provider: "github",
        email: "test@test.com",
        displayName: "Test",
        avatarUrl: null,
        defaultWorkspaceId: "ws-1",
        ...overrides,
      };
    }

    function setupSelectMock(rows: unknown[]) {
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue(rows),
            }),
          }),
        }),
      });
    }

    function setupUpdateMock() {
      (db.update as any) = vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      });
    }

    it("returns user for valid session and extends expiry (sliding window)", async () => {
      setupSelectMock([mockValidSessionRow()]);
      setupUpdateMock();

      const result = await validateSession(VALID_TOKEN);
      expect(result).not.toBeNull();
      expect(result!.id).toBe("user-1");
      expect(result!.email).toBe("test@test.com");
      expect(result!.workspaceId).toBe("ws-1");

      // Sliding window: should have called db.update to extend expiry
      expect(db.update).toHaveBeenCalled();
    });

    it("returns null when no session row found (invalid token)", async () => {
      setupSelectMock([]);

      const result = await validateSession("bad-token");
      expect(result).toBeNull();
    });

    it("returns null when session is expired (post-fetch check)", async () => {
      setupSelectMock([
        mockValidSessionRow({
          expiresAt: new Date(Date.now() - 1000), // expired 1 second ago
        }),
      ]);

      const result = await validateSession(VALID_TOKEN);
      expect(result).toBeNull();
    });

    it("performs constant-time hash comparison via timingSafeEqual", async () => {
      // Row with a mismatched tokenHash — should be rejected by timingSafeEqual
      setupSelectMock([
        mockValidSessionRow({
          tokenHash: testHashToken("different-token"),
        }),
      ]);

      const result = await validateSession(VALID_TOKEN);
      expect(result).toBeNull();
    });

    it("caps sliding window at max TTL from session creation", async () => {
      // Session created 28 days ago — max TTL is 30 days, so cap at 2 days from now
      const sessionCreatedAt = new Date(Date.now() - 28 * 24 * 60 * 60 * 1000);
      setupSelectMock([
        mockValidSessionRow({
          sessionCreatedAt,
          expiresAt: new Date(Date.now() + 1 * 24 * 60 * 60 * 1000), // 1 day left
        }),
      ]);
      setupUpdateMock();

      const result = await validateSession(VALID_TOKEN);
      expect(result).not.toBeNull();

      // Verify the update was called (sliding window extension)
      expect(db.update).toHaveBeenCalled();
      // The new expiry should be capped: createdAt + 30 days < now + 7 days
      const setCalls = (db.update as any).mock.results[0].value.set.mock.calls;
      const newExpiry: Date = setCalls[0][0].expiresAt;
      const maxExpiry = new Date(sessionCreatedAt.getTime() + 30 * 24 * 60 * 60 * 1000);
      // newExpiry should not exceed maxExpiry
      expect(newExpiry.getTime()).toBeLessThanOrEqual(maxExpiry.getTime());
      // newExpiry should be less than now + 7 days (because of the cap)
      const slidingExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      expect(newExpiry.getTime()).toBeLessThan(slidingExpiry.getTime());
    });
  });

  describe("revokeSession", () => {
    it("deletes session by token hash", async () => {
      (db.delete as any) = vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      });

      await revokeSession("some-token");
      expect(db.delete).toHaveBeenCalled();
    });
  });

  describe("revokeAllUserSessions", () => {
    it("deletes all sessions for a user", async () => {
      (db.delete as any) = vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      });

      await revokeAllUserSessions("user-1");
      expect(db.delete).toHaveBeenCalled();
    });
  });

  describe("createWsToken", () => {
    it("stores a short-lived WebSocket upgrade token, hashed, in the database", async () => {
      mockWsTokenTable();
      const token = await createWsToken("user-1");
      expect(token).toBeDefined();
      expect(token.length).toBe(64); // 32 bytes hex
      // Stored by hash (any instance can consume it); the raw token never lands.
      expect(wsTokenRows.size).toBe(1);
      expect(wsTokenRows.has(testHashToken(token))).toBe(true);
      expect(wsTokenRows.has(token)).toBe(false);
    });
  });

  describe("validateWsToken", () => {
    it("validates and consumes a valid upgrade token", async () => {
      mockWsTokenTable();
      // Mock the user lookup that happens after token validation
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([
              {
                userId: "user-1",
                provider: "github",
                email: "test@test.com",
                displayName: "Test User",
                avatarUrl: null,
                defaultWorkspaceId: "ws-1",
              },
            ]),
          }),
        }),
      });

      const token = await createWsToken("user-1");
      expect(wsTokenRows.size).toBe(1);

      const user = await validateWsToken(token);
      expect(user).not.toBeNull();
      expect(user!.id).toBe("user-1");
      expect(user!.email).toBe("test@test.com");

      // Token should be consumed (deleted from the table)
      expect(wsTokenRows.size).toBe(0);
    });

    it("rejects a token that has already been consumed (single-use)", async () => {
      mockWsTokenTable();
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([
              {
                userId: "user-1",
                provider: "github",
                email: "test@test.com",
                displayName: "Test User",
                avatarUrl: null,
                defaultWorkspaceId: null,
              },
            ]),
          }),
        }),
      });

      const token = await createWsToken("user-1");

      // First use succeeds
      const user1 = await validateWsToken(token);
      expect(user1).not.toBeNull();

      // Second use fails (consumed)
      const user2 = await validateWsToken(token);
      expect(user2).toBeNull();
    });

    it("rejects an unknown token", async () => {
      mockWsTokenTable();
      const user = await validateWsToken("nonexistent-token");
      expect(user).toBeNull();
    });

    it("rejects an expired token", async () => {
      mockWsTokenTable();
      const token = await createWsToken("user-1");

      // Manually expire the token in the table
      for (const [, entry] of wsTokenRows) {
        entry.live = false;
      }

      const user = await validateWsToken(token);
      expect(user).toBeNull();
      // Token should still be removed from the table even though expired
      expect(wsTokenRows.size).toBe(0);
    });
  });

  describe("cleanupExpiredSessions", () => {
    it("deletes expired sessions and returns count", async () => {
      (db.delete as any) = vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: "s-1" }, { id: "s-2" }]),
        }),
      });

      const count = await cleanupExpiredSessions();
      expect(count).toBe(2);
    });

    it("returns 0 when no expired sessions", async () => {
      (db.delete as any) = vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([]),
        }),
      });

      const count = await cleanupExpiredSessions();
      expect(count).toBe(0);
    });
  });
});
