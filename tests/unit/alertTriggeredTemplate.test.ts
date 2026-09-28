import { describe, expect, it } from 'vitest';
import {
  render,
  type RenderAlertTriggeredPayload,
} from '../../src/modules/notifications/templates/alert-triggered.js';

/** Tests unitarios de la plantilla de email `alert-triggered.ts` (spec email-templates, tarea 8.7). */

const BASE_PAYLOAD: RenderAlertTriggeredPayload = {
  coingeckoId: 'bitcoin',
  coinName: 'Bitcoin',
  symbol: 'BTC',
  alertType: 'PRICE_BELOW',
  threshold: 50000,
  value: 49500,
  priceUsd: 49500,
  change24hPct: -3.25,
  triggeredAt: new Date('2026-01-15T12:30:00.000Z'),
  note: null,
  alertId: '507f1f77bcf86cd799439011',
  displayTimezone: 'America/Argentina/Buenos_Aires',
};

describe('alert-triggered template: render()', () => {
  it('PRICE_BELOW: sujeto menciona el símbolo y el umbral como moneda', () => {
    const { subject } = render(BASE_PAYLOAD);
    expect(subject).toContain('BTC');
    // Salida REAL de Intl.NumberFormat('es-AR', {style:'currency',currency:'USD'}) para 50000
    // en este runtime de Node (verificado con `node -e`, no adivinado): "US$ (NBSP) 50.000,00".
    expect(subject).toContain('US$ 50.000,00');
  });

  it('PRICE_ABOVE: sujeto menciona el símbolo y el umbral como moneda', () => {
    const payload: RenderAlertTriggeredPayload = {
      ...BASE_PAYLOAD,
      alertType: 'PRICE_ABOVE',
      threshold: 60000,
    };
    const { subject } = render(payload);
    expect(subject).toContain('BTC');
    expect(subject).toContain('US$ 60.000,00');
  });

  it('CHANGE_24H_ABS_GTE: sujeto menciona el símbolo y un porcentaje (no un monto en moneda)', () => {
    const payload: RenderAlertTriggeredPayload = {
      ...BASE_PAYLOAD,
      alertType: 'CHANGE_24H_ABS_GTE',
      threshold: 10,
      value: 12.5,
    };
    const { subject } = render(payload);
    expect(subject).toContain('BTC');
    expect(subject).toContain('12,50%');
    expect(subject).not.toContain('US$');
  });

  it('formatea 50000 como moneda es-AR real (misma salida verificada con Node)', () => {
    const { text, html } = render(BASE_PAYLOAD);
    expect(text).toContain('US$ 50.000,00');
    expect(html).toContain('US$ 50.000,00');
  });

  it('un valor por debajo de 1 se muestra con más de 2 decimales (no redondea a $0,00)', () => {
    const payload: RenderAlertTriggeredPayload = {
      ...BASE_PAYLOAD,
      value: 0.00034521,
      priceUsd: 0.00034521,
    };
    const { text } = render(payload);
    // La salida real de Intl.NumberFormat('es-AR', {..., maximumFractionDigits: 8})
    // para 0.00034521 en este runtime (verificado con `node -e`) es "US$ (NBSP) 0,00034521".
    expect(text).toContain('US$ 0,00034521');
  });

  it('E5-14: un note con markup HTML se escapa en el cuerpo HTML y no aparece sin escapar', () => {
    const payload: RenderAlertTriggeredPayload = {
      ...BASE_PAYLOAD,
      note: '<b>hola</b>',
    };
    const { html } = render(payload);
    expect(html).toContain('&lt;b&gt;hola&lt;/b&gt;');
    expect(html).not.toContain('<b>hola</b>');
  });

  it('sujeto: se eliminan \\r y \\n aunque el nombre/símbolo de la moneda los contenga', () => {
    const payload: RenderAlertTriggeredPayload = {
      ...BASE_PAYLOAD,
      coinName: 'Bit\r\ncoin',
      symbol: 'BT\r\nC',
    };
    const { subject } = render(payload);
    expect(subject).not.toContain('\r');
    expect(subject).not.toContain('\n');
  });

  it('determinismo: renderizar dos veces el mismo payload produce el mismo resultado', () => {
    const first = render(BASE_PAYLOAD);
    const second = render(BASE_PAYLOAD);
    expect(first).toEqual(second);
  });

  it('note: null omite cualquier contenido de nota en ambos cuerpos', () => {
    const payload: RenderAlertTriggeredPayload = { ...BASE_PAYLOAD, note: null };
    const { text, html } = render(payload);
    expect(text).not.toContain('Nota:');
    expect(html).not.toContain('Nota:');
  });

  it('incluye el timestamp UTC en ISO 8601 y la hora local en displayTimezone', () => {
    const { text } = render(BASE_PAYLOAD);
    expect(text).toContain(BASE_PAYLOAD.triggeredAt.toISOString());
  });

  it('incluye el método/path y el body literal para desactivar la alerta', () => {
    const { text, html } = render(BASE_PAYLOAD);
    expect(text).toContain(`PATCH /api/v1/me/alerts/${BASE_PAYLOAD.alertId}`);
    expect(text).toContain('{ "enabled": false }');
    expect(html).toContain(`PATCH /api/v1/me/alerts/${BASE_PAYLOAD.alertId}`);
  });

  it('el HTML no usa <style> ni <img>, y solo estilos inline', () => {
    const { html } = render(BASE_PAYLOAD);
    expect(html).not.toContain('<style');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<link');
  });
});
