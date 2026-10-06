// Worker de Cloudflare: cada minuto busca pendientes con recordatorio vencido y envía la notificación push (FCM).

const SCOPES = "https://www.googleapis.com/auth/datastore https://www.googleapis.com/auth/firebase.messaging";
const WINDOW_MS = 24 * 60 * 60 * 1000; // recordatorios atrasados hasta 1 día se siguen enviando
const BATCH_LIMIT = 200;               // máximo de pendientes por ejecución
const CONCURRENCY = 10;                // pendientes procesados en paralelo

/* ---------- Autenticación con la cuenta de servicio ---------- */
const b64url = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64urlStr = (s) => b64url(new TextEncoder().encode(s));

let cachedToken = null; // { value, exp } — se reutiliza mientras el isolate siga vivo

async function getAccessToken(sa) {
  if (cachedToken && cachedToken.exp - Date.now() > 5 * 60 * 1000) return cachedToken.value;
  const now = Math.floor(Date.now() / 1000);
  const header = b64urlStr(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64urlStr(JSON.stringify({
    iss: sa.client_email, scope: SCOPES, aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600,
  }));

  const pem = sa.private_key.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey(
    "pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${header}.${claim}`));
  const jwt = `${header}.${claim}.${b64url(sig)}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }),
  });
  if (!res.ok) throw new Error("Token OAuth: " + res.status + " " + (await res.text()));
  const { access_token, expires_in } = await res.json();
  cachedToken = { value: access_token, exp: Date.now() + (expires_in || 3600) * 1000 };
  return access_token;
}

/* ---------- Firestore (REST) ---------- */
const fsBase = (pid) => `https://firestore.googleapis.com/v1/projects/${pid}/databases/(default)/documents`;

async function runQuery(pid, token, structuredQuery) {
  const res = await fetch(`${fsBase(pid)}:runQuery`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ structuredQuery }),
  });
  if (!res.ok) throw new Error("runQuery: " + res.status + " " + (await res.text()));
  return (await res.json()).filter((r) => r.document).map((r) => r.document);
}

const str = (f) => f?.stringValue;
const int = (f) => (f?.integerValue !== undefined ? Number(f.integerValue) : f?.doubleValue);

/* ---------- Lógica principal ---------- */
// Enviamos a un dispositivo. Devuelve "ok", "gone" (token inválido, ya borrado), "retry" (fallo temporal) o "failed".
async function sendToDevice(pid, token, deviceToken, task) {
  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${pid}/messages:send`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      message: {
        token: deviceToken,
        notification: {
          title: `⏰ ${task.title}`,
          body: task.remindMin > 0 ? `Es a las ${task.time}` : `Ahora · ${task.time}`,
        },
        webpush: { fcm_options: { link: `https://${pid}.web.app/` }, headers: { Urgency: "high" } },
      },
    }),
  });
  if (res.ok) return "ok";

  const errText = await res.text();
  if (res.status === 404 || errText.includes("UNREGISTERED")) {
    // El dispositivo ya no existe: limpiamos su token.
    await fetch(`${fsBase(pid)}/tokens/${encodeURIComponent(deviceToken)}`, {
      method: "DELETE", headers: { authorization: `Bearer ${token}` },
    });
    return "gone";
  }
  console.log("FCM error:", res.status, errText);
  // 5xx/429 son temporales; 401/403 son de configuración/credenciales (nada se entregó): se reintenta.
  return res.status >= 500 || [401, 403, 429].includes(res.status) ? "retry" : "failed";
}

async function processTask(pid, token, doc, tokensFor) {
  const f = doc.fields;
  const task = { title: str(f.title) || "Pendiente", time: str(f.time) || "", remindMin: int(f.remindMin) || 0 };
  const deviceTokens = await tokensFor(str(f.uid));

  const results = await Promise.all(deviceTokens.map((t) => sendToDevice(pid, token, t, task)));
  const delivered = results.includes("ok");
  const pendingRetry = results.includes("retry");
  const failed = results.includes("failed");

  // Solo se deja sin marcar (para reintentar al minuto siguiente) cuando nada llegó y hay fallos temporales.
  // Los errores permanentes se marcan como procesados: si no, ocuparían el lote de BATCH_LIMIT durante toda la ventana.
  if (!delivered && pendingRetry) return;
  if (!delivered && failed) console.log("Recordatorio descartado por error permanente de FCM:", doc.name);

  const taskId = doc.name.split("/").pop();
  // currentDocument.exists evita recrear un pendiente que el usuario borró mientras tanto.
  const upd = await fetch(`${fsBase(pid)}/tasks/${taskId}?updateMask.fieldPaths=notified&currentDocument.exists=true`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ fields: { notified: { booleanValue: true } } }),
  });
  if (!upd.ok && upd.status !== 404 && upd.status !== 400) console.log("No se pudo marcar notified:", upd.status, await upd.text());
}

async function processReminders(env) {
  const sa = JSON.parse(env.SERVICE_ACCOUNT);
  const pid = sa.project_id;
  const token = await getAccessToken(sa);
  const now = Date.now();

  // Requiere el índice compuesto (notified, done, remindAt) de firestore.indexes.json.
  const pending = await runQuery(pid, token, {
    from: [{ collectionId: "tasks" }],
    where: {
      compositeFilter: {
        op: "AND",
        filters: [
          { fieldFilter: { field: { fieldPath: "notified" }, op: "EQUAL", value: { booleanValue: false } } },
          { fieldFilter: { field: { fieldPath: "done" }, op: "EQUAL", value: { booleanValue: false } } },
          { fieldFilter: { field: { fieldPath: "remindAt" }, op: "LESS_THAN_OR_EQUAL", value: { integerValue: String(now) } } },
          { fieldFilter: { field: { fieldPath: "remindAt" }, op: "GREATER_THAN_OR_EQUAL", value: { integerValue: String(now - WINDOW_MS) } } },
        ],
      },
    },
    orderBy: [{ field: { fieldPath: "remindAt" }, direction: "ASCENDING" }],
    limit: BATCH_LIMIT,
  });
  console.log(`Pendientes por avisar: ${pending.length}`);

  // Un solo query de tokens por usuario en cada ejecución.
  const tokenCache = new Map();
  const tokensFor = (uid) => {
    if (!tokenCache.has(uid)) {
      tokenCache.set(uid, runQuery(pid, token, {
        from: [{ collectionId: "tokens" }],
        where: { fieldFilter: { field: { fieldPath: "uid" }, op: "EQUAL", value: { stringValue: uid } } },
      }).then((docs) => docs.map((d) => d.name.split("/").pop())));
    }
    return tokenCache.get(uid);
  };

  // Concurrencia limitada: CONCURRENCY pendientes a la vez.
  for (let i = 0; i < pending.length; i += CONCURRENCY) {
    const chunk = pending.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(chunk.map((doc) => processTask(pid, token, doc, tokensFor)));
    results.forEach((r) => r.status === "rejected" && console.log("Error procesando pendiente:", r.reason));
  }
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(processReminders(env));
  },
  async fetch() {
    return new Response("Not found", { status: 404 });
  },
};
