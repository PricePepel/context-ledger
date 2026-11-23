# Signed hand-offs

A signed hand-off is a folder that lets the person who receives a session hand-off check two things: that no byte changed after it was signed, and that it was signed by the sender's key. It follows ADR-9 of the design: a raw Ed25519 signature over a manifest in RFC 8785 canonical JSON (JCS), with the key fingerprint passed out of band. The format is open, and checking a bundle needs either `ledger verify` or OpenSSL 3 alone.

Signing redacts first (card P4d). Before it signs, `--sign` runs the secret scanner that `npm run ledger -- redact <session-id>` reports from (cards P4b and P4c) over the source name, every message and the author and recipient of every agent turn, and replaces each value it finds with `[REDACTED <kind>]`. A value found once, six characters or longer, is also replaced wherever else it appears in the session, such as a password pasted into a later message without its name. The search is for the exact text, so it can also cut the same characters inside a longer word or in ordinary prose (after `password: secret`, every `secret`); a copy in another letter case, or with an invisible character inside, is not found. The signed `handoff.md` is that redacted hand-off; for a session with no findings it is byte for byte what `npm run ledger -- handoff <session-id>` prints. There is no option to sign without redaction. The manifest records that the scanner ran and how many replacements it made.

What redaction does not promise:

- **The scanner is a heuristic.** It finds known key formats, and the rest of a line after an `Authorization: Bearer` header or a secret-like name followed by `:` or `=` (such as `password=`). It skips values that are only stand-ins, such as `password=changeme`, `password=${DB_PASSWORD}` or a number alone. A value that continues onto the next line, a secret in prose that is never named, a copy of a value shorter than six characters, and formats it does not know are not found. Read `handoff.md` before you send it; `redact <session-id>` shows where each finding is, and `redact <session-id> --text` shows the redacted hand-off.
- **A false positive is removed too.** Text that only looks like a credential is replaced, and the bundle cannot be made to keep it.
- **Structure is not scanned.** The provider (`claude` or `codex`), each turn's role and line number, and the session ID are written by the ledger, not taken from the transcript, and are printed as they are. A "secret" that equals one of them (`password=codex`) is cut from the text but still shows there.
- **The session ID is public.** The `Session:` line, the manifest and the commands that print it carry it as it is. A secret-like name in the source name that happens to equal the session ID (`password=<the ID>`) is replaced in the source name but still shows as the ID, since the ID is not a secret.
- **The session ID is the hash of the original transcript.** It is in the manifest and the hand-off, so someone who could rebuild every other byte of the original transcript file could confirm a guess of a short redacted value. Real transcripts carry record IDs and timestamps that make that impractical, but do not rely on redaction to protect a short, guessable value.
- **The count is the sender's.** `redaction` in the manifest is what the sender's ledger reports, signed by the sender's key. It tells the receiver which checks ran, not that the text is free of secrets. A transcript that already held the literal text `[REDACTED aws-access-key-id]` reads the same as a replaced value.

## For the sender

1. Create a signing key once:

   ```sh
   npm run ledger -- keygen
   ```

   It prints the key's fingerprint and nothing else, for example `fd78 8b7d 761e ... 5d10` (16 groups of 4 hex digits). The private key is saved as `signing-key.pem` beside the ledger database: in `.context-ledger/` by default, or in the folder of `CONTEXT_LEDGER_DB` when that is set. `keygen` never replaces an existing key.

   - On Linux and macOS the key file is created with mode 0600, and signing refuses a key file that other users can read.
   - On Windows the file has no POSIX mode, so `keygen` sets access lists instead, with `icacls` run directly (no shell) and your account named by its SID. It first makes a temporary folder beside the key (`signing-key.pem.<random>`) that only your account can use, and creates the temporary key file inside it, so the file has only your entry from the moment it exists, even when the ledger data folder lets other accounts read. Before any key byte is written it also removes the file's inherited entries and gives your account alone full control (`icacls <file> /inheritance:r /grant:r *<your SID>:F`), so a later change to the data folder's list cannot reach the key. Signing then refuses a key file whose access list allows any other account (Everyone, Users, Authenticated Users, another user) to open it, with `Other accounts can read the signing key file.` SYSTEM and the Administrators group are allowed, as root is on Linux: they can take any file anyway. To fix a refused key, run `icacls <key file> /inheritance:r /grant:r "%USERNAME%:F"`. The check reads the access list with `icacls /save` (into a temporary folder restricted to you), so it does not depend on the display language, and it refuses a key file that is a link or that is replaced while it is being checked. The check reads the list by path, so an account that can rename files in the key's folder could still race it; such an account could replace the key anyway, so keep the ledger data folder private and out of synced folders. The check does not look at the file's owner (a key file someone else planted and owns); that is left to the human security review.
   - `keygen` writes the key to a temporary file (`signing-key.pem.<random>.tmp`, inside the temporary folder on Windows) and then hard-links it into place, so it can never replace a key or leave half a key under the real name. That needs a file system with hard links (NTFS, APFS, ext4 and the like; not FAT or exFAT). If `keygen` is killed midway, a `.tmp` file holding a private key (and on Windows its folder) can stay behind: delete it. Git ignores all these names.
   - The key is not encrypted with a passphrase yet (design section 6; card P4b). Anyone who can read the file can sign as you, so back it up like any other private key.

2. Give the fingerprint to the people who will receive your hand-offs through a channel other than the bundle itself: in person, on a call, or in a message they already trust. The fingerprint is what proves the bundle came from you; the key inside the bundle cannot prove that on its own.

3. Sign a hand-off into a new folder:

   ```sh
   npm run ledger -- handoff <session-id> --sign <new-folder>
   ```

   `--sign` reads the session straight from the ledger database (`CONTEXT_LEDGER_DB`, or `.context-ledger/ledger.sqlite` by default, the same file `npm start` opens), so the server does not need to be running. It never asks a server on `PORT` for the content it signs: whatever answered on that port would otherwise get the user's real signature. Signing never changes the database: it does not create a missing one, and it refuses a file with an older schema rather than upgrading it (start the server once with `npm start` to upgrade it). Plain `handoff` without `--sign` still asks the running server.

   The folder must not exist yet; nothing is ever overwritten. If a write fails, the files this run created are removed again (best effort: it checks that each file and the folder are still the ones it created, but a process that can rename entries in the parent folder could race that check, so sign into a folder only you can write). Signing and `verify` need a path they can resolve; on Windows an SMB share that hides one of the parent folders is refused. A run that is killed midway can leave a partial folder, which `verify` refuses: delete it and sign again. Send the whole folder (for example as a zip).

## What is in the folder

| File | What it is |
| --- | --- |
| `handoff.md` | The redacted hand-off Markdown: what `ledger handoff <session-id>` prints, with each value the scanner found replaced by `[REDACTED <kind>]`. Bundles signed before P4d (versions 1 and 2) hold it unredacted. |
| `manifest.json` | RFC 8785 canonical JSON, with no trailing newline: `format` (`context-ledger-signed-handoff`), `version` (3; bundles signed before P3b are version 1, and before P4d version 2), `algorithm` (`Ed25519`), `created_at` (UTC, milliseconds), `session`, `public_key` (base64 of the key's SubjectPublicKeyInfo DER bytes), `files`, which lists the name, byte size and SHA-256 of every content file (today only `handoff.md`), `reviews` (version 2 and later): `events` and `head`, the length and head hash of the ledger's review chain when it was signed (0 and 64 zeros when there were no reviews), and `redaction` (version 3): exactly `scanner` (the scanner and its rule version, today `context-ledger-secrets/1`) and `findings` (how many replacements it made: one per `[REDACTED <kind>]` marker, and a marker can cover several values that sat together). Versions 1 and 2 have no `redaction` and were not redacted. |
| `manifest.sig` | The 64-byte raw Ed25519 signature over the exact bytes of `manifest.json`. |
| `public-key.pem` | The same public key as `public_key`, as PEM, for OpenSSL. |

The fingerprint is the SHA-256 of the public key's SubjectPublicKeyInfo DER bytes (44 bytes for Ed25519), in hex. Spaces, colons and letter case do not matter when you compare it.

## For the receiver, with the ledger

```sh
npm run ledger -- verify <folder> --fingerprint "<fingerprint from the sender>"
```

It exits 0 only when every check passes: the manifest is canonical JCS in the expected format (versions 1 to 3 each list exactly one file, `handoff.md`; versions 2 and 3 also have a well-formed `reviews`; version 3 also has exactly the `redaction` record above, whose `scanner` is the one this build knows and whose `findings` is an integer from 0 to 9007199254740991), the signature matches the manifest, the key matches the fingerprint, `public-key.pem` holds exactly the PEM of the manifest key, `handoff.md` has its listed size and hash, and the folder holds only these four regular files (no symlink, subfolder or other file). Otherwise it prints what failed and exits 1. Without `--fingerprint` it still checks everything else, but warns that the key was not checked: anyone can make a bundle that is consistent with a key of their own.

On success it also prints the review chain at signing (or says a version 1 bundle records none) and the redaction record, for example `Redaction: 4 replacements, by context-ledger-secrets/1`. For a version 1 or 2 bundle it prints `Redaction: not recorded (a version 1 bundle)` (or 2) and warns on stderr that the hand-off was not checked for secrets. A bundle with a scanner name this build does not know (one made by a later build) is refused; verify it with that build.

### Checking the review decisions against the bundle

Anyone with the sender's ledger, such as an auditor given a copy later, can check that no review decision recorded before signing was removed or rewritten since:

```sh
npm run ledger -- reviews verify --bundle <folder> --fingerprint "<fingerprint from the sender>"
```

It verifies the bundle first, exactly as `verify` does, and trusts the signed head only if that passes. It then checks the ledger's chain and passes when the signed head is in it at the signed position. Decisions added after signing are fine. It fails when events up to the head were removed or rewritten, and for a version 1 bundle. Signing refuses a ledger whose chain is already broken.

What `verify` does not cover:

- **A folder someone is changing while it runs.** It opens no symlinks (on Linux and macOS), lists the folder again at the end and checks that every file is still the one it read, but a writer with access to the folder during the check could still race it. Verify a copy that only you can write, such as a fresh unzip into your own folder.
- **NTFS alternate data streams.** On Windows a file can carry hidden named streams. `verify` checks the folder's entries and each file's normal contents, which is what editors and agents read; named streams are neither signed nor checked.

## For the receiver, with OpenSSL only

You need OpenSSL 3.0 or later (`openssl version`). On Windows, Git for Windows includes it in Git Bash. On macOS, `/usr/bin/openssl` is LibreSSL, which may not verify Ed25519 this way; install OpenSSL 3 (for example `brew install openssl@3`). Run these from inside the bundle folder:

<!-- openssl-recipe -->
```sh
openssl pkey -pubin -in public-key.pem -outform DER | openssl dgst -sha256
openssl pkeyutl -verify -pubin -inkey public-key.pem -rawin -in manifest.json -sigfile manifest.sig
openssl dgst -sha256 handoff.md
```

1. The first command prints the key fingerprint (for example `SHA2-256(stdin)= fd788b7d...`). It must equal the fingerprint the sender gave you, ignoring spaces. If it does not, stop: the bundle was not signed by that sender. If `openssl pkey` prints an error (say `public-key.pem` is missing), most shells still run the second half of the pipe and print the hash of empty input, `e3b0c442...b855`, which never matches a real fingerprint.
2. The second must print `Signature Verified Successfully`. It proves that `manifest.json` is exactly what the key holder signed.
3. The third prints the SHA-256 of `handoff.md`. It must equal the `sha256` given for `handoff.md` in the `files` list of `manifest.json`. Do the same for any other file the list names.
4. Open `manifest.json` in a text editor. Check that `format` is `context-ledger-signed-handoff`, `version` is 1, 2 or 3, and `files` lists exactly one entry, `handoff.md`, whose `bytes` matches the file's size. For versions 2 and 3, check that `reviews` has exactly `events` and `head`: `events` a whole number from 0 to 9007199254740991 (2^53 - 1), written without a fraction or exponent, and `head` 64 lowercase hex characters, all zeros exactly when `events` is 0; version 1 has no `reviews`. For version 3, check that `redaction` has exactly two keys: `scanner`, which is `context-ledger-secrets/1` for bundles from this build, and `findings`, a whole number from 0 to 9007199254740991 (the number of replacements). Versions 1 and 2 have no `redaction`, and their hand-off was not redacted. Check that the folder holds exactly four regular files with these exact names (`handoff.md`, `manifest.json`, `manifest.sig`, `public-key.pem`), and no symlink or subfolder. A file that is not listed is not covered by the signature.

All four steps are needed: each command alone proves less than it seems to. Step 2 passes for a bundle re-signed with someone else's key, which only step 1 catches. Step 2 also passes when `handoff.md` was changed, which only step 3 catches.

The recipe checks less than `ledger verify` in three ways, none of which lets a changed hand-off through when steps 1 to 4 pass:

- It does not check that `manifest.json` is canonical JCS. That check protects tools that parse the manifest; the signature already covers its exact bytes.
- It reads the key from `public-key.pem` and does not compare it with `public_key` in the manifest, and OpenSSL accepts a PEM file with extra blank lines or other line endings. Step 1 fingerprints the decoded key, so a reformatted PEM file still gives the right answer.
- Steps 3 and 4 are manual comparisons, and OpenSSL follows symlinks, so step 4's check for regular files matters.

`tests/sign.test.mjs` runs the three commands in the block above against a freshly signed bundle whenever `openssl` is on PATH. It checks that every stage of each command succeeds on the real bundle, that step 2 refuses a manifest with one changed byte or a signature with a byte added, that step 3 gives a different hash for a changed hand-off, and that step 1 gives a different fingerprint for a bundle re-signed with another key.
