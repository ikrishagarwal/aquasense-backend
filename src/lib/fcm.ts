import { sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';

const accountSchema = z.object({
  client_email: z.email(), private_key: z.string().min(1),
  project_id: z.string().regex(/^[a-z0-9-]+$/),
});
const oauthUrl = 'https://oauth2.googleapis.com/token';

export function createFcmSender(path: string) {
  const account = accountSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  let cached: { value: string; expires: number } | undefined;

  async function accessToken() {
    const now = Math.floor(Date.now() / 1_000);
    if (cached && cached.expires > now + 60) return cached.value;
    const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const claim = [
      encode({ alg: 'RS256', typ: 'JWT' }),
      encode({ iss: account.client_email, aud: oauthUrl, iat: now, exp: now + 3600,
        scope: 'https://www.googleapis.com/auth/firebase.messaging' }),
    ].join('.');
    const assertion = `${claim}.${sign('RSA-SHA256', Buffer.from(claim), account.private_key).toString('base64url')}`;
    const response = await fetch(oauthUrl, {
      method: 'POST', signal: AbortSignal.timeout(8_000),
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
    });
    if (!response.ok) throw new Error('FCM authentication failed');
    const token = z.object({ access_token: z.string(), expires_in: z.number() }).parse(await response.json());
    cached = { value: token.access_token, expires: now + token.expires_in };
    return cached.value;
  }

  return async (token: string, alert: { event_id: string; device_id: string; name: string; active: boolean }) => {
    const access = await accessToken();
    const response = await fetch(`https://fcm.googleapis.com/v1/projects/${account.project_id}/messages:send`, {
      method: 'POST', signal: AbortSignal.timeout(8_000),
      headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json' },
      body: JSON.stringify({ message: {
        token, notification: { title: 'AquaSense', body: alert.active
          ? `Purifier alert: ${alert.name.replaceAll('_', ' ')}`
          : `Purifier alert cleared: ${alert.name.replaceAll('_', ' ')}` },
        data: { ...alert, active: String(alert.active) },
      } }),
    });
    if (response.ok) {
      await response.body?.cancel();
      return 'sent';
    }
    const failure = z.object({ error: z.object({ details: z.array(z.object({
      '@type': z.string().optional(), errorCode: z.string().optional(),
    })).optional() }) }).safeParse(await response.json());
    const fcmError = failure.data?.error.details?.find(detail =>
      detail['@type'] === 'type.googleapis.com/google.firebase.fcm.v1.FcmError')?.errorCode;
    if (fcmError === 'UNREGISTERED') return 'invalid_token';
    if (response.status === 401) cached = undefined;
    if (response.status === 400) return 'invalid_message';
    throw new Error('FCM send failed');
  };
}
