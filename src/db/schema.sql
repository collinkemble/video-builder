-- =============================================
-- SHARED TABLES (do not modify)
-- =============================================

-- Users table
CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  email VARCHAR(255) NOT NULL UNIQUE,
  name VARCHAR(255),
  is_admin BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_email (email)
);

-- Feedback table
CREATE TABLE IF NOT EXISTS feedback (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT,
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255) NOT NULL,
  subject VARCHAR(500) NOT NULL,
  body TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_created_at (created_at)
);

-- API Keys table
CREATE TABLE IF NOT EXISTS api_keys (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  name VARCHAR(255) NOT NULL,
  key_prefix VARCHAR(8) NOT NULL,
  key_hash VARCHAR(64) NOT NULL,
  last_used_at TIMESTAMP NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_user_id (user_id),
  UNIQUE INDEX idx_key_hash (key_hash)
);

-- =============================================
-- APP-SPECIFIC TABLES — Video Builder
-- =============================================

-- Videos table (main asset)
CREATE TABLE IF NOT EXISTS videos (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  name VARCHAR(255) NOT NULL,
  brand_name VARCHAR(255),
  pocketsic_project_id INT,
  pocketsic_project_name VARCHAR(255),
  status ENUM('draft', 'scripting', 'voiceover', 'capturing', 'compositing', 'uploading', 'completed', 'failed') DEFAULT 'draft',

  -- Source data from PocketSIC
  scene_data JSON,
  scene_ids JSON,

  -- Source data from Script Writer
  scriptwriter_script_id INT DEFAULT NULL,
  scriptwriter_script_name VARCHAR(255) DEFAULT NULL,
  scriptwriter_data JSON DEFAULT NULL,

  -- Generated assets
  narration_script JSON,
  voiceover_url TEXT,
  voiceover_timestamps JSON,
  video_url TEXT,
  thumbnail_url TEXT,

  -- Settings
  voice_id VARCHAR(100) DEFAULT 'default',
  duration_target INT DEFAULT 180,
  include_broll BOOLEAN DEFAULT TRUE,

  -- Metadata
  duration_actual DECIMAL(6,2),
  file_size_mb DECIMAL(8,2),
  error TEXT,

  -- Sharing
  shared_by VARCHAR(255) DEFAULT NULL,
  shared_at TIMESTAMP NULL DEFAULT NULL,

  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_user_videos (user_id),
  INDEX idx_status (status)
);

-- Video jobs table (pipeline step tracking)
CREATE TABLE IF NOT EXISTS video_jobs (
  id VARCHAR(36) PRIMARY KEY,
  video_id INT NOT NULL,
  user_id INT NOT NULL,
  step ENUM('script', 'voiceover', 'capture', 'broll', 'composite', 'upload') NOT NULL,
  status ENUM('pending', 'running', 'completed', 'failed') DEFAULT 'pending',
  input JSON,
  output JSON,
  error TEXT,
  progress INT DEFAULT 0,
  total INT DEFAULT 1,
  started_at TIMESTAMP NULL,
  completed_at TIMESTAMP NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_video_jobs (video_id),
  INDEX idx_job_status (status)
);

-- App connections table (PocketSIC API key storage)
CREATE TABLE IF NOT EXISTS app_connections (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  app_slug VARCHAR(50) NOT NULL,
  app_name VARCHAR(255) NOT NULL,
  api_key_encrypted TEXT NOT NULL,
  api_key_iv VARCHAR(32) NOT NULL,
  api_key_tag VARCHAR(32) NOT NULL,
  api_key_prefix VARCHAR(12) NOT NULL,
  last_tested_at TIMESTAMP NULL,
  test_status VARCHAR(20) DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE INDEX idx_user_app (user_id, app_slug),
  INDEX idx_user_connections (user_id)
);

-- Shared videos tracking table
CREATE TABLE IF NOT EXISTS shared_videos (
  id INT AUTO_INCREMENT PRIMARY KEY,
  video_id INT NOT NULL,
  sender_user_id INT NOT NULL,
  sender_email VARCHAR(255) NOT NULL,
  recipient_email VARCHAR(255) NOT NULL,
  copied_video_id INT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE,
  FOREIGN KEY (sender_user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (copied_video_id) REFERENCES videos(id) ON DELETE SET NULL,
  INDEX idx_recipient (recipient_email),
  INDEX idx_sender_video (sender_user_id, video_id)
)
