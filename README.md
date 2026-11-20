# Brain Desk

A desktop app for outreach follow-ups and inbound triage, built on the
`canaan-brain` Obsidian vault. The vault stays the only copy of the data:
Brain Desk reads and edits the notes in `People/` and `Inbound/`, then commits
and pushes every change.

## Run it

```bash
cd ~/Desktop/brain-desk
npm install      # first time only
npm start
```

On first launch, connect your vault (`~/Desktop/canaan-brain`). Tick
**Open at login** in the sidebar to keep it running. Closing the window keeps
the app running in the dock, so the Chrome button keeps working. Quit with ⌘Q.

## What it does

- **Today**: follow-ups due, people waiting on your reply, drafts you haven't
  sent, new inbound, and recent activity.
- **Follow-ups**: a person's outreach log, next nudge and cadence.
  **Draft** asks Claude, using your Claude Code login and the `derek-voice`
  skill, so no API key is needed. **Copy & open LinkedIn** saves the message as
  *Drafted, not sent*. Confirm with the Chrome button once you've sent it.
- **Inbound**: a drag-and-drop board (New → Pursuing → Reached out → No reply,
  plus a collapsed Passed column). Passing on a company moves its note to
  `Inbound/Passed/` (the graveyard), and un-passing moves it back. Passed notes still
  count for duplicate checks, market tables and the deal sheet,
  plus a drawer per company for status, deal sheet, touches, and
  *Start outreach* to the founder. **Reach out on** sets a date for a company
  you're tracking for later (`reach_out_on`). It shows on Today once the date
  arrives, and clears when the company moves to *Reached out*.
- **Deal sheet**: companies queued for the next sheet (`deal_sheet: yes`), from
  both Inbound and Companies. They're grouped into live deals (raising) and
  market intel, and missing descriptions are flagged. Add a company from the
  picker, remove one, or re-share one that was already sent. Past sheets come
  from `Deal Sheets/`. Compiling the sheet is still the vault's R4 routine: ask
  Claude for a deal sheet.
- **Quick add** (`N`): add an inbound company (checked for duplicates across
  Inbound and Companies by name, aliases and website), add a person, or log a
  reply.
- **Search** (`⌘K`): people, inbound and companies.

**Met vs. not met.** People pages are only for people you've met. Outreach to
anyone else lives on an Inbound note: their company's (created as Pursuing if
missing), or `<Name> (Stealth)` for stealth founders, VCs, LPs and operators.
They show in Follow-ups like everyone else, marked *not met*. **We met → People
page** creates their page and moves the history onto it. If a meeting sync
already made the page, the button offers to move the history instead.

## Chrome button

One-time setup: go to `chrome://extensions`, turn on **Developer mode**, click
**Load unpacked**, choose `~/Desktop/brain-desk/extension`, then pin it.

- **On the LinkedIn profile of someone new**: **I want to reach out** creates
  their People page (follow-up due today) and adds their company to Inbound as
  *Pursuing*, or adds them to the team if the company is already in Inbound.
  It then opens the draft tab. **Already messaged** logs a message you've
  already sent instead.
- **The company box** suggests companies from your vault as you type. It shows
  what it matched (or *Did you mean …?* for a near-miss), so a typo can't
  quietly create an unlinked company. When you log a message to someone whose
  company is in Inbound, they're added to its Team as a `[[link]]` to their
  People page, with a touch line. The status moves to Reached out if it was New
  or Pursuing.
- **On the profile of someone already in the vault**, it opens on drafting and
  logging:
  - **Draft**: Claude drafts in your voice. **Copy & save draft** keeps it as
    *Drafted, not sent*.
  - **Mark as sent**: once you've sent it, this logs it and sets the next
    nudge. The company moves to *Reached out*.
  - **I sent one** / **They replied**: log a message written straight in
    LinkedIn, or log their reply.
- **On a company website or a LinkedIn company page**, it adds the company to
  Inbound as *New* or *Pursuing* (want to reach out). LinkedIn company pages
  default to Pursuing, and the website is read from the page. If the company is
  already in the vault, it adds a touch instead, and can move a *New* company
  to *Pursuing*.

The button talks to the app on `127.0.0.1:47817`, so Brain Desk has to be
running. Requests from ordinary web pages are refused.

## How it writes to the vault

Formats are documented in the vault's `VAULT_SCHEMA.md` → *Outreach*.

- Frontmatter edits change only the lines they touch, and follow the vault's
  quoting rule.
- Outreach goes in `## Outreach log` on the person's page. Inbound touches go
  in `## Touches`. A match in `Companies/` goes under
  `## Inbound history → ### Touches`.
- Git: changes are batched for a couple of seconds, then committed as
  `[file] …`, touching only the files the app changed. Then it pushes. Status
  is shown at the bottom of the sidebar.
- Drafts not yet sent and the activity feed are app state, kept in
  `~/Library/Application Support/Brain Desk/`. They are not in the vault.

## Tests

```bash
npm test               # every action against a throwaway vault copy + a local git remote
node test/server.js    # the Chrome-button endpoints
```

- **Edit** (company drawer): website, description, What it is, referred by,
  round fields, deck link, and themes (picked from the theme table in
  `VAULT_SCHEMA.md`).
- **Enrich** (company drawer): Claude looks the company up in Specter, or on the
  web if Specter has nothing, using your Claude login. It fills only blank
  fields (website, description, What it is, including the last round), adds
  matching themes, and adds founders to Team. It never overwrites what's there.
  Companies newly added from the Chrome button or Quick add are enriched
  automatically in the background, which takes about 30–40 seconds.

## Not built yet

- Picking up email replies from Outlook automatically.
- A packaged `.app` (it runs with `npm start` for now).
