-- ============================================================
-- Social Media Platform (Twitter/Reddit-like) — PostgreSQL
-- Covers: PostGIS GEOMETRY, CITEXT, tsvector GENERATED STORED,
-- TEXT[] arrays, BIGINT[] arrays, tstzrange, GIN/GIST indexes,
-- polymorphic associations, partial index, self-ref FK, view.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── Enum types ────────────────────────────────────────────────
CREATE TYPE post_type AS ENUM (
  'text', 'image', 'video', 'link', 'poll', 'story', 'reel', 'thread'
);

CREATE TYPE post_visibility AS ENUM (
  'public', 'followers_only', 'mentioned_only', 'private'
);

CREATE TYPE notification_type AS ENUM (
  'like', 'comment', 'follow', 'mention', 'repost', 'quote', 'dm', 'system'
);

CREATE TYPE report_reason AS ENUM (
  'spam', 'harassment', 'hate_speech', 'misinformation', 'nsfw',
  'violence', 'intellectual_property', 'other'
);

CREATE TYPE report_status AS ENUM (
  'pending', 'under_review', 'actioned', 'dismissed'
);

CREATE TYPE moderation_action_type AS ENUM (
  'warn', 'restrict', 'suspend', 'ban', 'remove_content', 'restore_content'
);

CREATE TYPE reaction_emoji AS ENUM (
  'like', 'love', 'laugh', 'wow', 'sad', 'angry'
);

-- ── Users ─────────────────────────────────────────────────────
CREATE TABLE users (
  id               BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  username         CITEXT      NOT NULL UNIQUE,  -- case-insensitive
  email            CITEXT      NOT NULL UNIQUE,
  password_hash    TEXT        NOT NULL,
  display_name     VARCHAR(100),
  bio              TEXT,
  website_url      TEXT,
  avatar_url       TEXT,
  header_url       TEXT,
  location         GEOMETRY(Point, 4326),  -- PostGIS point (lng, lat)
  location_name    VARCHAR(200),
  birth_date       DATE,
  is_verified      BOOLEAN     NOT NULL DEFAULT FALSE,
  is_private       BOOLEAN     NOT NULL DEFAULT FALSE,
  is_suspended     BOOLEAN     NOT NULL DEFAULT FALSE,
  follower_count   INTEGER     NOT NULL DEFAULT 0,
  following_count  INTEGER     NOT NULL DEFAULT 0,
  post_count       INTEGER     NOT NULL DEFAULT 0,
  last_seen_at     TIMESTAMPTZ,
  deleted_at       TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  search_vector    tsvector GENERATED ALWAYS AS (
    to_tsvector('english',
      coalesce(username::TEXT, '') || ' ' ||
      coalesce(display_name, '') || ' ' ||
      coalesce(bio, '')
    )
  ) STORED
);

CREATE INDEX idx_users_search    ON users USING GIN (search_vector);
CREATE INDEX idx_users_location  ON users USING GIST (location);
CREATE INDEX idx_users_active    ON users (username) WHERE deleted_at IS NULL AND is_suspended = FALSE;

CREATE TABLE user_settings (
  user_id                 BIGINT  PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  email_notifications     BOOLEAN NOT NULL DEFAULT TRUE,
  push_notifications      BOOLEAN NOT NULL DEFAULT TRUE,
  dm_from_anyone          BOOLEAN NOT NULL DEFAULT FALSE,
  show_activity_status    BOOLEAN NOT NULL DEFAULT TRUE,
  high_contrast           BOOLEAN NOT NULL DEFAULT FALSE,
  reduced_motion          BOOLEAN NOT NULL DEFAULT FALSE,
  language                VARCHAR(10) NOT NULL DEFAULT 'en',
  timezone                VARCHAR(100) NOT NULL DEFAULT 'UTC',
  updated_at              TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ── Social graph ─────────────────────────────────────────────
CREATE TABLE follows (
  follower_id  BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  followee_id  BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (follower_id, followee_id),
  CHECK (follower_id <> followee_id)
);

CREATE INDEX idx_follows_followee ON follows (followee_id, created_at DESC);

CREATE TABLE user_blocks (
  blocker_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (blocker_id, blocked_id),
  CHECK (blocker_id <> blocked_id)
);

-- ── Posts ─────────────────────────────────────────────────────
CREATE TABLE posts (
  id                BIGINT          GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id           BIGINT          NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_id         BIGINT          REFERENCES posts(id) ON DELETE SET NULL,  -- reply/thread
  repost_of_id      BIGINT          REFERENCES posts(id) ON DELETE SET NULL,  -- repost/quote
  type              post_type       NOT NULL DEFAULT 'text',
  visibility        post_visibility NOT NULL DEFAULT 'public',
  body              TEXT,
  body_html         TEXT,
  language          VARCHAR(10),
  tags              TEXT[]          NOT NULL DEFAULT '{}',
  mentioned_user_ids BIGINT[]       NOT NULL DEFAULT '{}',
  hashtag_ids       BIGINT[]        NOT NULL DEFAULT '{}',
  media_urls        TEXT[]          NOT NULL DEFAULT '{}',
  link_url          TEXT,
  link_preview      JSONB,
  location          GEOMETRY(Point, 4326),
  location_name     VARCHAR(200),
  active_period     tstzrange,  -- for stories: visibility window
  reply_count       INTEGER     NOT NULL DEFAULT 0,
  repost_count      INTEGER     NOT NULL DEFAULT 0,
  like_count        INTEGER     NOT NULL DEFAULT 0,
  view_count        BIGINT      NOT NULL DEFAULT 0,
  is_pinned         BOOLEAN     NOT NULL DEFAULT FALSE,
  is_sensitive      BOOLEAN     NOT NULL DEFAULT FALSE,
  deleted_at        TIMESTAMPTZ,
  published_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  edited_at         TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  search_vector     tsvector    GENERATED ALWAYS AS (
    to_tsvector('english', coalesce(body, ''))
  ) STORED
);

CREATE INDEX idx_posts_search        ON posts USING GIN (search_vector);
CREATE INDEX idx_posts_tags          ON posts USING GIN (tags);
CREATE INDEX idx_posts_mentioned     ON posts USING GIN (mentioned_user_ids);
CREATE INDEX idx_posts_user_feed     ON posts (user_id, published_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX idx_posts_public        ON posts (published_at DESC) WHERE visibility = 'public' AND deleted_at IS NULL;
CREATE INDEX idx_posts_location      ON posts USING GIST (location);
CREATE INDEX idx_posts_active_period ON posts USING GIST (active_period) WHERE type = 'story';

CREATE TABLE post_media (
  id          BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  post_id     BIGINT      NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  url         TEXT        NOT NULL,
  media_type  VARCHAR(50) NOT NULL,  -- 'image/jpeg', 'video/mp4', etc.
  width       INTEGER,
  height      INTEGER,
  duration_s  NUMERIC(8,2),
  alt_text    VARCHAR(500),
  position    SMALLINT    NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Reactions (polymorphic) ───────────────────────────────────
CREATE TABLE reactions (
  id            BIGINT        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id       BIGINT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  resource_type VARCHAR(50)   NOT NULL,  -- 'post', 'comment'
  resource_id   BIGINT        NOT NULL,
  emoji         reaction_emoji NOT NULL DEFAULT 'like',
  created_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, resource_type, resource_id, emoji)
);

CREATE INDEX idx_reactions_resource ON reactions (resource_type, resource_id);

-- ── Comments (nested via self-ref) ────────────────────────────
CREATE TABLE comments (
  id            BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  post_id       BIGINT      NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id       BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_id     BIGINT      REFERENCES comments(id) ON DELETE SET NULL,
  body          TEXT        NOT NULL,
  like_count    INTEGER     NOT NULL DEFAULT 0,
  deleted_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_comments_post ON comments (post_id, created_at) WHERE deleted_at IS NULL;

-- ── Hashtags ─────────────────────────────────────────────────
CREATE TABLE hashtags (
  id          BIGINT   GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tag         CITEXT   NOT NULL UNIQUE,
  post_count  INTEGER  NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE post_hashtags (
  post_id    BIGINT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  hashtag_id BIGINT NOT NULL REFERENCES hashtags(id) ON DELETE CASCADE,
  PRIMARY KEY (post_id, hashtag_id)
);

CREATE INDEX idx_post_hashtags_tag ON post_hashtags (hashtag_id);

-- ── Direct messaging ─────────────────────────────────────────
CREATE TABLE conversations (
  id         BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  is_group   BOOLEAN     NOT NULL DEFAULT FALSE,
  name       VARCHAR(255),  -- for group DMs
  created_by BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE conversation_participants (
  conversation_id BIGINT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id         BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  muted_at        TIMESTAMPTZ,
  last_read_at    TIMESTAMPTZ,
  PRIMARY KEY (conversation_id, user_id)
);

CREATE TABLE messages (
  id              BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  conversation_id BIGINT      NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id       BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body            TEXT,
  media_url       TEXT,
  replied_to_id   BIGINT      REFERENCES messages(id) ON DELETE SET NULL,
  read_by         BIGINT[]    NOT NULL DEFAULT '{}',
  deleted_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  edited_at       TIMESTAMPTZ
);

-- ── Notifications ────────────────────────────────────────────
CREATE TABLE notifications (
  id            BIGINT            GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  recipient_id  BIGINT            NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  actor_id      BIGINT            REFERENCES users(id) ON DELETE SET NULL,
  type          notification_type NOT NULL,
  resource_type VARCHAR(50),
  resource_id   BIGINT,
  body          TEXT,
  is_read       BOOLEAN           NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ       NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_notifications_recipient ON notifications (recipient_id, created_at DESC)
  WHERE is_read = FALSE;

-- ── Reports & Moderation ─────────────────────────────────────
CREATE TABLE reports (
  id            BIGINT        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  reporter_id   BIGINT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  resource_type VARCHAR(50)   NOT NULL,
  resource_id   BIGINT        NOT NULL,
  reason        report_reason NOT NULL,
  details       TEXT,
  status        report_status NOT NULL DEFAULT 'pending',
  reviewed_by   BIGINT        REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE TABLE moderation_actions (
  id          BIGINT                  GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  moderator_id BIGINT                 NOT NULL REFERENCES users(id),
  target_user_id BIGINT               NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  report_id   BIGINT                  REFERENCES reports(id) ON DELETE SET NULL,
  action_type moderation_action_type  NOT NULL,
  reason      TEXT,
  duration    INTERVAL,
  expires_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ             NOT NULL DEFAULT NOW()
);

-- ── Feed items (materialized feed cache) ─────────────────────
CREATE TABLE feed_items (
  user_id    BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  post_id    BIGINT      NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  score      FLOAT8      NOT NULL DEFAULT 0,
  added_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, post_id)
);

CREATE INDEX idx_feed_items_score ON feed_items (user_id, score DESC, added_at DESC);

-- ── Views ─────────────────────────────────────────────────────
CREATE VIEW trending_hashtags AS
  SELECT
    h.id,
    h.tag,
    COUNT(ph.post_id) AS recent_posts
  FROM hashtags h
  JOIN post_hashtags ph ON ph.hashtag_id = h.id
  JOIN posts p           ON p.id = ph.post_id
  WHERE p.published_at >= NOW() - INTERVAL '24 hours'
    AND p.deleted_at IS NULL
    AND p.visibility = 'public'
  GROUP BY h.id, h.tag
  ORDER BY recent_posts DESC;
