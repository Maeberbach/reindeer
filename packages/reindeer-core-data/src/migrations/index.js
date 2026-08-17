/**
 * Transactional migrations. Append-only: never edit an applied migration,
 * add a new one. Both apps run the same core migrations so the shared
 * packages can assume an identical table shape.
 */

export const MIGRATIONS = [
  {
    id: 1,
    name: 'core_items',
    sql: `
    CREATE TABLE scopes (
      scope_id    TEXT PRIMARY KEY,
      scope_type  TEXT NOT NULL CHECK (scope_type IN ('inventory','estate')),
      name        TEXT NOT NULL,
      owner_name  TEXT DEFAULT '',
      created_at  TEXT NOT NULL
    );

    CREATE TABLE rooms (
      room_id    TEXT PRIMARY KEY,
      scope_id   TEXT NOT NULL REFERENCES scopes(scope_id) ON DELETE CASCADE,
      name       TEXT NOT NULL,
      is_custom  INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0
    );
    CREATE UNIQUE INDEX idx_rooms_scope_name ON rooms(scope_id, name);

    CREATE TABLE categories (
      category_id TEXT PRIMARY KEY,
      scope_id    TEXT NOT NULL REFERENCES scopes(scope_id) ON DELETE CASCADE,
      name        TEXT NOT NULL,
      is_custom   INTEGER NOT NULL DEFAULT 0,
      sort_order  INTEGER NOT NULL DEFAULT 0
    );
    CREATE UNIQUE INDEX idx_categories_scope_name ON categories(scope_id, name);

    CREATE TABLE items (
      item_id              TEXT PRIMARY KEY,
      scope_id             TEXT NOT NULL REFERENCES scopes(scope_id) ON DELETE CASCADE,
      origin_app           TEXT NOT NULL DEFAULT 'inventory',
      origin_item_id       TEXT,
      title                TEXT NOT NULL,
      category_id          TEXT REFERENCES categories(category_id) ON DELETE SET NULL,
      room_id              TEXT REFERENCES rooms(room_id) ON DELETE SET NULL,
      description          TEXT NOT NULL DEFAULT '',
      story                TEXT NOT NULL DEFAULT '',
      quantity             INTEGER NOT NULL DEFAULT 1 CHECK (quantity >= 1),
      condition            TEXT NOT NULL DEFAULT 'unknown',
      identifiers          TEXT NOT NULL DEFAULT '{}',
      value_estimate_cents INTEGER,
      value_basis          TEXT NOT NULL DEFAULT 'unknown',
      high_value_flag      INTEGER NOT NULL DEFAULT 0,
      ai_confidence        REAL,
      review_state         TEXT NOT NULL DEFAULT 'draft',
      print_state          TEXT NOT NULL DEFAULT 'unprinted',
      export_state         TEXT NOT NULL DEFAULT 'never',
      created_at           TEXT NOT NULL,
      updated_at           TEXT NOT NULL
    );
    CREATE INDEX idx_items_scope ON items(scope_id, review_state);
    CREATE INDEX idx_items_room ON items(scope_id, room_id);
    CREATE INDEX idx_items_category ON items(scope_id, category_id);

    CREATE TABLE item_photos (
      photo_id          TEXT PRIMARY KEY,
      item_id           TEXT NOT NULL REFERENCES items(item_id) ON DELETE CASCADE,
      scope_id          TEXT NOT NULL REFERENCES scopes(scope_id) ON DELETE CASCADE,
      role              TEXT NOT NULL DEFAULT 'primary',
      crop_bbox         TEXT,
      source_media_id   TEXT,
      source_frame_index INTEGER,
      file_name         TEXT NOT NULL,
      mime_type         TEXT NOT NULL DEFAULT 'image/jpeg',
      byte_size         INTEGER NOT NULL DEFAULT 0,
      sha256            TEXT,
      created_at        TEXT NOT NULL
    );
    CREATE INDEX idx_photos_item ON item_photos(item_id);

    CREATE TABLE recipient_hints (
      item_id        TEXT PRIMARY KEY REFERENCES items(item_id) ON DELETE CASCADE,
      scope_id       TEXT NOT NULL REFERENCES scopes(scope_id) ON DELETE CASCADE,
      recipient_name TEXT NOT NULL DEFAULT '',
      relationship   TEXT NOT NULL DEFAULT '',
      alternate_name TEXT NOT NULL DEFAULT '',
      owner_note     TEXT NOT NULL DEFAULT '',
      is_binding     INTEGER NOT NULL DEFAULT 0 CHECK (is_binding = 0),
      updated_at     TEXT NOT NULL
    );

    CREATE TABLE audit_log (
      seq        INTEGER PRIMARY KEY AUTOINCREMENT,
      scope_id   TEXT NOT NULL,
      actor_id   TEXT NOT NULL,
      action     TEXT NOT NULL,
      entity     TEXT NOT NULL,
      entity_id  TEXT,
      payload    TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      prev_hash  TEXT NOT NULL,
      hash       TEXT NOT NULL
    );
    CREATE INDEX idx_audit_scope ON audit_log(scope_id, seq);

    CREATE TABLE export_batches (
      batch_id    TEXT PRIMARY KEY,
      scope_id    TEXT NOT NULL REFERENCES scopes(scope_id) ON DELETE CASCADE,
      format      TEXT NOT NULL,
      item_count  INTEGER NOT NULL,
      file_name   TEXT NOT NULL,
      created_at  TEXT NOT NULL
    );

    CREATE TABLE duplicate_groups (
      group_id    TEXT PRIMARY KEY,
      scope_id    TEXT NOT NULL REFERENCES scopes(scope_id) ON DELETE CASCADE,
      reason      TEXT NOT NULL,
      score       REAL NOT NULL DEFAULT 0,
      state       TEXT NOT NULL DEFAULT 'open',
      created_at  TEXT NOT NULL
    );

    CREATE TABLE duplicate_members (
      group_id TEXT NOT NULL REFERENCES duplicate_groups(group_id) ON DELETE CASCADE,
      item_id  TEXT NOT NULL REFERENCES items(item_id) ON DELETE CASCADE,
      side     TEXT NOT NULL DEFAULT 'candidate',
      PRIMARY KEY (group_id, item_id)
    );
    `,
  },
  {
    id: 2,
    name: 'intake_queue',
    sql: `
    -- Landing zone for anything arriving from outside the app, including
    -- ReindeerExchange imports. Nothing enters a live game directly.
    CREATE TABLE intake_queue (
      intake_id     TEXT PRIMARY KEY,
      scope_id      TEXT NOT NULL REFERENCES scopes(scope_id) ON DELETE CASCADE,
      source        TEXT NOT NULL,
      source_batch  TEXT,
      item_id       TEXT REFERENCES items(item_id) ON DELETE CASCADE,
      payload       TEXT NOT NULL DEFAULT '{}',
      state         TEXT NOT NULL DEFAULT 'pending',
      note          TEXT NOT NULL DEFAULT '',
      created_at    TEXT NOT NULL,
      resolved_at   TEXT
    );
    CREATE INDEX idx_intake_scope_state ON intake_queue(scope_id, state);

    -- Fair round locking: set when a division has begun.
    ALTER TABLE scopes ADD COLUMN round_locked INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    id: 3,
    name: 'video_voice_and_trustee_delivery',
    sql: `
    -- item_photos becomes the general media table. Photos stay the default so
    -- nothing already written has to change.
    ALTER TABLE item_photos ADD COLUMN media_kind TEXT NOT NULL DEFAULT 'photo';
    ALTER TABLE item_photos ADD COLUMN duration_ms INTEGER;
    ALTER TABLE item_photos ADD COLUMN transcript TEXT NOT NULL DEFAULT '';
    ALTER TABLE item_photos ADD COLUMN transcript_source TEXT;
    ALTER TABLE item_photos ADD COLUMN label TEXT NOT NULL DEFAULT '';
    ALTER TABLE item_photos ADD COLUMN retain_original INTEGER NOT NULL DEFAULT 1;
    CREATE INDEX idx_photos_kind ON item_photos(item_id, media_kind);

    -- Scope-level recordings that belong to the whole inventory rather than to
    -- one object: a walkthrough video, an opening statement, a message to the family.
    CREATE TABLE scope_media (
      media_id     TEXT PRIMARY KEY,
      scope_id     TEXT NOT NULL REFERENCES scopes(scope_id) ON DELETE CASCADE,
      media_kind   TEXT NOT NULL,
      title        TEXT NOT NULL DEFAULT '',
      file_name    TEXT NOT NULL,
      mime_type    TEXT NOT NULL,
      byte_size    INTEGER NOT NULL DEFAULT 0,
      duration_ms  INTEGER,
      transcript   TEXT NOT NULL DEFAULT '',
      sha256       TEXT,
      created_at   TEXT NOT NULL
    );
    CREATE INDEX idx_scope_media ON scope_media(scope_id, media_kind);

    -- Who receives the finished package.
    CREATE TABLE trustees (
      trustee_id   TEXT PRIMARY KEY,
      scope_id     TEXT NOT NULL REFERENCES scopes(scope_id) ON DELETE CASCADE,
      name         TEXT NOT NULL,
      email        TEXT NOT NULL,
      role         TEXT NOT NULL DEFAULT 'trustee',
      is_primary   INTEGER NOT NULL DEFAULT 0,
      note         TEXT NOT NULL DEFAULT '',
      created_at   TEXT NOT NULL
    );
    CREATE INDEX idx_trustees_scope ON trustees(scope_id);

    -- Every package that ever left the app, and what happened to it.
    CREATE TABLE deliveries (
      delivery_id     TEXT PRIMARY KEY,
      scope_id        TEXT NOT NULL REFERENCES scopes(scope_id) ON DELETE CASCADE,
      batch_id        TEXT,
      method          TEXT NOT NULL,            -- email_attachment | email_link | download
      state           TEXT NOT NULL DEFAULT 'prepared',  -- prepared | sent | failed | downloaded
      recipients      TEXT NOT NULL DEFAULT '[]',
      item_count      INTEGER NOT NULL DEFAULT 0,
      photo_count     INTEGER NOT NULL DEFAULT 0,
      video_count     INTEGER NOT NULL DEFAULT 0,
      audio_count     INTEGER NOT NULL DEFAULT 0,
      byte_size       INTEGER NOT NULL DEFAULT 0,
      file_name       TEXT NOT NULL DEFAULT '',
      bundle_sha256   TEXT,
      link_token      TEXT,
      link_expires_at TEXT,
      error           TEXT NOT NULL DEFAULT '',
      created_at      TEXT NOT NULL,
      sent_at         TEXT
    );
    CREATE INDEX idx_deliveries_scope ON deliveries(scope_id, created_at);
    CREATE UNIQUE INDEX idx_deliveries_token ON deliveries(link_token) WHERE link_token IS NOT NULL;
    `,
  },
  {
    id: 4,
    name: 'scope_people',
    /*
     * The people an owner has in mind.
     *
     * Until now a recipient was typed free-hand into every item, which meant
     * "Kathy", "Kathy M", "my daughter Kathy" and "Katherine" became four
     * different heirs in the eventual export, and the owner had to spell the
     * same name out fifty times. This is a roster instead: named once, chosen
     * by tapping thereafter.
     *
     * Purely additive — a new table only. No existing table, column or index
     * is altered, so Reindeer: FairPlay, which reads the same core tables
     * through Drizzle, is untouched by it. There is deliberately no reference
     * to FairPlay's `participants`: this is the owner's private address
     * book, not a party to a distribution, and a name here confers nothing.
     */
    sql: `
    CREATE TABLE scope_people (
      person_id    TEXT PRIMARY KEY,
      scope_id     TEXT NOT NULL REFERENCES scopes(scope_id) ON DELETE CASCADE,
      name         TEXT NOT NULL,
      relationship TEXT NOT NULL DEFAULT '',
      note         TEXT NOT NULL DEFAULT '',
      source       TEXT NOT NULL DEFAULT 'typed' CHECK (source IN ('typed','from_item')),
      archived     INTEGER NOT NULL DEFAULT 0,
      sort_order   INTEGER NOT NULL DEFAULT 0,
      created_at   TEXT NOT NULL,
      updated_at   TEXT NOT NULL
    );
    CREATE INDEX idx_people_scope ON scope_people(scope_id, archived, sort_order);
    -- Case-insensitive: "Kathy" and "kathy" are one person, not two heirs.
    CREATE UNIQUE INDEX idx_people_scope_name ON scope_people(scope_id, name COLLATE NOCASE);
    `,
  },
  {
    id: 5,
    name: 'room_walkthrough',
    /*
     * Where the owner is in the house.
     *
     * The app used to be organised around the item: photograph a thing, name a
     * thing, repeat, and the owner had to hold in their head which parts of the
     * house they had already been through. That is the wrong unit of work for a
     * walk around a home, and it is a poor thing to ask of someone who will do
     * this over several days with interruptions. The room is the unit: enter it,
     * record it, mark it done, move on.
     *
     * `walkthrough_state` is deliberately coarse. "started" exists so a room the
     * owner is midway through is visibly different from one never opened, which
     * is what makes an honest "here is what is left" reminder possible after a
     * pause of any length.
     *
     * `documented_at` records that the room was captured at all, separately from
     * whether anything in it has been named. Those come apart by design now:
     * a recording made with no internet is documentation the moment it is taken,
     * and the AI naming pass may not happen until days later at an office. A
     * room can therefore be legitimately complete and still hold nothing but a
     * video, and the app must not nag about it as though it were unfinished.
     *
     * Purely additive: three nullable/defaulted columns on an existing table and
     * one index. No column is dropped, renamed or retyped, so an inventory.db
     * written by this build stays readable by every existing query, and Reindeer:
     * FairPlay never reads `rooms` at all.
     */
    sql: `
    ALTER TABLE rooms ADD COLUMN walkthrough_state TEXT NOT NULL DEFAULT 'not_started'
      CHECK (walkthrough_state IN ('not_started','started','done','skipped'));
    ALTER TABLE rooms ADD COLUMN documented_at TEXT;
    ALTER TABLE rooms ADD COLUMN completed_at TEXT;
    CREATE INDEX idx_rooms_walkthrough ON rooms(scope_id, walkthrough_state);
    `,
  },
  {
    id: 6,
    name: 'scope_defaults_version',
    /*
     * Lets the seeded room list grow without resurrecting deleted rooms.
     *
     * The starter rooms are only planted when a scope is first created, so an
     * inventory made before a room was added to DEFAULT_ROOMS would never see
     * it. Topping up on every boot would fix that and introduce a worse bug:
     * a room the owner deliberately deleted would silently come back, over and
     * over. This column records which generation of the defaults a scope has
     * already been offered. The top-up inserts what is missing, once, and then
     * never touches that scope again.
     *
     * Additive: one defaulted column. Existing rows read as 0, which is
     * correct — they predate the current list and are owed the top-up.
     */
    sql: `
    ALTER TABLE scopes ADD COLUMN defaults_version INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    id: 7,
    name: 'owner_important_flag',
    /*
     * The owner's own "this matters" mark on an item, and their own reason
     * for it if they cared to say.
     *
     * Distinct on purpose from `items.high_value_flag`, which is FairPlay's
     * computed field set from its AI value estimate against the personal
     * representative's threshold. Registry never sets that; it sets this.
     *
     * Reason is one of four strings: '' (flagged with no stated reason),
     * 'feeling', 'money', 'both'. Enforced in the API validator rather than a
     * CHECK constraint, so the same ambiguity can survive a re-import from a
     * future build that adds more reasons — the older row simply loses the
     * new reason word, which is a safer failure than a migration refusing
     * to open the file at all.
     *
     * Purely additive — two defaulted columns. Existing rows read as "not
     * flagged, no reason", which is exactly right for inventories captured
     * before the option existed.
     */
    sql: `
    ALTER TABLE items ADD COLUMN owner_high_value INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE items ADD COLUMN owner_high_value_reason TEXT NOT NULL DEFAULT '';
    CREATE INDEX idx_items_owner_high_value ON items(scope_id, owner_high_value);
    `,
  },
  {
    id: 8,
    name: 'owner_important_comment',
    /*
     * The owner's own note on an item they flagged as Important. Free text,
     * content, kept for the heirs and the trustee. The owner author
     * anything they want in here — a story, a maker, a memory, a dollar
     * figure if they choose. Registry does not shape the owner's own words;
     * FairPlay does its own appraisal work separately.
     *
     * Length cap (500 chars) is enforced in the API validator, not with a
     * CHECK constraint here, so a future longer cap can be raised without a
     * migration surgery. Trimmed empty text stores as ''.
     *
     * Coupling with owner_high_value is asymmetric and lives in the
     * validator (see docs/decisions/2026-08-06-important-comment.md):
     *   - non-empty comment forces owner_high_value = true (auto-flag)
     *   - owner_high_value = false forces comment = '' (clear-on-unflag)
     *   - deleting a comment does NOT unflag; the flag persists once set.
     *
     * Purely additive. Existing rows read as "no comment", which is exactly
     * right for inventories captured before the option existed.
     */
    sql: `
    ALTER TABLE items ADD COLUMN owner_important_comment TEXT NOT NULL DEFAULT '';
    `,
  },
  {
    id: 9,
    name: 'two_output_delivery',
    /*
     * Foundation for the Two-Output Delivery Model
     * (docs/specs/2026-08-09-registry-two-outputs.md).
     *
     * Registry has two legal outputs, not one:
     *   1. Household inventory (trustee, at death, one per household)
     *   2. Specific-giving addendum (wills-storage caretaker + trustee,
     *      every signing, one per spouse in Couple mode)
     *
     * This migration adds the shape needed to represent both. It does NOT
     * change any existing behavior — every new column is nullable or has a
     * safe default, and no existing code reads these yet. UI, delivery,
     * signing flow, and print output all follow in later commits.
     *
     * Migration policy for existing data is B ("clean slate"): existing
     * signed Registry deliveries are NOT retroactively promoted to
     * addendum v1. Every existing item quietly enters the household
     * inventory (nothing changes for the owner). If an item later gets an
     * heir assignment and a close-up, it becomes eligible for the addendum
     * at the NEXT owner-initiated signing event.
     */
    sql: `
    -- Nullable heir assignment. NULL = no specific heir named; item is in
    -- inventory only. When set, item is a candidate for the addendum.
    ALTER TABLE items ADD COLUMN assigned_to_heir_id TEXT;
    CREATE INDEX idx_items_assigned_heir ON items(scope_id, assigned_to_heir_id);

    -- Nullable pointer to the owner-taken close-up photo for this assigned
    -- item. Enforced to be non-null before addendum signing, but nullable at
    -- rest so an owner can add the assignment first and take the photo
    -- later. The referenced row must be a photo the owner captured
    -- (source restricted to owner_camera on the envelope side).
    ALTER TABLE items ADD COLUMN closeup_photo_id TEXT REFERENCES item_photos(photo_id) ON DELETE SET NULL;

    -- Heirs the owner has named. Distinct from FairPlay's participants
    -- table (which lives in the FC app db). A Registry heir is just the
    -- person the owner wants to receive an item; they don't need an
    -- account. Email is optional — many owners will name people the app
    -- can't reach directly ("my grandson Ben").
    CREATE TABLE heirs (
      heir_id      TEXT PRIMARY KEY,
      scope_id     TEXT NOT NULL REFERENCES scopes(scope_id) ON DELETE CASCADE,
      name         TEXT NOT NULL,
      relationship TEXT NOT NULL DEFAULT '',
      email        TEXT NOT NULL DEFAULT '',
      notes        TEXT NOT NULL DEFAULT '',
      created_at   TEXT NOT NULL,
      updated_at   TEXT NOT NULL
    );
    CREATE INDEX idx_heirs_scope ON heirs(scope_id);

    -- The person or firm holding the will. Attorney, family member, or
    -- "nobody yet" (that last case surfaced on the signing screen as a
    -- warning per the spec). Registry needs this because the whole point
    -- of the addendum is that it lands in the same file as the will.
    CREATE TABLE wills_caretakers (
      caretaker_id     TEXT PRIMARY KEY,
      scope_id         TEXT NOT NULL REFERENCES scopes(scope_id) ON DELETE CASCADE,
      name             TEXT NOT NULL,
      firm             TEXT NOT NULL DEFAULT '',
      email            TEXT NOT NULL DEFAULT '',
      phone            TEXT NOT NULL DEFAULT '',
      delivery_method  TEXT NOT NULL DEFAULT 'email' CHECK (delivery_method IN ('email','signed_link','print_mail')),
      notes            TEXT NOT NULL DEFAULT '',
      created_at       TEXT NOT NULL,
      updated_at       TEXT NOT NULL
    );
    CREATE INDEX idx_wills_caretakers_scope ON wills_caretakers(scope_id);

    -- Historical record of every signed addendum. New row per signing.
    -- Each row is a complete, immutable snapshot of the items block, the
    -- recipients, the voice message (if any), and the signature evidence.
    -- Superseded rows stay so the caretaker's file history is auditable
    -- and so we can show the owner "you last updated this on ...".
    --
    -- owner_participant_id is a free-form string on the Registry side
    -- because Registry has no formal participant table today; in Couple
    -- mode this will hold the spouse's owner_id. In single-owner Registry
    -- it defaults to '' and the row still uniquely lives inside the scope.
    CREATE TABLE addendum_versions (
      version_id            TEXT PRIMARY KEY,
      scope_id              TEXT NOT NULL REFERENCES scopes(scope_id) ON DELETE CASCADE,
      owner_participant_id  TEXT NOT NULL DEFAULT '',
      version_number        INTEGER NOT NULL CHECK (version_number >= 1),
      supersedes_version    INTEGER,
      signed_at             TEXT NOT NULL,
      signature_evidence    TEXT NOT NULL DEFAULT '{}',
      recipients            TEXT NOT NULL DEFAULT '[]',
      voice_message         TEXT,
      items_snapshot        TEXT NOT NULL DEFAULT '[]',
      gaps                  TEXT NOT NULL DEFAULT '[]',
      envelope_sha256       TEXT NOT NULL DEFAULT '',
      created_at            TEXT NOT NULL
    );
    CREATE UNIQUE INDEX idx_addendum_versions_owner_ver
      ON addendum_versions(scope_id, owner_participant_id, version_number);
    CREATE INDEX idx_addendum_versions_scope
      ON addendum_versions(scope_id, signed_at DESC);
    `,
  },
  {
    id: 10,
    name: 'addendum_bundle_path',
    // Commit 2 of the Two-Output Delivery Model.
    //
    // Migration 9 recorded the signed envelope's SHA-256 but not where the
    // .addendum bundle file itself was written on disk. Without that path,
    // the app can only re-download the bundle if the DeliveryService's
    // storage layout is guessed — fragile. Store the absolute path the
    // service wrote to at signing time so a later download is a lookup, not
    // a filesystem search.
    //
    // Nullable so a signing that failed halfway through writing the bundle
    // still leaves an auditable row rather than nothing at all.
    sql: `
      ALTER TABLE addendum_versions ADD COLUMN bundle_path TEXT;
    `,
  },
  {
    id: 11,
    name: 'heirs_recipient_type',
    // Commit 3 of the Two-Output Delivery Model \u2014 UI is coming, and the
    // roster needs to distinguish two kinds of named person the addendum can
    // gift items to.
    //
    // A Georgia (and most-states) memorandum of tangible personal property
    // can name any identifiable recipient, not only will heirs. Owners want
    // to leave the walnut side table to a close friend, the piano to their
    // church, an antique doll to a caregiver. Modelling all named recipients
    // as "heirs" would be technically fine but semantically wrong \u2014 a
    // friend is not an heir. It also matters downstream: FairPlay runs
    // its distribution game across heirs only; a friend receiving one item
    // by name does not go into the game.
    //
    // Additive: existing rows default to 'heir', matching prior behavior.
    // Value set is closed by a CHECK so a future misspelling in code cannot
    // silently write a third kind.
    sql: `
      ALTER TABLE heirs ADD COLUMN recipient_type TEXT NOT NULL DEFAULT 'heir'
        CHECK (recipient_type IN ('heir', 'named_recipient'));
    `,
  },
  {
    id: 12,
    name: 'addendum_versions_frozen_at',
    // Commit 4 \u2014 death-at-Registry lifecycle.
    //
    // A memorandum becomes an operative legal instrument at signing.
    // Registry is a preparation tool \u2014 the paper the owner hands the
    // trustee is what actually governs. On the owner's death, no further
    // signings should amend the memorandum in Registry: what the trustee
    // holds on paper is now the record. This column marks the moment
    // Registry acknowledges that finality.
    //
    // Nullable: prior signings and living owners have no frozen_at. Once
    // set, downstream code (export to FairPlay, further signings)
    // treats the row as immutable.
    //
    // A separate row also captures who marked the owner deceased and
    // when \u2014 the trustee is the accountable party; Registry cannot
    // know a death without being told.
    sql: `
      ALTER TABLE addendum_versions ADD COLUMN frozen_at TEXT;
      ALTER TABLE addendum_versions ADD COLUMN frozen_by_participant_id TEXT;
      ALTER TABLE addendum_versions ADD COLUMN frozen_note TEXT NOT NULL DEFAULT '';
    `,
  },
  {
    id: 13,
    name: 'couple_and_claims',
    // Couple Mode \u2014 two devices, two accounts, one household.
    //
    // The household inventory itself is joint (no owner column on items).
    // Per-spouse concepts express themselves as **claims** on shared items:
    //   - a memorandum tag  ("I want this to go to Sarah on my memorandum")
    //   - an Important flag ("this one matters, trustee please notice")
    // Both claim kinds ride the same state machine so the couple can review
    // them together and reach a uniform decision before either spouse dies.
    //
    // Solo mode is unchanged. household_mode defaults to 'solo' and the two
    // claim tables stay empty; the existing item.owner_high_value flag and
    // item.assigned_to_heir_id behavior are untouched by this migration.
    //
    // The one exception on inventory items is titled property (cars, boats,
    // shares of an LLC) \u2014 those are legally handled by whoever holds the
    // title, not by a memorandum. A boolean flag lets the printed trustee
    // report list them under a distinct heading. The flag does not change
    // any addendum logic.
    sql: `
      ALTER TABLE scopes ADD COLUMN household_mode TEXT NOT NULL DEFAULT 'solo'
        CHECK (household_mode IN ('solo', 'couple', 'survivor'));
      ALTER TABLE scopes ADD COLUMN linked_household_id TEXT;
      ALTER TABLE scopes ADD COLUMN linked_at TEXT;
      ALTER TABLE scopes ADD COLUMN linked_by_participant_id TEXT;

      ALTER TABLE scope_people ADD COLUMN role TEXT NOT NULL DEFAULT 'heir'
        CHECK (role IN ('owner', 'heir', 'named_recipient', 'trustee'));
      ALTER TABLE scope_people ADD COLUMN household_role TEXT
        CHECK (household_role IS NULL OR household_role IN ('primary', 'partner'));
      ALTER TABLE scope_people ADD COLUMN email TEXT NOT NULL DEFAULT '';
      ALTER TABLE scope_people ADD COLUMN account_status TEXT NOT NULL DEFAULT 'active'
        CHECK (account_status IN ('active', 'invited', 'declined', 'deceased'));

      ALTER TABLE items ADD COLUMN is_titled_property INTEGER NOT NULL DEFAULT 0
        CHECK (is_titled_property IN (0, 1));

      CREATE TABLE memorandum_claims (
        claim_id                       TEXT PRIMARY KEY,
        scope_id                       TEXT NOT NULL REFERENCES scopes(scope_id) ON DELETE CASCADE,
        item_id                        TEXT NOT NULL REFERENCES items(item_id) ON DELETE CASCADE,
        tagged_by_participant_id       TEXT NOT NULL,
        tagged_at                      TEXT NOT NULL,
        proposed_heir_id               TEXT NOT NULL,
        final_owner_participant_id     TEXT NOT NULL,
        final_heir_id                  TEXT NOT NULL,
        status                         TEXT NOT NULL DEFAULT 'proposed'
          CHECK (status IN ('proposed', 'agreed', 'contested', 'withdrawn')),
        agreed_by_participant_id       TEXT,
        agreed_at                      TEXT,
        contested_by_participant_id    TEXT,
        contested_reason               TEXT NOT NULL DEFAULT '',
        contested_at                   TEXT,
        created_at                     TEXT NOT NULL,
        updated_at                     TEXT NOT NULL
      );
      CREATE INDEX idx_memorandum_claims_scope_item ON memorandum_claims(scope_id, item_id);
      CREATE INDEX idx_memorandum_claims_owner_status ON memorandum_claims(scope_id, final_owner_participant_id, status);

      CREATE TABLE importance_claims (
        claim_id                       TEXT PRIMARY KEY,
        scope_id                       TEXT NOT NULL REFERENCES scopes(scope_id) ON DELETE CASCADE,
        item_id                        TEXT NOT NULL REFERENCES items(item_id) ON DELETE CASCADE,
        proposed_by_participant_id     TEXT NOT NULL,
        proposed_reason                TEXT NOT NULL DEFAULT '',
        status                         TEXT NOT NULL DEFAULT 'proposed'
          CHECK (status IN ('proposed', 'agreed', 'declined', 'withdrawn')),
        agreed_by_participant_id       TEXT,
        agreed_at                      TEXT,
        declined_by_participant_id     TEXT,
        declined_reason                TEXT NOT NULL DEFAULT '',
        declined_at                    TEXT,
        created_at                     TEXT NOT NULL,
        updated_at                     TEXT NOT NULL
      );
      CREATE INDEX idx_importance_claims_scope_item ON importance_claims(scope_id, item_id);
      CREATE INDEX idx_importance_claims_scope_status ON importance_claims(scope_id, status);
    `,
  },
  {
    id: 14,
    name: 'auth_sessions_and_magic_links',
    // Session-based authentication.
    //
    // Two tables:
    //   participants  \u2014 the people who can sign in to this Registry.
    //                    One row per email; a participant maps to a scope_people
    //                    row via participant_person_id when the person also plays
    //                    the owner role on the household.
    //   magic_links   \u2014 single-use, 20-minute email links that mint a session.
    //   sessions      \u2014 30-day sliding window; opaque token stored in an
    //                    httpOnly signed cookie.
    //
    // Solo mode compatibility: routes read participant id from req.session and
    // fall back to a bootstrap-owner mode when no participant exists yet. Once
    // a second participant is added, the shortcut self-disables.
    sql: `
      CREATE TABLE participants (
        participant_id     TEXT PRIMARY KEY,
        email              TEXT NOT NULL UNIQUE,
        display_name       TEXT NOT NULL DEFAULT '',
        role               TEXT NOT NULL DEFAULT 'owner'
          CHECK (role IN ('owner', 'partner', 'trustee', 'invited')),
        status             TEXT NOT NULL DEFAULT 'active'
          CHECK (status IN ('active', 'invited', 'declined', 'deceased', 'disabled')),
        household_scope_id TEXT,
        created_at         TEXT NOT NULL,
        updated_at         TEXT NOT NULL,
        last_seen_at       TEXT
      );
      CREATE INDEX idx_participants_scope ON participants(household_scope_id);

      CREATE TABLE magic_links (
        token_hash    TEXT PRIMARY KEY,
        email         TEXT NOT NULL,
        purpose       TEXT NOT NULL DEFAULT 'signin'
          CHECK (purpose IN ('signin', 'invite')),
        issued_at     TEXT NOT NULL,
        expires_at    TEXT NOT NULL,
        consumed_at   TEXT,
        invite_scope_id TEXT,
        invite_role   TEXT
          CHECK (invite_role IS NULL OR invite_role IN ('owner', 'partner', 'trustee'))
      );
      CREATE INDEX idx_magic_links_email ON magic_links(email);

      CREATE TABLE sessions (
        session_id     TEXT PRIMARY KEY,
        token_hash     TEXT NOT NULL UNIQUE,
        participant_id TEXT NOT NULL REFERENCES participants(participant_id) ON DELETE CASCADE,
        created_at     TEXT NOT NULL,
        last_used_at   TEXT NOT NULL,
        expires_at     TEXT NOT NULL,
        user_agent     TEXT NOT NULL DEFAULT '',
        signed_out_at  TEXT
      );
      CREATE INDEX idx_sessions_participant ON sessions(participant_id);
      CREATE INDEX idx_sessions_expires ON sessions(expires_at);
    `,
  },
  {
    id: 15,
    name: 'drop_claim_tables',
    // Slice A of the couple-mode rebuild.
    //
    // Migration 13 introduced importance_claims and memorandum_claims to model
    // a proposed/agreed workflow for couple decisions. Real-world use showed
    // the workflow is wrong: couples agree in real time when they sit
    // together and either records the outcome. There is no proposal queue.
    //
    // We keep the item-level owner_high_value flag (Important) and the
    // item-level assigned_to_heir_id (household's stated destination),
    // both editable by either linked partner. Conflict resolution moves to
    // the per-partner memorandum layer in Slice B.
    //
    // Bundle wire format is unaffected: the two claim tables were UI/API
    // only and never appeared in exported bundles. Signed versions on disk
    // remain valid.
    sql: `
      DROP INDEX IF EXISTS idx_importance_claims_scope_item;
      DROP INDEX IF EXISTS idx_importance_claims_scope_status;
      DROP TABLE IF EXISTS importance_claims;

      DROP INDEX IF EXISTS idx_memorandum_claims_scope_item;
      DROP INDEX IF EXISTS idx_memorandum_claims_owner_status;
      DROP TABLE IF EXISTS memorandum_claims;
    `,
  },
  {
    id: 16,
    name: 'memorandum_entries_and_signings',
    // Slice B of the couple-mode rebuild.
    //
    // Per-partner memorandums. Each partner in a couple (and every solo
    // owner) writes their own list of who-gets-what and signs it. Editing
    // after signing starts a new version; the prior signed version stays on
    // record so a lost paper copy can be reprinted.
    //
    // Two tables:
    //
    //   memorandum_entries
    //     One row per (scope, participant, version, item). Draft rows have
    //     is_signed=0 and a version number equal to the next-to-be-signed
    //     version for that participant. Signed rows are frozen: their
    //     is_signed flips to 1 at sign time and the version is
    //     locked. A partner can hold at most one draft version at a time
    //     (enforced by the repo layer, which refuses to open a new draft
    //     while another is unsigned).
    //
    //     assigned_to_heir_id may be NULL: a partner can list an item on
    //     their memorandum with no recipient chosen yet. The trustee then
    //     handles it as unassigned. Note is optional free text explaining
    //     the gift ("for Sarah because she loved playing it as a kid") and
    //     is distinct from items.owner_important_comment (which is about
    //     the object itself, not about the gift).
    //
    //   memorandum_signings
    //     One row per sign event. Records the frozen entries snapshot as
    //     JSON (so trustee-side rendering does not depend on the live
    //     entries table), the number of conflicts detected at sign time,
    //     and which participant signed. A new draft memorandum becomes
    //     printable-and-official when a row is inserted here.
    //
    // Conflict detection is not stored: it is derived by SQL at read time
    // by comparing each partner's latest version (draft-or-signed) against
    // the other partner's latest.
    sql: `
      CREATE TABLE memorandum_entries (
        entry_id                TEXT PRIMARY KEY,
        scope_id                TEXT NOT NULL,
        participant_id          TEXT NOT NULL,
        version                 INTEGER NOT NULL,
        item_id                 TEXT NOT NULL,
        assigned_to_heir_id     TEXT,
        note                    TEXT,
        is_signed               INTEGER NOT NULL DEFAULT 0,
        created_at              TEXT NOT NULL,
        updated_at              TEXT NOT NULL,
        UNIQUE (scope_id, participant_id, version, item_id)
      );
      CREATE INDEX idx_memorandum_entries_scope_partner
        ON memorandum_entries (scope_id, participant_id);
      CREATE INDEX idx_memorandum_entries_scope_item
        ON memorandum_entries (scope_id, item_id);

      CREATE TABLE memorandum_signings (
        signing_id              TEXT PRIMARY KEY,
        scope_id                TEXT NOT NULL,
        participant_id          TEXT NOT NULL,
        version                 INTEGER NOT NULL,
        entries_snapshot        TEXT NOT NULL,
        signed_at               TEXT NOT NULL,
        conflict_count_at_sign  INTEGER NOT NULL DEFAULT 0,
        UNIQUE (scope_id, participant_id, version)
      );
      CREATE INDEX idx_memorandum_signings_scope_partner
        ON memorandum_signings (scope_id, participant_id);
    `,
  },
  {
    id: 17,
    name: 'reminder_prefs',
    // A single row per (scope, participant) captures which holidays the
    // owner wants a nudge for. holidays_json is a small JSON array of
    // holiday keys drawn from a fixed vocabulary the client renders as
    // checkboxes (see /api/reminders/holidays). The Registry itself never
    // sends email \u2014 a Perplexity Computer scheduled task reads this
    // table and dispatches the actual reminders. Kept scope-scoped so a
    // partner and owner on the same scope can each have their own list.
    sql: `
      CREATE TABLE reminder_prefs (
        scope_id       TEXT NOT NULL,
        participant_id TEXT NOT NULL,
        holidays_json  TEXT NOT NULL DEFAULT '[]',
        updated_at     TEXT NOT NULL,
        PRIMARY KEY (scope_id, participant_id)
      );
    `,
  },
  {
    id: 18,
    name: 'assignment_conflict',
    // When two participants in a household assign the same item to different
    // heirs, the item is flagged so both can see the disagreement. The flag
    // does not block either assignment — last write wins on
    // assigned_to_heir_id, and the trustee resolves the conflict later.
    // The audit log retains the full per-participant history.
    sql: `
      ALTER TABLE items ADD COLUMN assignment_conflict INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    id: 19,
    name: 'participants_assistant_role',
    // Add 'assistant' and 'invited-assistant' to the participants role CHECK
    // and 'assistant' to magic_links.invite_role CHECK. SQLite cannot ALTER
    // a CHECK constraint, so we recreate both tables and copy data over.
    sql: `
      -- Participants: recreate with expanded role CHECK
      CREATE TABLE participants_new (
        participant_id     TEXT PRIMARY KEY,
        email              TEXT NOT NULL UNIQUE,
        display_name       TEXT NOT NULL DEFAULT '',
        role               TEXT NOT NULL DEFAULT 'owner'
          CHECK (role IN ('owner', 'partner', 'trustee', 'invited', 'assistant', 'invited-assistant')),
        status             TEXT NOT NULL DEFAULT 'active'
          CHECK (status IN ('active', 'invited', 'declined', 'deceased', 'disabled')),
        household_scope_id TEXT,
        created_at         TEXT NOT NULL,
        updated_at         TEXT NOT NULL,
        last_seen_at       TEXT
      );
      INSERT INTO participants_new
        SELECT * FROM participants;
      DROP TABLE participants;
      ALTER TABLE participants_new RENAME TO participants;
      CREATE INDEX IF NOT EXISTS idx_participants_scope ON participants(household_scope_id);

      -- Magic links: recreate with expanded invite_role CHECK
      CREATE TABLE magic_links_new (
        token_hash    TEXT PRIMARY KEY,
        email         TEXT NOT NULL,
        purpose       TEXT NOT NULL DEFAULT 'signin'
          CHECK (purpose IN ('signin', 'invite')),
        issued_at     TEXT NOT NULL,
        expires_at    TEXT NOT NULL,
        consumed_at   TEXT,
        invite_scope_id TEXT,
        invite_role   TEXT
          CHECK (invite_role IS NULL OR invite_role IN ('owner', 'partner', 'trustee', 'assistant'))
      );
      INSERT INTO magic_links_new
        SELECT * FROM magic_links;
      DROP TABLE magic_links;
      ALTER TABLE magic_links_new RENAME TO magic_links;
    `,
  },
  {
    id: 20,
    name: 'password_hash_and_license_keys',
    sql: `
    -- Password hash column on participants (for future username/password login)
    -- Toggle controlled by FEATURE_FLAGS.passwordLogin (currently OFF)
    ALTER TABLE participants ADD COLUMN password_hash TEXT DEFAULT NULL;

    -- License key storage (for future billing enforcement)
    -- Toggle controlled by FEATURE_FLAGS.licenseKeys (currently OFF)
    CREATE TABLE IF NOT EXISTS license_keys (
      key_id          TEXT PRIMARY KEY,
      product         TEXT NOT NULL CHECK (product IN ('reindeer-registry', 'reindeer-fair-play', 'reindeer-bundle')),
      customer_email  TEXT NOT NULL,
      subscription_id TEXT,
      stripe_customer_id TEXT,
      jwt_token       TEXT NOT NULL,
      issued_at       TEXT NOT NULL,
      expires_at      TEXT,
      status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'lapsed', 'revoked')),
      last_validated  TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_license_keys_email ON license_keys(customer_email);
    CREATE INDEX IF NOT EXISTS idx_license_keys_product ON license_keys(product);
    `,
  },
  {
    id: 21,
    name: 'memorandum_entry_important_flag',
    sql: `
    -- Per-partner "this item is important" mark on memorandum entries.
    -- When BOTH partners mark the same item as important AND assign it,
    -- the conflict detection picks it up for resolution.
    ALTER TABLE memorandum_entries ADD COLUMN is_important INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    id: 22,
    name: 'item_ownership_tag',
    sql: `
    -- Per-item ownership tag: mine (owner), theirs (partner), ours (joint).
    -- Guides whose memorandum the item belongs in for assignment.
    -- Can be switched during reconciliation.
    ALTER TABLE items ADD COLUMN ownership_tag TEXT NOT NULL DEFAULT 'mine'
      CHECK (ownership_tag IN ('mine', 'theirs', 'ours'));
    `,
  },
  {
    id: 23,
    name: 'user_email_settings',
    sql: `
    -- Per-user SMTP email configuration.
    -- Stored in the database so users can configure their own email
    -- service through the app UI without server-level env vars.
    CREATE TABLE IF NOT EXISTS email_settings (
      key         TEXT PRIMARY KEY DEFAULT 'default',
      host        TEXT,
      port        INTEGER DEFAULT 587,
      secure      INTEGER DEFAULT 0,
      user        TEXT,
      pass        TEXT,
      from_addr   TEXT,
      updated_at  TEXT NOT NULL
    );
    `,
  },
  {
    id: 24,
    name: 'estate_subscriptions',
    sql: `
    -- Per-estate subscription and licensing tables.
    -- Tracks subscription status, Stripe references, and license keys.
    -- The subscription gate middleware checks estate_subscriptions.status
    -- before allowing write operations (when FEATURE_FLAGS.subscriptionGate is ON).
    CREATE TABLE IF NOT EXISTS estate_subscriptions (
      scope_id                TEXT PRIMARY KEY,
      status                  TEXT NOT NULL DEFAULT 'active',
      subscription_expires_at TEXT,
      stripe_customer_id      TEXT,
      stripe_subscription_id  TEXT,
      license_key             TEXT,
      license_expires_at      TEXT,
      trustee_account_id      TEXT,
      license_pool_slots      INTEGER DEFAULT 0,
      created_at              TEXT NOT NULL,
      updated_at              TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS estate_access_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      scope_id    TEXT NOT NULL,
      event       TEXT NOT NULL,
      details     TEXT,
      created_at  TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_estate_access_log_scope
      ON estate_access_log(scope_id, created_at DESC);
    `,
  },
  {
    id: 25,
    name: 'geo_sites',
    sql: `
    -- Authorized locations where items can be added. The home/primary
    -- site is created with the scope; additional sites (storage unit,
    -- second home, vacation home) are added by the owner. Each site has
    -- optional GPS coordinates for geosyncing — when the capture flow
    -- detects the device is at a known site, items are auto-tagged.
    CREATE TABLE sites (
      site_id     TEXT PRIMARY KEY,
      scope_id    TEXT NOT NULL REFERENCES scopes(scope_id) ON DELETE CASCADE,
      name        TEXT NOT NULL,
      kind        TEXT NOT NULL DEFAULT 'home',
      lat         REAL,
      lon         REAL,
      radius_m    INTEGER NOT NULL DEFAULT 100,
      is_primary  INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT NOT NULL
    );
    CREATE INDEX idx_sites_scope ON sites(scope_id);

    -- Tag each item with the site it was added from. NULL means the
    -- item was added before geosyncing or from an unrecognized location.
    ALTER TABLE items ADD COLUMN site_id TEXT REFERENCES sites(site_id) ON DELETE SET NULL;
    ALTER TABLE items ADD COLUMN site_name TEXT NOT NULL DEFAULT '';

    -- Track where each item was captured (lat/lon at time of add).
    ALTER TABLE items ADD COLUMN captured_lat REAL;
    ALTER TABLE items ADD COLUMN captured_lon REAL;

    -- Scope rooms to a site so each site (home, second home, vacation
    -- property) carries its own room list. Existing rooms get NULL
    -- site_id (treated as the primary/home site).
    ALTER TABLE rooms ADD COLUMN site_id TEXT REFERENCES sites(site_id) ON DELETE SET NULL;
    CREATE INDEX IF NOT EXISTS idx_rooms_site ON rooms(scope_id, site_id);
    `,
  },
];