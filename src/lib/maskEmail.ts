/**
 * Enmascara una dirección de email para que pueda aparecer en logs `info`
 * sin exponer la dirección completa (spec user-profile: "el log de creación
 * omite el email"; RNF-3.2: ningún log contiene un email completo).
 * Conserva solo el primer carácter de la parte local y el dominio completo:
 * `nicolas@example.com` -> `n***@example.com`.
 */
export function maskEmail(email: string): string {
  const atIndex = email.indexOf('@');

  if (atIndex <= 0 || atIndex === email.length - 1) {
    return '***';
  }

  const localPart = email.slice(0, atIndex);
  const domain = email.slice(atIndex + 1);

  return `${localPart[0]}***@${domain}`;
}
