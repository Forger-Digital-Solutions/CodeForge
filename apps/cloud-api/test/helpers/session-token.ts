import { signAccessToken, hashRefreshToken, generateRefreshToken } from "@codeforge/cloud-auth";
import type { ICloudDatabase } from "@codeforge/cloud-db";

/**
 * Mint an access token backed by a REAL device session. Since Security R1 the Cloud refuses a
 * token whose `sid` is not a live session (logout/revocation/deletion take effect immediately),
 * so tests can no longer forge a token with an arbitrary session id — exactly the property the
 * production guard closes.
 */
export async function mintSessionAccessToken(db: ICloudDatabase, userId: string, jwtSecret: string, options: { ensureUser?: boolean } = {}): Promise<string> {
  if (options.ensureUser !== false && !(await db.getUserById(userId))) {
    await db.createUser({ id: userId, displayName: userId, primaryIdentity: `github:test-${userId}` });
  }
  const session = await db.createDeviceSession({
    userId,
    deviceName: "test-device",
    refreshTokenHash: hashRefreshToken(generateRefreshToken()),
    expiresInSeconds: 3600,
  });
  return signAccessToken({ sub: userId, sid: session.id }, jwtSecret);
}
