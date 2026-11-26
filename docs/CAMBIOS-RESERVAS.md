# Mejoras del sistema de reservas: Adi Nails

## 1. Bloqueo de fechas específicas

**Dónde:** Panel Admin → pestaña **Horario** → sección **Fechas específicas**.

- Elige la fecha, escribe un motivo si quieres (solo lo ves tú) y toca **Bloquear fecha**.
- La fecha queda desactivada en el calendario de las clientas. Los demás días de la semana siguen igual.
- Si ese día ya tiene citas pendientes o confirmadas, aparece un aviso con los nombres antes de bloquear.
  **Las citas no se cancelan ni se borran**: hay que avisarle a cada clienta.
- La lista **Fechas bloqueadas** muestra las fechas de hoy en adelante, cada una con su botón **Desbloquear**.
- La sección **Días de la semana** (cierres recurrentes) funciona igual que antes.

**Datos:** documento nuevo `config/fechasBloqueadas` en Firestore, con la forma
`{ list: [{ fecha: "2026-10-30", motivo: "Vacaciones" }] }`.
La fecha usa el mismo formato que `dateKey` en las citas: el mes empieza en 0, así que `2026-10-30` es el 30 de noviembre.
No se modifica `config/horario` ni ninguna cita.

**Correcciones incluidas:**
- Al reservar se usaba el horario de ejemplo del código en lugar del guardado en el panel, lo que podía guardar horas equivocadas.
- Al intentar reservar una hora que ya pasó salía un error en la consola.

## 2. Recordatorio por correo para la administradora

Todos los días a las **7:00 a. m. (hora de Costa Rica)** Vercel ejecuta `api/recordatorios.js`. Por ser el plan gratuito, puede correr en cualquier momento entre 7:00 y 7:59.

1. Busca las citas de **mañana**.
2. Envía un correo solo por las citas **confirmadas**. Las pendientes y canceladas se ignoran.
3. Marca cada cita con `recordatorioEstado: "enviado"` para no repetir el correo.
4. Antes de enviar vuelve a leer la cita, así que si la cancelaron un momento antes, no se envía.
5. Si el correo falla, guarda `recordatorioError` en la cita y se puede volver a intentar.

**Contenido del correo:** nombre, teléfono, enlace de WhatsApp, servicio, fecha completa y hora de la cita.

**Limitación:** como corre una vez al día, una cita para mañana que se confirme **después de las 7:00 a. m.** no recibe recordatorio.

### Archivos nuevos

| Archivo | Para qué |
|---|---|
| `api/recordatorios.js` | La función que corre en Vercel |
| `api/_lib/recordatorios.js` | La lógica: fechas de Costa Rica, filtros y duplicados |
| `vercel.json` | Programa la ejecución diaria (`0 13 * * *` = 13:00 UTC = 7:00 a. m. en CR) |
| `package.json` | Dependencia `firebase-admin` (para leer Firestore desde el servidor) |
| `test/recordatorios.test.js` | Pruebas (`npm test`) |

Ninguna clave queda en la página: todas van en variables de entorno de Vercel.

### Configuración (una sola vez)

**A. EmailJS** (https://dashboard.emailjs.com)
1. **Email Templates → Create New Template**, con nombre "Recordatorio de cita":
   - **To Email:** `{{to_email}}`
   - **Subject:** `Recordatorio: mañana tienes cita con {{nombre}}`
   - **Contenido** (ejemplo):
     ```
     Hola Adi, mañana tienes una cita confirmada:

     Clienta: {{nombre}}
     Teléfono: {{telefono}}  ·  WhatsApp: {{whatsapp}}
     Servicio: {{servicio}}
     Fecha: {{fecha}}
     Hora: {{hora}}

     {{notas}}
     ```
   - Guarda la plantilla y copia su **Template ID**.
2. **Account → Security:** activa **"Allow EmailJS API for non-browser applications"**.
3. **Account → API keys:** copia la **Private Key**.

**B. Firebase** (https://console.firebase.google.com)
1. ⚙ **Configuración del proyecto → Cuentas de servicio → Generar nueva clave privada**.
2. Se descarga un archivo `.json`. Ábrelo con el Bloc de notas y copia **todo** su contenido.
   Guárdalo en un lugar seguro y nunca lo compartas.

**C. Vercel** (proyecto adi-nails → **Settings → Environment Variables**, entorno *Production*)

| Nombre | Valor |
|---|---|
| `FIREBASE_SERVICE_ACCOUNT` | Todo el contenido del archivo `.json` de Firebase |
| `EMAILJS_PRIVATE_KEY` | La Private Key de EmailJS |
| `EMAILJS_TEMPLATE_ID` | El Template ID de la plantilla de recordatorio |
| `ADMIN_EMAIL` | El correo que recibe los recordatorios |
| `CRON_SECRET` | Un texto largo inventado (32 o más letras y números, sin espacios) |

Después de guardar las variables, hay que volver a publicar (*Redeploy*) para que se apliquen.

### Cómo probar

- **Ver qué se enviaría, sin enviar nada:**
  ```bash
  curl -H "Authorization: Bearer TU_CRON_SECRET" "https://adi-nails.vercel.app/api/recordatorios?prueba=1"
  ```
  Para otra fecha, agrega `&fecha=2026-12-01`.
- **Enviar un correo de prueba a la administradora** (no toca ninguna cita):
  ```bash
  curl -H "Authorization: Bearer TU_CRON_SECRET" "https://adi-nails.vercel.app/api/recordatorios?correoPrueba=1"
  ```
- **Ejecución real a mano:** Vercel → **Settings → Cron Jobs → Run**.
- **Historial de ejecuciones:** Vercel → **Logs**, filtrando por `/api/recordatorios`.

### Costos

Todo usa planes gratuitos:
- **Vercel Hobby:** incluye tareas programadas diarias.
- **EmailJS Free:** unos 200 correos al mes, compartidos con el aviso de nueva reserva.
- **Firebase Spark:** la cuenta de servicio no tiene costo.
