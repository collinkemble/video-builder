-- =============================================
-- SHARED TABLES (do not modify)
-- =============================================

-- Users table
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) NOT NULL UNIQUE,
  name VARCHAR(255),
  is_admin BOOLEAN DEFAULT FALSE,
  last_login_at TIMESTAMPTZ NULL DEFAULT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_users_email ON users (email);

-- Feedback table
CREATE TABLE IF NOT EXISTS feedback (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255) NOT NULL,
  subject VARCHAR(500) NOT NULL,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_feedback_created_at ON feedback (created_at);

-- API Keys table
CREATE TABLE IF NOT EXISTS api_keys (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  key_prefix VARCHAR(8) NOT NULL,
  key_hash VARCHAR(64) NOT NULL UNIQUE,
  last_used_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_api_keys_user_id ON api_keys (user_id);

-- =============================================
-- APP-SPECIFIC TABLES — Video Builder
-- =============================================

-- Videos table (main asset)
CREATE TABLE IF NOT EXISTS videos (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  brand_name VARCHAR(255),
  pocketsic_project_id INTEGER,
  pocketsic_project_name VARCHAR(255),
  status VARCHAR(20) DEFAULT 'draft',

  -- Source data from PocketSIC
  scene_data JSONB,
  scene_ids JSONB,

  -- Source data from Script Writer
  scriptwriter_script_id INTEGER DEFAULT NULL,
  scriptwriter_script_name VARCHAR(255) DEFAULT NULL,
  scriptwriter_data JSONB DEFAULT NULL,

  -- Generated assets
  narration_script JSONB,
  voiceover_url TEXT,
  voiceover_timestamps JSONB,
  video_url TEXT,
  thumbnail_url TEXT,

  -- Persona image (generated or uploaded, used as Veo reference for consistent character)
  persona_image_url TEXT DEFAULT NULL,

  -- Brand logo (from PocketSIC brand profile, used for intro overlay)
  brand_logo_url TEXT DEFAULT NULL,

  -- Settings
  voice_id VARCHAR(100) DEFAULT 'default',
  language VARCHAR(50) DEFAULT 'English',
  duration_target INTEGER DEFAULT 180,
  include_broll BOOLEAN DEFAULT TRUE,
  music_track_id VARCHAR(100) DEFAULT 'corporate-technology',
  custom_instructions TEXT DEFAULT NULL,
  segment_assets JSONB DEFAULT NULL,

  -- Metadata
  duration_actual NUMERIC(6,2),
  file_size_mb NUMERIC(8,2),
  error TEXT,

  -- Sharing
  shared_by VARCHAR(255) DEFAULT NULL,
  shared_at TIMESTAMPTZ NULL DEFAULT NULL,

  -- Public player page
  description TEXT DEFAULT NULL,
  public_enabled BOOLEAN DEFAULT FALSE,
  public_username VARCHAR(255) DEFAULT NULL,
  public_password VARCHAR(255) DEFAULT NULL,

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_videos_user ON videos (user_id);
CREATE INDEX IF NOT EXISTS idx_videos_status ON videos (status);

-- Video jobs table (pipeline step tracking)
-- NOTE: video_jobs uses UUID CHAR(36) primary key, NOT auto-increment
CREATE TABLE IF NOT EXISTS video_jobs (
  id CHAR(36) PRIMARY KEY,
  video_id INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  step VARCHAR(20) NOT NULL,
  status VARCHAR(20) DEFAULT 'pending',
  input JSONB,
  output JSONB,
  error TEXT,
  progress INTEGER DEFAULT 0,
  total INTEGER DEFAULT 1,
  started_at TIMESTAMPTZ NULL,
  completed_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_video_jobs_video ON video_jobs (video_id);
CREATE INDEX IF NOT EXISTS idx_video_jobs_status ON video_jobs (status);

-- App connections table (PocketSIC API key storage)
CREATE TABLE IF NOT EXISTS app_connections (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  app_slug VARCHAR(50) NOT NULL,
  app_name VARCHAR(255) NOT NULL,
  api_key_encrypted TEXT NOT NULL,
  api_key_iv VARCHAR(32) NOT NULL,
  api_key_tag VARCHAR(32) NOT NULL,
  api_key_prefix VARCHAR(12) NOT NULL,
  last_tested_at TIMESTAMPTZ NULL,
  test_status VARCHAR(20) DEFAULT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (user_id, app_slug)
);
CREATE INDEX IF NOT EXISTS idx_app_connections_user ON app_connections (user_id);

-- Shared videos tracking table
CREATE TABLE IF NOT EXISTS shared_videos (
  id SERIAL PRIMARY KEY,
  video_id INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  sender_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sender_email VARCHAR(255) NOT NULL,
  recipient_email VARCHAR(255) NOT NULL,
  copied_video_id INTEGER REFERENCES videos(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_shared_videos_recipient ON shared_videos (recipient_email);
CREATE INDEX IF NOT EXISTS idx_shared_videos_sender ON shared_videos (sender_user_id, video_id);
