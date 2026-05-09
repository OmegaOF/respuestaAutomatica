# WhatsApp Chatbot Préstamos (IA local + Google Sheets)

Proyecto Node.js para atender mensajes por **WhatsApp Web**, interpretar solicitudes con **Ollama local** y actualizar una **única hoja de Google Sheets** sin tocar columnas internas protegidas.

## Características clave

- Usa `whatsapp-web.js` (no WhatsApp Business API).
- Usa IA local con Ollama (`OLLAMA_MODEL` configurable).
- Trabaja en **una sola hoja**: una fila por atención o solicitud abierta.
- Busca cliente por `NUMERO_WHATSAPP`; si no existe, busca por nombre.
- Solo escribe en columnas permitidas del chatbot.
- Nunca modifica columnas internas protegidas.
- Maneja solicitudes múltiples (agregar, reemplazar, cancelar, actualizar monto, etc.).
- Respuestas controladas por plantilla.
- Manejo robusto de errores (Ollama, Sheets, desconexión WhatsApp).

---

## Estructura

```bash
whatsapp-chatbot-prestamos/
├── index.js
├── package.json
├── .env.example
├── README.md
├── config/
│   └── tiposSolicitud.json
├── services/
│   ├── whatsappService.js
│   ├── ollamaService.js
│   ├── googleSheetsService.js
│   └── chatbotService.js
├── utils/
│   ├── dateUtils.js
│   ├── textUtils.js
│   └── solicitudesUtils.js
└── logs/
    └── .gitkeep
```

## 1) Instalar Node.js

- Descargar LTS desde: https://nodejs.org
- Verificar:

```bash
node -v
npm -v
```

## 2) Instalar Ollama

- Descargar desde: https://ollama.com/download
- Verificar:

```bash
ollama --version
```

## 3) Descargar modelo local

```bash
ollama pull mistral
```

También puedes usar otro modelo, por ejemplo `llama3.1`, cambiando `.env`.

## 4) Configurar Google Sheets API y cuenta de servicio

1. Entrar a Google Cloud Console.
2. Crear proyecto (o reutilizar uno).
3. Habilitar Google Sheets API.
4. Crear **Service Account**.
5. Crear clave JSON y descargarla.
6. Guardar el archivo en:
   - `./credentials/google-service-account.json`
7. Copiar el email de la cuenta de servicio (ej: `mi-bot@mi-proyecto.iam.gserviceaccount.com`).
8. Abrir tu hoja de Google Sheets y compartirla con ese email (permiso Editor).

## 5) Configuración del proyecto

```bash
cp .env.example .env
```

Completar `.env`:

- `GOOGLE_SHEET_ID` → ID de tu hoja.
- `GOOGLE_SHEET_NAME` → nombre de pestaña (ej. `Clientes`).
- `GOOGLE_APPLICATION_CREDENTIALS` → ruta al JSON.
- `OLLAMA_URL` → normalmente `http://localhost:11434/api/generate`.
- `OLLAMA_MODEL` → `mistral` o el que descargaste.
- `TIMEZONE` → por defecto `America/La_Paz`.
- `OLLAMA_TIMEOUT_MS` → timeout de Ollama en milisegundos; por defecto `45000`.
- `DEBUG_WHATSAPP_IDS` → `true` solo para depurar qué identificadores entrega WhatsApp Web; por defecto `false`.
- `BOT_RESPONSE_DELAY_MS` → espera normal antes de responder desde el último mensaje; por defecto `45000`.
- `BOT_MAX_RESPONSE_DELAY_MS` → espera máxima absoluta desde el primer mensaje del bloque; por defecto `60000`.
- `BOT_MAX_BUFFER_MESSAGES` → cantidad máxima de mensajes recientes que se juntan antes de analizar; por defecto `8`.

## 6) Instalar dependencias

```bash
npm install
```

## 7) Ejecutar chatbot

```bash
npm start
```

- Se mostrará un QR en consola para vincular WhatsApp Web.
- Escanear con el teléfono.

---

## Seguridad y control (reglas implementadas)

- El bot **no aprueba préstamos**.
- El bot **no toma decisiones financieras**.
- El bot **no modifica columnas internas** (`CUOTA`, `Deuda General`, `BONO ABRIL`, `BONO JUNIO`, `AGUI`, `TOTAL`).
- El bot solo registra, resume, ordena solicitudes y deriva a humano cuando corresponde.
- Todo mensaje privado se registra primero con datos mínimos en Google Sheets antes de llamar a la IA.
- El bot espera un breve periodo antes de responder para agrupar mensajes rápidos del mismo cliente; registra inmediatamente, pero analiza y responde después del buffer conversacional.
- Si WhatsApp Web no entrega un número real, se registra temporalmente el identificador disponible, se deja constancia en `OBSERVACIONES` y se pide el celular real al cliente.
- Si falla IA u Ollama no responde a tiempo, el mensaje ya queda registrado y el bot intenta interpretar con reglas locales antes de derivar a revisión humana.

## Configuración dinámica de tipos de solicitud

Editar:

- `config/tiposSolicitud.json`

Allí puedes agregar nuevos tipos (ej. `BONO_NAVIDAD`) y sinónimos sin tocar código.

## Notas operativas

- Se ignoran grupos (`@g.us`).
- Se ignoran mensajes propios (`fromMe`).
- Una fila representa una atención o solicitud abierta; un cliente puede tener varias líneas históricas.
- Los mensajes por partes del mismo número actualizan la misma atención activa: `ULTIMO_MENSAJE` y `FECHA_ULTIMO_CONTACTO` se refrescan, y `OBSERVACIONES` conserva contexto breve. Si el primer mensaje deja una solicitud con `NO_INDICADO`, un mensaje posterior con solo el monto puede completar esa misma solicitud.
- La IA recibe mensajes recientes, mensaje combinado, solicitudes previas, estado actual y observaciones relevantes para interpretar la conversación completa.
- `ESTADO_CHATBOT` usa estados activos (`NUEVO`, `PENDIENTE_DATOS`, `EN_REVISION`) y finales (`APROBADO`, `RECHAZADO`, `CERRADO`).

## Logs en consola

Incluye trazas para:

- registro mínimo creado o actualizado por número
- mensaje recibido
- cliente encontrado/no encontrado
- acción detectada por IA
- fila actualizada
- error en Google Sheets
- error o timeout controlado en Ollama
- fallback por reglas cuando Ollama no entiende o no responde


## Lógica final aprobada

- **Una línea = una atención o solicitud abierta**, no un cliente único. Una atención activa puede contener varias solicitudes en `SOLICITUDES_DETECTADAS`.
- **Estados activos**: `NUEVO`, `PENDIENTE_DATOS`, `EN_REVISION`. Mientras una línea esté activa, el bot puede actualizar esa misma atención.
- **Estados finales**: `APROBADO`, `RECHAZADO`, `CERRADO`. El humano decide manualmente cuándo cerrar, aprobar o rechazar; el bot no finaliza solicitudes por cuenta propia.
- Si la atención está finalizada y el cliente vuelve a solicitar algo, el bot crea una **nueva línea** y no modifica la línea finalizada.
- `NUMERO_WHATSAPP` es un dato de contacto y ayuda a ubicar atenciones activas, pero el nombre oficial depende de `NOMBRE DE CLIENTE`. Cuando WhatsApp Web solo entrega un identificador interno, el bot deja `Identificador WhatsApp interno: ...` en `OBSERVACIONES` para ubicar la atención activa y solicita el celular real.
- El nombre visible de WhatsApp (`pushname`, `name` o `shortName`) solo se usa como referencia en logs/contexto de IA; **no se escribe ni se usa como nombre oficial**.
- `NOMBRE DE CLIENTE` depende de una lista interna, validación o sugerencia de Google Sheets. Si `nombre_detectado` coincide con esa lista/base, se puede escribir en `NOMBRE DE CLIENTE`.
- Si `nombre_detectado` no coincide, el bot **no fuerza** ese valor en `NOMBRE DE CLIENTE`; crea la línea con nombre vacío, guarda el nombre en `OBSERVACIONES` y marca `REQUIERE_HUMANO=SI`.
- Si falta nombre completo, el bot registra o actualiza la atención con `ESTADO_CHATBOT=PENDIENTE_DATOS`, guarda contexto breve en `OBSERVACIONES`, conserva un pendiente temporal en memoria por `NUMERO_WHATSAPP` y solicita el nombre completo.
- Los pendientes temporales viven en memoria (`Map`) y ayudan a unir mensajes por partes, pero Google Sheets conserva el registro mínimo aunque el servidor se reinicie.
- Los ejemplos de mensajes son referenciales. La interpretación del lenguaje natural la hace Ollama; el código solo valida el JSON estructurado y aplica reglas seguras.
- `ESTADO_CHATBOT` mantiene estados limpios: activos (`NUEVO`, `PENDIENTE_DATOS`, `EN_REVISION`) y finales (`APROBADO`, `RECHAZADO`, `CERRADO`). Los detalles técnicos como timeout, falta de nombre o solicitud no entendida se escriben en `OBSERVACIONES`, no como estados nuevos.

## Columnas y orden esperado

El bot respeta una sola pestaña principal con este orden lógico:

1. `OBSERVACIONES`
2. `NOMBRE DE CLIENTE`
3. columnas del chatbot: `NUMERO_WHATSAPP`, `ULTIMO_MENSAJE`, `SOLICITUD_ACTUAL`, `SOLICITUDES_DETECTADAS`, `ESTADO_CHATBOT`, `FECHA_ULTIMO_CONTACTO`, `REQUIERE_HUMANO`
4. columnas internas protegidas: `CUOTA`, `Deuda General`, `BONO ABRIL`, `BONO JUNIO`, `AGUI`, `TOTAL`

Si faltan columnas del chatbot, se insertan después de `NOMBRE DE CLIENTE` y antes de `CUOTA`. El bot no crea ni usa columnas antiguas como `OBSERVACION_CHATBOT`, `NOMBRE_DETECTADO_CHATBOT`, `ULTIMA_RESPUESTA_CHATBOT`, `INTENCION_CHATBOT`, `TIPO_SOLICITUD` o `MONTO_SOLICITADO`.

## Flujos principales

- **Registro mínimo garantizado**: cada mensaje privado crea o actualiza una atención activa por `NUMERO_WHATSAPP` antes de llamar a Ollama. Se guarda `NUMERO_WHATSAPP`, `ULTIMO_MENSAJE`, `FECHA_ULTIMO_CONTACTO`, `ESTADO_CHATBOT=NUEVO`, `REQUIERE_HUMANO=NO` y `OBSERVACIONES=Mensaje recibido. Pendiente de análisis.`.
- **Buffer conversacional**: el bot agrupa mensajes recientes por cliente y responde una sola vez cuando pasa `BOT_RESPONSE_DELAY_MS` sin nuevos mensajes, o cuando llega `BOT_MAX_RESPONSE_DELAY_MS` desde el primer mensaje del bloque.
- **Sin nombre**: si la IA detecta solicitud pero no nombre completo, la fila queda registrada con `ESTADO_CHATBOT=PENDIENTE_DATOS`, se acumula `Falta nombre completo. Se solicitó al cliente.` en `OBSERVACIONES`, se guarda pendiente temporal y se responde con `FALTA_NOMBRE`.
- **Respuesta con nombre**: al recibir el nombre desde el mismo número, se recupera el pendiente, se busca coincidencia en `NOMBRE DE CLIENTE`, se registra la atención y se elimina el pendiente.
- **Nombre coincidente**: se usa el nombre oficial, se busca atención activa y se actualiza; si no hay activa, se crea nueva línea.
- **Nombre no coincidente**: se crea nueva línea con `NOMBRE DE CLIENTE` vacío, se registra el nombre detectado en `OBSERVACIONES` y se marca revisión humana.
- **Falta monto**: se guarda `NO_INDICADO`, `ESTADO_CHATBOT=PENDIENTE_DATOS` y se responde con `FALTA_MONTO`.
- **IA no entiende**: se actualiza la misma atención activa con `ESTADO_CHATBOT=EN_REVISION`, `REQUIERE_HUMANO=SI` y `OBSERVACIONES=Solicitud no entendida. Revisar manualmente.`.
- **Respuesta de IA validada**: Ollama puede devolver `respuesta_cliente`, pero el bot la valida y reemplaza por plantilla segura si contiene promesas de aprobación, desembolso, cobro o datos financieros reales.
- **Fallback por reglas**: si Ollama no responde o devuelve una solicitud no entendida, el bot intenta detectar `DEUDA_GENERAL`, `AGUINALDO`, `BONO_ABRIL`, `BONO_JUNIO`, nombres, teléfonos y montos como `3000`, `3000 bs` o `Bs 3000`.
- **Timeout de Ollama**: si las reglas entienden algo, se actualiza la misma atención y se responde según el dato faltante; si tampoco entienden, se usa `ESTADO_CHATBOT=EN_REVISION`, `REQUIERE_HUMANO=SI` y `OBSERVACIONES=IA no respondió y no se pudo interpretar por reglas.`.
- **REEMPLAZAR inseguro**: si llega `REEMPLAZAR` sin solicitudes claras, no se borran solicitudes anteriores y se deriva a revisión humana.


## Pruebas locales

```bash
npm run test:rules
```

Este script valida el fallback por reglas, contrato conversacional, mensajes rápidos agrupados, mensajes por partes, respuestas seguras, observaciones limitadas y que no se generen actualizaciones para columnas protegidas.
