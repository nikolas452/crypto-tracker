/**
 * Plantilla de email para la notificación de una alerta disparada (spec
 * email-templates). `render()` es una función pura: mismo input siempre
 * produce el mismo output, sin I/O ni efectos secundarios — toda fecha
 * usada sale del propio payload (`triggeredAt`), nunca de un reloj leído
 * acá adentro. No importa nada de módulos que tocan Mongoose (mantiene este
 * módulo desacoplado): define su propio tipo de payload, estructuralmente
 * equivalente a `NotificationPayloadDto`.
 */

/** Los tres tipos de alerta soportados (mismos valores que `AlertType` en `alerts.model.ts`, redeclarados acá para no importar ese módulo). */
export type RenderAlertType = 'PRICE_ABOVE' | 'PRICE_BELOW' | 'CHANGE_24H_ABS_GTE';

/**
 * Payload que recibe `render()`: el `payload` congelado de la notificación
 * (mismo shape que `NotificationPayloadDto`/`NotificationPayloadInput`) más
 * el `alertId` (campo separado de la notificación, no parte del payload
 * congelado, necesario para el texto de baja de la alerta) y
 * `displayTimezone` (el caller inyecta `config.MAIL_DISPLAY_TIMEZONE` — este
 * módulo nunca lee `config` directamente, para seguir siendo puro).
 */
export interface RenderAlertTriggeredPayload {
  readonly coingeckoId: string;
  readonly coinName: string;
  readonly symbol: string;
  readonly alertType: RenderAlertType;
  readonly threshold: number;
  readonly value: number;
  readonly priceUsd: number;
  readonly change24hPct: number | null;
  readonly triggeredAt: Date;
  readonly note: string | null;
  readonly alertId: string;
  readonly displayTimezone: string;
}

export interface RenderedAlertTriggeredEmail {
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

/**
 * Escapa los cinco caracteres relevantes para HTML. El orden importa: `&`
 * primero, para no doble-escapar los `&amp;`/`&lt;`/etc. que las siguientes
 * reemplazos introducen.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Formatea un monto en USD (es-AR). Hasta 8 decimales cuando el valor
 * absoluto es menor a 1, para que un precio bajo (ej. $0.00034521) no se
 * redondee a $0.00; 2 decimales en el resto de los casos.
 */
function formatCurrency(amount: number): string {
  const maximumFractionDigits = Math.abs(amount) < 1 ? 8 : 2;
  return new Intl.NumberFormat('es-AR', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits,
  }).format(amount);
}

/**
 * Formatea un porcentaje ya expresado en unidades porcentuales (ej. `12.5`
 * significa 12,5%, no 0.125) — así es como `change24hPct`/`threshold` de una
 * alerta `CHANGE_24H_ABS_GTE` se guardan en todo el resto del código (ver
 * `alerts.decide.ts`), por eso NO se usa `Intl.NumberFormat` con
 * `style: 'percent'` (que espera una fracción 0-1).
 */
function formatPercent(value: number): string {
  const formatted = new Intl.NumberFormat('es-AR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
  return `${formatted}%`;
}

/** El valor que disparó la alerta: porcentual para `CHANGE_24H_ABS_GTE`, monetario para los otros dos tipos. */
function formatTriggeringValue(payload: RenderAlertTriggeredPayload): string {
  return payload.alertType === 'CHANGE_24H_ABS_GTE'
    ? formatPercent(payload.value)
    : formatCurrency(payload.value);
}

/** Describe en español la condición configurada de la alerta y su umbral. */
function describeCondition(alertType: RenderAlertType, threshold: number): string {
  switch (alertType) {
    case 'PRICE_BELOW':
      return `el precio cayó por debajo de ${formatCurrency(threshold)}`;
    case 'PRICE_ABOVE':
      return `el precio alcanzó o superó ${formatCurrency(threshold)}`;
    case 'CHANGE_24H_ABS_GTE':
      return `la variación de las últimas 24 horas alcanzó o superó ${formatPercent(threshold)}`;
  }
}

/** Timestamp del disparo en dos formas: UTC (ISO 8601) y hora local de referencia en `displayTimezone`. */
function formatTriggeredAt(
  triggeredAt: Date,
  displayTimezone: string,
): { readonly utcIso: string; readonly local: string } {
  const utcIso = triggeredAt.toISOString();
  const local = new Intl.DateTimeFormat('es-AR', {
    timeZone: displayTimezone,
    dateStyle: 'medium',
    timeStyle: 'medium',
  }).format(triggeredAt);
  return { utcIso, local };
}

/** Arma el asunto según el tipo de alerta; la sanitización de `\r`/`\n` se aplica al final, sobre el string ya compuesto. */
function buildSubject(payload: RenderAlertTriggeredPayload): string {
  let raw: string;
  switch (payload.alertType) {
    case 'PRICE_BELOW':
      raw = `${payload.symbol}: precio bajó de ${formatCurrency(payload.threshold)}`;
      break;
    case 'PRICE_ABOVE':
      raw = `${payload.symbol}: precio superó ${formatCurrency(payload.threshold)}`;
      break;
    case 'CHANGE_24H_ABS_GTE':
      raw = `${payload.symbol}: variación 24h de ${formatPercent(payload.value)}`;
      break;
  }
  // Paso final (spec: "after all interpolation"): elimina cualquier \r o \n
  // que el nombre/símbolo de una moneda mal formada pudiera haber inyectado
  // en el header de asunto.
  return raw.replace(/[\r\n]/g, '');
}

const DISABLE_METHOD_AND_PATH = (alertId: string): string => `PATCH /api/v1/me/alerts/${alertId}`;
const DISABLE_BODY = '{ "enabled": false }';

function buildTextBody(payload: RenderAlertTriggeredPayload): string {
  const { utcIso, local } = formatTriggeredAt(payload.triggeredAt, payload.displayTimezone);
  const changeLine =
    payload.change24hPct === null ? 'sin datos' : formatPercent(payload.change24hPct);

  const lines: string[] = [
    'Tu alerta se disparó.',
    '',
    `Moneda: ${payload.coinName} (${payload.symbol})`,
    `Condición configurada: ${describeCondition(payload.alertType, payload.threshold)}`,
    `Valor que disparó la alerta: ${formatTriggeringValue(payload)}`,
    `Precio USD al momento del disparo: ${formatCurrency(payload.priceUsd)}`,
    `Variación 24h: ${changeLine}`,
    `Fecha y hora (UTC): ${utcIso}`,
    `Fecha y hora local (${payload.displayTimezone}): ${local}`,
  ];

  if (payload.note !== null) {
    lines.push('', `Nota: ${payload.note}`);
  }

  lines.push(
    '',
    'Para desactivar esta alerta, hacé esta llamada a la API:',
    DISABLE_METHOD_AND_PATH(payload.alertId),
    `Body: ${DISABLE_BODY}`,
  );

  return lines.join('\n');
}

function buildHtmlBody(payload: RenderAlertTriggeredPayload): string {
  const { utcIso, local } = formatTriggeredAt(payload.triggeredAt, payload.displayTimezone);
  const changeLine =
    payload.change24hPct === null ? 'sin datos' : formatPercent(payload.change24hPct);

  const coinName = escapeHtml(payload.coinName);
  const symbol = escapeHtml(payload.symbol);
  const condition = escapeHtml(describeCondition(payload.alertType, payload.threshold));

  const noteRow =
    payload.note !== null
      ? `<p style="margin:0 0 12px;"><strong>Nota:</strong> ${escapeHtml(payload.note)}</p>`
      : '';

  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#111827;">
  <p style="margin:0 0 12px;">Tu alerta se disparó.</p>
  <table style="border-collapse:collapse;margin:0 0 12px;" cellpadding="4" cellspacing="0">
    <tr><td style="color:#6b7280;">Moneda</td><td>${coinName} (${symbol})</td></tr>
    <tr><td style="color:#6b7280;">Condición configurada</td><td>${condition}</td></tr>
    <tr><td style="color:#6b7280;">Valor que disparó la alerta</td><td>${formatTriggeringValue(payload)}</td></tr>
    <tr><td style="color:#6b7280;">Precio USD al momento del disparo</td><td>${formatCurrency(payload.priceUsd)}</td></tr>
    <tr><td style="color:#6b7280;">Variación 24h</td><td>${changeLine}</td></tr>
    <tr><td style="color:#6b7280;">Fecha y hora (UTC)</td><td>${utcIso}</td></tr>
    <tr><td style="color:#6b7280;">Fecha y hora local (${escapeHtml(payload.displayTimezone)})</td><td>${local}</td></tr>
  </table>
  ${noteRow}
  <p style="margin:0 0 4px;">Para desactivar esta alerta, hacé esta llamada a la API:</p>
  <p style="margin:0 0 4px;font-family:monospace;">${DISABLE_METHOD_AND_PATH(payload.alertId)}</p>
  <p style="margin:0;font-family:monospace;">Body: ${escapeHtml(DISABLE_BODY)}</p>
</div>`;
}

/** Renderiza el email de "alerta disparada" a partir del payload congelado de la notificación. Pura y determinística. */
export function render(payload: RenderAlertTriggeredPayload): RenderedAlertTriggeredEmail {
  return {
    subject: buildSubject(payload),
    text: buildTextBody(payload),
    html: buildHtmlBody(payload),
  };
}
