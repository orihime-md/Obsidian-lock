# ❖ OBSIDIAN LOCK — Multi-Device Group Sentinel Bot

A WhatsApp group administration bot built with `@whiskeysockets/baileys` and designed to run as a Render web service.

## Owner protection and command access

Set the Render environment variable below before deploying:

| Variable | Value |
|---|---|
| `BOT_OWNER_NUMBER` | The owner's full WhatsApp number with country code, digits only (example format: `2348012345678`) |

The owner number is recognized globally by every paired bot session. During an active lockdown, the sentinel will not automatically demote or remove the owner. It also skips automated roster reversals for group participant changes initiated by the owner. The owner is protected even when not listed with `.LK-promote`.

**Command access:** the configured owner, every successfully paired bot account, and numbers added with `.syncN` can use the full command set across the running service. Other numbers cannot operate the bot. Only the configured owner can add or remove synchronized numbers. The `.syncN` list is separate from `.LK-promote`: it grants command access but does not automatically grant WhatsApp group-admin status.

If `BOT_OWNER_NUMBER` is missing or invalid, owner-specific protection cannot work. The bot logs a warning and displays `NOT CONFIGURED` in `.menu`.

## Existing commands (unchanged)

- `.menu` — Displays the command menu.
- `.setprefix <prefix>` — Changes the command prefix (for example, `!`, `/`, `#`).
- `.groupid` — Returns the current group JID.
- `.LK-promote 23480...,23481...` — Adds phone numbers to the protected-admin list.
- `.syncN 23480...,23481...` — Owner-only; grants full bot command access to the listed numbers across paired sessions. Use `.syncN` with no numbers to view the current list, `.syncN remove 23480...` to revoke selected numbers, or `.syncN clear` to clear the list.
- `.group-LK [group_id]` — Executes emergency lockdown on the specified group or current group.
- `.group-LK off [group_id]` — Disarms the lockdown and re-opens group permissions.

The commands above continue to use the configured prefix, so after `.setprefix !`, use `!menu`, `!group-LK`, and so on.

## Render deployment (Free plan)

1. Push these project files to GitHub.
2. In Render, create a **Web Service** and select the repository.
3. Use:
   - **Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Plan:** Free
4. In **Environment**, add `BOT_OWNER_NUMBER` and set it to the owner's full international WhatsApp number using digits only.
5. Deploy, open the service URL, enter a WhatsApp number with country code, and use the pairing code in WhatsApp under **Linked Devices → Link with phone number**.

## Important Free-plan storage limitation

No external database, paid storage, or persistent-volume dependency has been added. Session credentials and local settings (including synchronized command-access numbers) are kept in the service's local `sessions/` and `data/store.json` folders. Render Free instances use ephemeral local storage, so session files, the prefix, protected-admin list, synchronized numbers, and lockdown state may be lost after a restart, spin-down, or redeploy. A fresh pairing may then be required.

## Reliability fixes included

- Serves the existing root `index.html` through the correct `public/` directory without exposing session or data folders.
- Repairs the pairing-status download path while keeping the previous `public/index.html` download URL as an alias.
- Waits for the WhatsApp socket to initialize before requesting a pairing code.
- Prevents duplicate socket creation for the same phone number within one running instance.
- Correctly reads Baileys disconnect status codes and avoids reconnecting logged-out sessions.
- Processes every message in a notification batch rather than only the first message.
- Adds in-memory pairing-request rate limiting and pairing status timeouts.
- Logs failed group operations instead of silently swallowing every error, and reports partial lockdown failures.
- Uses safe local JSON writes; no external database or persistence service is required.

## Notes

The bot must be a group administrator for group administration actions. WhatsApp may reject promotions, re-add requests, or other actions due to group permissions, privacy settings, invitation restrictions, or platform limitations. Successful command acknowledgement does not guarantee WhatsApp accepted every individual group operation; partial failures are logged and reported.
