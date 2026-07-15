/**
 * SMTP provider presets surfaced in the admin UI. These presets live only
 * here; the backend enum-validates the provider key via the ``SmtpProvider``
 * literal in ``services/auth/src/dcc_auth/schemas.py`` — keep that literal in
 * sync when adding a provider.
 *
 * Kept here (not inline in ``AdminSmtp.svelte``) so the component stays
 * under the 250-line Svelte size cap and so a future use case (e.g. a
 * provider chooser on a different page) can re-use the dict without
 * importing a UI component.
 */

import type { SmtpProvider } from '$lib/api/admin';

export type SmtpPreset = {
  /** Human-readable label for the dropdown. */
  name: string;
  /** Default SMTP host. Empty for ``custom`` (admin types their own). */
  host: string;
  /** Default port (typically 587 for STARTTLS, 465 for implicit TLS). */
  port: number;
  /** Default ``use_ssl`` — true = implicit TLS, false = STARTTLS-upgrade. */
  use_ssl: boolean;
  /** Direct link to the provider's settings page where the creds live.
   * Rendered as "Provider-Settings öffnen" next to the dropdown. */
  signup_url: string;
  /** Short German prose telling the admin where to grab the credentials. */
  credentials_hint: string;
  /** Hint about the ``from_email`` field for this provider (verification
   * requirements etc.). Empty if no hint applies. */
  from_hint: string;
};

export const SMTP_PRESETS: Record<SmtpProvider, SmtpPreset> = {
  brevo: {
    name: 'Brevo (300 Mails/Tag free)',
    host: 'smtp-relay.brevo.com',
    port: 587,
    use_ssl: false,
    signup_url: 'https://app.brevo.com/settings/keys/smtp',
    credentials_hint:
      'Brevo → Settings → SMTP & API → SMTP. Login = die angezeigte Mail-Adresse, Passwort = der SMTP-Key.',
    from_hint:
      'Muss eine bei Brevo verifizierte Absender-Adresse sein (Senders → Add a sender).'
  },
  mailgun: {
    name: 'Mailgun',
    host: 'smtp.eu.mailgun.org',
    port: 587,
    use_ssl: false,
    signup_url: 'https://app.mailgun.com/app/sending/domains',
    credentials_hint:
      "Mailgun → Sending → Domain settings → SMTP credentials. Default-Host ist die EU-Region; für US-Account 'smtp.mailgun.org' eintragen.",
    from_hint: 'Muss eine bei Mailgun verifizierte Domain nutzen.'
  },
  resend: {
    name: 'Resend',
    host: 'smtp.resend.com',
    port: 465,
    use_ssl: true,
    signup_url: 'https://resend.com/api-keys',
    credentials_hint:
      "Resend → API Keys → Create API Key. Login = 'resend' (literal), Passwort = der API-Key (beginnt mit 're_').",
    from_hint: 'Muss eine bei Resend verifizierte Domain nutzen.'
  },
  gmail: {
    name: 'Gmail (App-Password)',
    host: 'smtp.gmail.com',
    port: 465,
    use_ssl: true,
    signup_url: 'https://myaccount.google.com/apppasswords',
    credentials_hint:
      'Google-Konto → Sicherheit → 2-Faktor-Bestätigung muss aktiv sein, dann App-Passwort anlegen. Login = deine Gmail-Adresse, Passwort = das 16-stellige App-Passwort (ohne Leerzeichen).',
    from_hint: 'Muss exakt deine Gmail-Adresse sein. Limit ~500 Mails/Tag.'
  },
  custom: {
    name: 'Eigener SMTP-Server',
    host: '',
    port: 587,
    use_ssl: false,
    signup_url: '',
    credentials_hint:
      'Host/Port/Username/Passwort vom eigenen SMTP-Server (z.B. Postfix). Port 465 ⇒ implizites TLS, Port 587 ⇒ STARTTLS.',
    from_hint: ''
  }
};
