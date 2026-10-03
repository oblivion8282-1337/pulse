#!/usr/bin/env python3
"""Selbstsign-Cert für MediaMTX-RTMPS (Äquivalent zum openssl-Aufruf in
08-init-mediamtx.sh — openssl gibt es auf Windows nicht verlässlich, dafür
ist `cryptography` in der Service-venv).

Aufruf: python gen_selfsigned_cert.py <cert-out> <key-out> <cn>
"""
import datetime
import ipaddress
import socket
import sys

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID


def main() -> int:
    cert_out, key_out, cn = sys.argv[1], sys.argv[2], sys.argv[3]
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, cn)])
    sans = [x509.DNSName(cn)]
    try:
        sans.append(x509.IPAddress(ipaddress.ip_address(socket.gethostbyname(cn))))
    except (socket.gaierror, ValueError):
        pass
    now = datetime.datetime.now(datetime.timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(days=1))
        .not_valid_after(now + datetime.timedelta(days=3650))
        .add_extension(x509.SubjectAlternativeName(sans), critical=False)
        .sign(key, hashes.SHA256())
    )
    with open(key_out, "wb") as f:
        f.write(key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.TraditionalOpenSSL,
            serialization.NoEncryption(),
        ))
    with open(cert_out, "wb") as f:
        f.write(cert.public_bytes(serialization.Encoding.PEM))
    return 0


if __name__ == "__main__":
    sys.exit(main())
