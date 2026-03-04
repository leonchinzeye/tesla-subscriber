import { supabase } from './db';

const TESLA_CLIENT_ID = process.env.TESLA_CLIENT_ID!;

interface CachedToken {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // ms
}

let cachedToken: CachedToken | null = null;
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

export async function getValidToken(userId: string): Promise<string | null> {
  const USER_ID = userId;

  // Serve from in-memory cache if still fresh
  if (cachedToken && Date.now() < cachedToken.expiresAt - TOKEN_REFRESH_BUFFER_MS) {
    return cachedToken.accessToken;
  }

  const { data } = await supabase
    .from('user_tokens')
    .select('access_token, refresh_token, expires_at')
    .eq('user_id', USER_ID)
    .single();

  if (!data) {
    console.warn('getValidToken: no token row found for user');
    return null;
  }

  const expiresAt = new Date(data.expires_at).getTime();

  // Fresh — cache and return
  if (Date.now() < expiresAt - TOKEN_REFRESH_BUFFER_MS) {
    cachedToken = { accessToken: data.access_token, refreshToken: data.refresh_token, expiresAt };
    return cachedToken.accessToken;
  }

  // Needs refresh
  try {
    const res = await fetch('https://auth.tesla.com/oauth2/v3/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: TESLA_CLIENT_ID,
        refresh_token: data.refresh_token,
      }),
    });

    if (res.ok) {
      const tokens = await res.json();
      const newExpiresAt = Date.now() + tokens.expires_in * 1000;
      cachedToken = {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token || data.refresh_token,
        expiresAt: newExpiresAt,
      };
      await supabase.from('user_tokens').update({
        access_token: cachedToken.accessToken,
        refresh_token: cachedToken.refreshToken,
        expires_at: new Date(newExpiresAt).toISOString(),
        updated_at: new Date().toISOString(),
      }).eq('user_id', USER_ID);
      console.log(`Tesla token refreshed, expires at: ${new Date(newExpiresAt).toISOString()}`);
      return cachedToken.accessToken;
    }
    console.warn(`Tesla token refresh failed: ${res.status}`);
  } catch (err) {
    console.error('getValidToken refresh error:', err);
  }

  // Refresh failed — use existing token if still technically valid
  if (Date.now() < expiresAt) {
    cachedToken = { accessToken: data.access_token, refreshToken: data.refresh_token, expiresAt };
    return cachedToken.accessToken;
  }

  return null;
}
