# Mi Agenda

Agenda web sencilla: calendario mensual, pendientes por día y recordatorios push, sincronizados entre dispositivos.

## Arquitectura

```
Navegador (PWA)  ──►  Firebase Auth (Google)
   public/       ──►  Firestore  (tasks, tokens)
                          ▲
Cloudflare Worker ────────┘  cada minuto: busca recordatorios vencidos
   worker/        ──────────►  FCM  ──►  notificación push al dispositivo
```

- **`public/`**: la aplicación (HTML/CSS/JS sin build) servida por Firebase Hosting.
- **`firestore.rules` / `firestore.indexes.json`**: reglas de seguridad e índices compuestos.
- **`worker/`**: Worker de Cloudflare con un cron cada minuto que lee Firestore (REST) y envía los avisos por FCM.

### Datos

| Colección | Documento | Campos |
|---|---|---|
| `tasks` | auto-ID | `uid`, `title`, `date` (`YYYY-MM-DD`), `time` (`HH:MM`), `remindMin`, `remindAt` (ms o `null`), `notified`, `done`, `createdAt` |
| `tokens` | token FCM | `uid`, `ua`, `updatedAt` |
| `users` | uid | `timeFormat` (`"12"` o `"24"`), `nagMax` (3, 5, 10 o 20) |

`notified` solo lo modifica el Worker; las reglas lo impiden al cliente. Los campos de insistencia son opcionales (los pendientes anteriores no los tienen): `nagMin` (0, 5, 10, 15 o 30 min), `nagAt` (hora de la siguiente insistencia, la programa el Worker) y `nagCount` (cuántas se han enviado). El cliente solo puede cortar la cadena (`nagAt: null`, `nagCount: 0`), nunca programarla.

## Requisitos

- Node.js 20+
- Un proyecto de Firebase con **Authentication** (proveedor Google), **Firestore** y **Cloud Messaging** (par de claves web push / VAPID)
- Una cuenta de Cloudflare (el plan gratuito basta)

## Configuración

1. `npm install` y `npm --prefix worker install`
2. Edita **`.firebaserc`** con el ID de tu proyecto de Firebase.
3. Edita **`public/firebase-config.js`** con la configuración web de tu proyecto y tu clave VAPID pública. Estos valores no son secretos; lo que protege los datos son las reglas de Firestore. Restringe además la API key por dominio en Google Cloud Console.
4. En Firebase Authentication, añade tu dominio de Hosting a los dominios autorizados.

### Secreto del Worker

El Worker necesita una cuenta de servicio de Google con acceso a Firestore y FCM. **Nunca** guardes su JSON en el repo; se carga como secreto de Cloudflare:

```bash
cd worker
npx wrangler secret put SERVICE_ACCOUNT   # pega el contenido completo del JSON
```

Usa una cuenta de servicio dedicada con los roles mínimos necesarios y bórrala del disco después. Si una clave llega a salir de tu equipo, deshabilítala en IAM y crea otra.

## Despliegue (en este orden)

```bash
npm run deploy:firestore   # reglas + índices
```

Espera a que los índices aparezcan como **Enabled** en Firebase Console > Firestore > Índices. Si despliegas antes, el calendario y el Worker fallan con `failed-precondition`.

```bash
npm run deploy:worker      # Worker con el cron
npm run deploy:hosting     # aplicación web
```

## Desarrollo

```bash
npm run check              # sintaxis de JS y validez de los JSON
npm run test:client        # pruebas del tema (contraste) y del formato de hora (sin dependencias)
npm run test:worker        # pruebas de la lógica de recordatorios (reloj simulado, sin dependencias)
npm run test:rules         # pruebas de firestore.rules con el emulador (requiere Java 21+)
npm test                   # las tres anteriores
npx firebase emulators:start --only hosting,firestore,auth
```

`test:rules` descarga el emulador de Firestore la primera vez. En Windows, a veces el proceso de Java del emulador queda abierto al terminar y ocupa el puerto 8080; si la siguiente ejecución dice "port taken", cierra ese proceso `java` y vuelve a intentarlo.

Para ver los logs del Worker: `npm --prefix worker run tail`.

## Ajustes

El botón ⚙ de la esquina abre la ventana de ajustes:

- **Apariencia:** sistema, claro, oscuro o personalizado (color de acento y color de fondo). Se guarda **por dispositivo** (`localStorage`). Con colores personalizados, `public/theme.js` deriva el resto de la paleta y garantiza texto legible (≥ 4.5:1) sobre el fondo elegido.
- **Formato de hora:** 24 h o 12 h (a. m./p. m.). Se guarda **por cuenta** en `users/{uid}.timeFormat` para que el Worker escriba el aviso en ese formato. Los pendientes siguen guardándose siempre como `HH:MM` (24 h): solo cambia cómo se eligen y se muestran.
- **Avisos:** activar o desactivar en este dispositivo.
- **Cuenta:** correo y cerrar sesión.

## Responder desde la notificación

Las notificaciones traen los botones **✓ Hecho** y **Posponer N min** (Android y escritorio; iOS no soporta botones en notificaciones web: allí solo se abre la app al tocarlas). Funcionan con la app cerrada y sin ningún servidor extra:

- El Worker ya no manda una notificación lista, sino **solo datos** (`title`, `body`, `taskId`, `snoozeMin`, `kind`). El service worker (`public/firebase-messaging-sw.js`) arma la notificación con los botones y una etiqueta por pendiente (una insistencia reemplaza a la anterior).
- Al pulsar un botón, `public/sw-actions.js` reutiliza **tu sesión**: lee el token de refresco que Firebase Auth guarda en IndexedDB, obtiene un token de acceso y escribe en Firestore **con las mismas reglas de seguridad que la app**. No hay endpoint público ni secretos nuevos, y no puede hacer nada que tu sesión no pueda.
  - **Hecho**: `done: true` y `nagAt: null` (corta las insistencias), igual que la casilla de la app.
  - **Posponer**: reprograma el aviso a ahora + N minutos (Ajustes → Avisos → "Posponer desde la notificación": 5, 10, 15, 30 o 60 min) y reinicia las insistencias. El pendiente sigue en su fecha y hora originales; solo cambia el aviso.
- Si algo falla (sin sesión, sin red, token revocado) aparece una notificación "No se pudo completar la acción" para hacerlo desde la app.
- Corregir el título de un pendiente pospuesto **no** devuelve el aviso a su hora original (`public/edit-plan.js`).
- Las notificaciones caducan en el servicio push (TTL): el primer aviso en 1 día, una insistencia antes de la siguiente.

**Orden de despliegue:** reglas → hosting → Worker. Si el Worker (solo datos) se despliega antes de que el navegador tenga el service worker nuevo, el aviso aparecería como "el sitio se actualizó en segundo plano". Abre la app una vez tras desplegar para que se instale el service worker nuevo.

## Agregar rápido (lenguaje natural)

La barra de arriba entiende frases en español: *"dentista el viernes 5pm avisar 30 min antes"*, *"recuérdame llamar a mamá mañana a las 9"*, *"en 2 horas sacar la pizza"*, *"pagar renta el 15 de noviembre insistir cada 10 min"*. Mientras escribes muestra lo que entendió (fecha, hora, aviso, insistencia) para corregirlo antes de agregar; Enter agrega y el aviso trae "Deshacer".

Lo interpreta `public/nl.js`, una función pura y local (sin IA, sin red ni costo): `NL.parse(texto, ahora)`. Reglas importantes:

- **Sin hora** no se inventa una: se abre el formulario del día con el título puesto para que elijas la hora.
- **"a las 5"** sin más se toma como p. m. de 1 a 6 y como a. m. de 7 a 11 (y lo avisa en la vista previa); con a. m./p. m., "de la tarde/noche…" o 24 horas no se supone nada.
- **Solo hora** (sin día): hoy si aún no pasa, mañana si ya pasó. **Día de la semana**: el más cercano (el de la próxima semana si hoy ya pasó esa hora).
- **Aviso** e **insistencia** se ajustan a las opciones de la app (si pides 10 min antes se usa 15, la más cercana).
- Los verbos del inicio ("recuérdame", "avísame", "agrega"…) se quitan del título; "Aviso de pago" o "Ponche" se conservan.

## Insistir hasta que lo hagas

Cada pendiente puede tener "Insistir: cada 5/10/15/30 min". Tras el primer aviso, el Worker programa `nagAt` y repite la notificación ("Sigue pendiente (2 de 5)") hasta que:

- lo marques como hecho, lo borres, o cambies la hora del aviso o el intervalo (se corta o reinicia la cadena), o
- se alcance el máximo de repeticiones de la cuenta (Ajustes → Avisos; 5 por defecto).

Cada insistencia se reserva de forma atómica y se envía a su hora exacta, igual que el primer aviso. Si el Worker estuvo caído, las insistencias atrasadas no salen en ráfaga: se envía una y la siguiente se ancla desde ese momento. Requiere el índice `(done, nagAt)`.

Limitación: si se activa "Insistir" en un pendiente que ya había avisado, la cadena no arranca (solo el Worker puede programarla); se aplica a partir del siguiente aviso.

## Precisión de los avisos

El cron de Cloudflare no corre al segundo `:00` (en este proyecto corre al `:51`), así que el Worker **no** envía lo que "ya venció": en cada ejecución atiende lo que vence en los próximos ~75 s, reserva cada tarea de forma atómica (marcándola con una condición sobre `updateTime`), espera hasta `LEAD_MS` antes de la hora exacta, vuelve a leerla por si se borró, completó o reprogramó, y entonces envía. Así el aviso sale a la hora sin depender del segundo del cron y sin duplicados entre ejecuciones solapadas. Los parámetros (`LEAD_MS`, `LOOKAHEAD_MS`, `BATCH_LIMIT`…) están en `worker/src/reminders.mjs`.

La entrega final al dispositivo depende de FCM y del sistema operativo (normalmente 1–3 s); no se puede garantizar el segundo exacto.

## Notas de seguridad

- Reglas de Firestore: cada usuario solo accede a sus documentos y el esquema se valida en el servidor.
- Hosting envía CSP y otros encabezados de seguridad (`firebase.json`). Si añades scripts o dominios externos, actualiza la CSP.
- Al cerrar sesión se borra e invalida el token push del dispositivo.

## Limitaciones conocidas

- Un aviso que llega a un dispositivo pero falla temporalmente en otro se da por enviado.
- Los recordatorios con más de 24 h de retraso se descartan.
- No hay modo offline completo ni pruebas del Worker todavía.

## Licencia

[MIT](LICENSE)
