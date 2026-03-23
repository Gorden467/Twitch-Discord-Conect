const Database = require('better-sqlite3');
const path = require('path');
const fs   = require('fs');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

class TwitchDB {
  constructor() {
    this.db = new Database(path.join(DATA_DIR, 'twitch.db'));
    this.db.pragma('journal_mode = WAL');
    this.init();
  }

  init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS config (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS links (
        discord_id  TEXT PRIMARY KEY,
        twitch_id   TEXT NOT NULL UNIQUE,
        twitch_login TEXT NOT NULL,
        is_following INTEGER NOT NULL DEFAULT 0,
        linked_at   INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_twitch_id ON links(twitch_id);
    `);
    console.log('✅ Datenbank initialisiert.');
  }

  setFollowerRole(roleId) {
    this.db.prepare(`INSERT INTO config (key,value) VALUES ('follower_role',?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(roleId);
  }
  getFollowerRole() {
    return this.db.prepare(`SELECT value FROM config WHERE key='follower_role'`).get()?.value ?? null;
  }

  linkTwitchAccount(discordId, twitchId, twitchLogin) {
    this.db.prepare(`INSERT INTO links (discord_id,twitch_id,twitch_login,linked_at) VALUES (?,?,?,?)
      ON CONFLICT(discord_id) DO UPDATE SET twitch_id=excluded.twitch_id, twitch_login=excluded.twitch_login, linked_at=excluded.linked_at`)
      .run(discordId, twitchId, twitchLogin, Date.now());
  }
  unlinkTwitchAccount(discordId) {
    this.db.prepare('DELETE FROM links WHERE discord_id=?').run(discordId);
  }
  getLinkByDiscord(discordId) {
    return this.db.prepare('SELECT * FROM links WHERE discord_id=?').get(discordId) ?? null;
  }
  getDiscordUserByTwitch(twitchId) {
    return this.db.prepare('SELECT discord_id FROM links WHERE twitch_id=?').get(twitchId)?.discord_id ?? null;
  }
  setFollowing(twitchId, isFollowing) {
    this.db.prepare('UPDATE links SET is_following=? WHERE twitch_id=?').run(isFollowing ? 1 : 0, twitchId);
  }
  getAllLinks() {
    return this.db.prepare('SELECT * FROM links').all();
  }
}

module.exports = TwitchDB;
