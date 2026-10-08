// Autenticación con la cuenta de servicio de Google: JWT RS256 firmado con Web Crypto → token OAuth.

const SCOPES = "https://www.googleapis.com/auth/datastore https://www.googleapis.com/auth/firebase.messaging";

const b64url = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64urlStr = (s) => b64url(new TextEncoder().encode(s));

let cachedToken = null; // { value, exp } — se reutiliza mientras el isolate siga vivo

// `io` permite inyectar fetch/now en las pruebas.
export async function getAccessToken(sa, io = {}) {
  const doFetch = io.fetch || ((...a) => globalThis.fetch(...a));
  const now = io.now || (() => Date.now());

  if (cachedToken && cachedToken.exp - now() > 5 * 60 * 1000) return cachedToken.value;
  const iat = Math.floor(now() / 1000);
  const header = b64urlStr(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64urlStr(JSON.stringify({
    iss: sa.client_email, scope: SCOPES, aud: "https://oauth2.googleapis.com/token", iat, exp: iat + 3600,
  }));

  const pem = sa.private_key.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey(
    "pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${header}.${claim}`));
  const jwt = `${header}.${claim}.${b64url(sig)}`;

  const res = await doFetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }),
  });
  if (!res.ok) throw new Error("Token OAuth: " + res.status + " " + (await res.text()));
  const { access_token, expires_in } = await res.json();
  cachedToken = { value: access_token, exp: now() + (expires_in || 3600) * 1000 };
  return access_token;
}
