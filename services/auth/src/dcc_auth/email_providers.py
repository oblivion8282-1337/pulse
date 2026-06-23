"""SMTP provider presets surfaced in the admin UI.

The admin picks a provider, the UI pre-fills ``host/port/use_ssl`` from
this dictionary, and the operator only has to type credentials. The
``signup_url`` and ``credentials_hint`` strings are shown next to the
form so the admin knows where in the provider's dashboard to grab the
values — Pulse can't auto-provision an account, but it can shorten the
trip.

``custom`` is the escape hatch: the admin types host/port themselves
(typical self-hoster pattern: Postfix on the same VPS, or a relay box).

We do NOT track provider-specific quirks beyond host/port here. If a
provider needs special headers or HTTP-API delivery, that would be a
separate sender backend — out of scope for the initial pass.
"""

from __future__ import annotations

from typing import TypedDict


class ProviderPreset(TypedDict):
    name: str  # Human-readable label for the dropdown.
    host: str
    port: int
    use_ssl: bool  # True = implicit TLS (port 465); False = STARTTLS (587).
    signup_url: str
    credentials_hint: str  # Shown under the form.
    from_hint: str  # Hint about the ``from_email`` field for this provider.


# Keys are stable identifiers persisted in ``smtp_settings.provider``.
# The order here matches the order shown in the admin dropdown.
PROVIDERS: dict[str, ProviderPreset] = {
    "brevo": {
        "name": "Brevo (300 Mails/Tag free)",
        "host": "smtp-relay.brevo.com",
        "port": 2525,  # alt-submission port — viele Hoster (z.B. netcup) sperren 25/465/587 ausgehend
        "use_ssl": False,
        "signup_url": "https://app.brevo.com/settings/keys/smtp",
        "credentials_hint": (
            "Brevo → Settings → SMTP & API → SMTP. "
            "Login = die angezeigte Mail-Adresse, Passwort = der SMTP-Key."
        ),
        "from_hint": (
            "Muss eine bei Brevo verifizierte Absender-Adresse sein "
            "(Senders → Add a sender)."
        ),
    },
    "mailgun": {
        "name": "Mailgun",
        "host": "smtp.eu.mailgun.org",  # US-Region: smtp.mailgun.org
        "port": 2525,  # alt-submission port — siehe Brevo-Hinweis
        "use_ssl": False,
        "signup_url": "https://app.mailgun.com/app/sending/domains",
        "credentials_hint": (
            "Mailgun → Sending → Domain settings → SMTP credentials. "
            "Default-Host ist die EU-Region; für US-Account auf 'Custom' wechseln "
            "und 'smtp.mailgun.org' eintragen."
        ),
        "from_hint": "Muss eine bei Mailgun verifizierte Domain nutzen.",
    },
    "resend": {
        "name": "Resend",
        "host": "smtp.resend.com",
        "port": 2587,  # alt-submission (STARTTLS) — 465/587 sind bei vielen Hostern (netcup) gesperrt
        "use_ssl": False,
        "signup_url": "https://resend.com/api-keys",
        "credentials_hint": (
            "Resend → API Keys → Create API Key. "
            "Login = 'resend' (literal), Passwort = der API-Key (beginnt mit 're_')."
        ),
        "from_hint": "Muss eine bei Resend verifizierte Domain nutzen.",
    },
    "gmail": {
        "name": "Gmail (App-Password)",
        "host": "smtp.gmail.com",
        "port": 465,
        "use_ssl": True,
        "signup_url": "https://myaccount.google.com/apppasswords",
        "credentials_hint": (
            "Google-Konto → Sicherheit → 2-Faktor-Bestätigung muss aktiv sein, "
            "dann App-Passwort anlegen. Login = deine Gmail-Adresse, Passwort = "
            "das 16-stellige App-Passwort (ohne Leerzeichen)."
        ),
        "from_hint": (
            "Muss exakt deine Gmail-Adresse sein — Gmail blockt sonst den Versand. "
            "Limit: ~500 Mails/Tag."
        ),
    },
    "custom": {
        "name": "Eigener SMTP-Server",
        "host": "",
        "port": 587,
        "use_ssl": False,
        "signup_url": "",
        "credentials_hint": (
            "Host/Port/Username/Passwort vom eigenen SMTP-Server (z.B. Postfix). "
            "Port 465 ⇒ implizites TLS ('SSL aktivieren'), Port 587 ⇒ STARTTLS."
        ),
        "from_hint": "",
    },
}
