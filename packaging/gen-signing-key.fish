#!/usr/bin/env fish
# One-time: create the GPG key that signs the Pulse Flatpak repo (packaging/publish.fish).
#
# The key lives in `packaging/.gpg/` — a project-local GnuPG home (gitignored), so
# it doesn't touch your `~/.gnupg`. It's passphrase-less so `publish.fish` runs
# unattended; the key only ever signs a *public* OSTree repo, so its value is low —
# but if you lose it, the friend's installed app will REJECT future updates ("GPG
# signatures found, but none are in trusted keyring"), so:
#
#   ⚠  BACK UP packaging/.gpg/  (password manager, encrypted backup, …).
#
# To regenerate from scratch: delete packaging/.gpg/, run this again, then have the
# friend reinstall from the new .flatpakref (the embedded public key changed).

set script_dir (dirname (status -f))
set gpg_home (realpath $script_dir)/.gpg
set uid 'Pulse Flatpak Repo (com.howispulse.Pulse) <oblivion8282@googlemail.com>'

if test -d $gpg_home
    echo "✗ $gpg_home already exists — nothing to do."
    echo "  (delete it and re-run to regenerate; then the friend must reinstall.)"
    exit 1
end

mkdir -p $gpg_home
chmod 700 $gpg_home

echo "→ generating signing key in $gpg_home"
gpg --homedir $gpg_home --batch --pinentry-mode loopback --passphrase '' \
    --quick-generate-key "$uid" rsa3072 sign never
or begin
    echo "✗ key generation failed"
    rm -rf $gpg_home
    exit 1
end

set keyid (gpg --homedir $gpg_home --list-keys --with-colons | string match -r '^fpr.*' | head -1 | string split ':')[10]
echo ""
echo "✓ signing key created — fingerprint: $keyid"
echo "  ⚠  back up packaging/.gpg/ somewhere safe."
echo "  → next: packaging/publish.fish   (build the repo + push it to the VPS)"
