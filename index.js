const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  Events,
  PermissionFlagsBits,
  EmbedBuilder,
} = require('discord.js');
const express = require('express');
const crypto  = require('crypto');
const net     = require('net');
const Database = require('./database');
require('dotenv').config();

const required = [
  'DISCORD_TOKEN','CLIENT_ID1','GUILD_ID',
  'TWITCH_CLIENT_ID','TWITCH_CLIENT_SECRET',
  'TWITCH_FRIEND_BROADCASTER_ID',
  'TWITCH_CHANNEL_NAME',
  'TWITCH_BOT_USERNAME','TWITCH_BOT_OAUTH',
  'WEBHOOK_SECRET','PUBLIC_URL',
];
for (const key of required) {
  if (!process.env[key]) { console.error(`❌ Fehlende Variable: ${key}`); process.exit(1); }
}

const db     = new Database();
const app    = express();
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
});

// ── Pending verifications: twitchLogin → { code, discordUserId, intervalId, timeoutId } ──
const pending   = new Map();
const usedCodes = new Set(); // codes that have already been used

// ── Twitch API ────────────────────────────────────────────────────────────────
let twitchToken = null;
let twitchTokenExpiry = 0;

async function getTwitchToken() {
  if (twitchToken && Date.now() < twitchTokenExpiry) return twitchToken;
  const res  = await fetch(
    `https://id.twitch.tv/oauth2/token?client_id=${process.env.TWITCH_CLIENT_ID}&client_secret=${process.env.TWITCH_CLIENT_SECRET}&grant_type=client_credentials`,
    { method: 'POST' }
  );
  const data = await res.json();
  twitchToken       = data.access_token;
  twitchTokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  return twitchToken;
}

async function twitchGet(path) {
  const token = await getTwitchToken();
  const res   = await fetch(`https://api.twitch.tv/helix${path}`, {
    headers: {
      'Client-ID': process.env.TWITCH_CLIENT_ID,
      'Authorization': `Bearer ${token}`,
    },
  });
  return res.json();
}

async function getTwitchUser(login) {
  const data = await twitchGet(`/users?login=${encodeURIComponent(login)}`);
  return data.data?.[0] ?? null;
}

async function isFollowing(twitchUserId) {
  // Check if user follows the FRIEND's channel
  const data = await twitchGet(
    `/channels/followers?broadcaster_id=${process.env.TWITCH_FRIEND_BROADCASTER_ID}&user_id=${twitchUserId}`
  );
  return (data.total ?? 0) > 0;
}

// ── Role helpers ──────────────────────────────────────────────────────────────
async function giveRole(discordUserId) {
  try {
    const roleId = db.getFollowerRole();
    if (!roleId) return;
    const guild  = client.guilds.cache.get(process.env.GUILD_ID);
    if (!guild) return;
    const member = await guild.members.fetch(discordUserId).catch(() => null);
    if (!member || member.roles.cache.has(roleId)) return;
    await member.roles.add(roleId);
    console.log(`✅ Rolle gegeben: ${member.user.username}`);
  } catch (err) { console.error('giveRole:', err.message); }
}

async function removeRole(discordUserId) {
  try {
    const roleId = db.getFollowerRole();
    if (!roleId) return;
    const guild  = client.guilds.cache.get(process.env.GUILD_ID);
    if (!guild) return;
    const member = await guild.members.fetch(discordUserId).catch(() => null);
    if (!member || !member.roles.cache.has(roleId)) return;
    await member.roles.remove(roleId);
    console.log(`🗑️ Rolle entfernt: ${member.user.username}`);
  } catch (err) { console.error('removeRole:', err.message); }
}

// ── Twitch IRC Chat Reader ─────────────────────────────────────────────────────
let ircSocket = null;

function connectTwitchIRC() {
  ircSocket = new net.Socket();
  ircSocket.connect(6667, 'irc.chat.twitch.tv', () => {
    console.log('🔌 Twitch IRC verbunden.');
    const oauthToken = process.env.TWITCH_BOT_OAUTH.startsWith('oauth:') ? process.env.TWITCH_BOT_OAUTH : `oauth:${process.env.TWITCH_BOT_OAUTH}`;
    ircSocket.write(`CAP REQ :twitch.tv/tags twitch.tv/commands\r\n`);
    ircSocket.write(`PASS ${oauthToken}\r\n`);
    ircSocket.write(`NICK ${process.env.TWITCH_BOT_USERNAME}\r\n`);
    ircSocket.write(`JOIN #${process.env.TWITCH_CHANNEL_NAME}\r\n`);
  });

  let buffer = '';
  ircSocket.on('data', (data) => {
    buffer += data.toString();
    const lines = buffer.split('\r\n');
    buffer = lines.pop(); // keep incomplete line

    for (const line of lines) {
      if (line) console.log('IRC RAW:', line);

      // Respond to PING
      if (line.startsWith('PING')) {
        ircSocket.write('PONG :tmi.twitch.tv\r\n');
        continue;
      }

      // Parse PRIVMSG with optional tags
      // Format with tags: @key=val;key=val :user!user@user.tmi.twitch.tv PRIVMSG #channel :message
      // Format without:   :user!user@user.tmi.twitch.tv PRIVMSG #channel :message
      let msgId = null;
      let parseLine = line;

      if (line.startsWith('@')) {
        const spaceIdx = line.indexOf(' ');
        const tagStr = line.slice(1, spaceIdx);
        parseLine = line.slice(spaceIdx + 1);
        for (const tag of tagStr.split(';')) {
          const [k, v] = tag.split('=');
          if (k === 'id') msgId = v;
        }
      }

      const match = parseLine.match(/^:(\w+)!\w+@\w+\.tmi\.twitch\.tv PRIVMSG #\w+ :(.+)$/);
      if (!match) continue;

      const twitchLogin = match[1].toLowerCase();
      const message     = match[2].trim();

      console.log(`IRC Nachricht von ${twitchLogin}: ${message}`);

      // Check if message contains a pending verification code
      for (const [pendingLogin, data] of pending.entries()) {
        if (twitchLogin === pendingLogin && message === data.code) {
          if (usedCodes.has(data.code)) break;
          // Delete the message in Twitch chat
          if (msgId) {
            ircSocket.write(`PRIVMSG #${process.env.TWITCH_CHANNEL_NAME} :/delete ${msgId}\r\n`);
          }
          handleVerificationSuccess(pendingLogin, data);
          break;
        }
      }
    }
  });

  ircSocket.on('error', (err) => console.error('IRC Fehler:', err.message));
  ircSocket.on('close', () => {
    console.log('IRC getrennt — reconnect in 5s...');
    setTimeout(connectTwitchIRC, 5000);
  });
}

async function handleVerificationSuccess(twitchLogin, data) {
  const { discordUserId, interaction, intervalId, timeoutId, code } = data;

  usedCodes.add(code);
  clearInterval(intervalId);
  clearTimeout(timeoutId);
  pending.delete(twitchLogin);

  const twitchUser = await getTwitchUser(twitchLogin);
  const twitchId   = twitchUser?.id ?? twitchLogin;

  db.linkTwitchAccount(discordUserId, twitchId, twitchLogin);
  db.setFollowing(twitchId, false);

  // Sofort prüfen ob er schon folgt
  const alreadyFollowing = await isFollowing(twitchId);
  if (alreadyFollowing) {
    db.setFollowing(twitchId, true);
    await giveRole(discordUserId);
  }

  const successEmbed = new EmbedBuilder()
    .setColor(0x00FF7F)
    .setTitle('✅ Verifizierung erfolgreich!')
    .setDescription(
      alreadyFollowing
        ? `🎉 Twitch-Account **${twitchLogin}** verknüpft!\n\nDu folgst dem Kanal bereits — du hast die **Follower-Rolle** erhalten!`
        : `✅ Twitch-Account **${twitchLogin}** erfolgreich verknüpft!\n\nℹ️ Sobald du dem Kanal auf Twitch folgst, bekommst du automatisch die Follower-Rolle.`
    )
    .setFooter({ text: `Verifiziert als ${twitchLogin}` });

  await interaction.editReply({ embeds: [successEmbed] }).catch(() => {});
  console.log(`✅ ${twitchLogin} verknüpft mit Discord-User ${discordUserId}${alreadyFollowing ? ' — Rolle vergeben' : ' — wartet auf Follow'}`);
}

// ── Verification start ────────────────────────────────────────────────────────
function generateCode() {
  return 'VERIFY-' + crypto.randomBytes(4).toString('hex').toUpperCase();
}

async function startVerification(interaction, twitchLogin) {
  const discordUserId = interaction.user.id;

  // Cancel existing verification for this user
  for (const [key, val] of pending.entries()) {
    if (val.discordUserId === discordUserId) {
      clearInterval(val.intervalId);
      clearTimeout(val.timeoutId);
      pending.delete(key);
    }
  }

  // Check if this Discord user already has a verified account
  const existingDiscordLink = db.getLinkByDiscord(discordUserId);
  if (existingDiscordLink) {
    return interaction.editReply({
      content: `❌ Du hast bereits **${existingDiscordLink.twitch_login}** verknüpft. Nutze \`/unlink\` zuerst.`
    });
  }

  const code        = generateCode();
  let   secondsLeft = 60;

  const buildEmbed = (secs) => new EmbedBuilder()
    .setColor(secs > 20 ? 0x5865F2 : secs > 10 ? 0xFF9900 : 0xFF0000)
    .setTitle('🔐 Twitch Verifizierung')
    .setDescription([
      `Tippe diesen Code in den Twitch-Chat von **${process.env.TWITCH_CHANNEL_NAME}**:`,
      `\`\`\`${code}\`\`\``,
      `⏱️ **Zeit übrig: ${secs} Sekunden**`,
      ``,
      `_Sobald du den Code im Chat schreibst wird die Verifizierung automatisch abgeschlossen._`,
    ].join('\n'))
    .setFooter({ text: `Twitch: ${twitchLogin}` });

  await interaction.editReply({ embeds: [buildEmbed(secondsLeft)] });

  // Countdown interval
  const intervalId = setInterval(async () => {
    secondsLeft -= 5;
    if (secondsLeft > 0 && pending.has(twitchLogin)) {
      await interaction.editReply({ embeds: [buildEmbed(secondsLeft)] }).catch(() => {});
    }
  }, 5000);

  // Timeout
  const timeoutId = setTimeout(async () => {
    clearInterval(intervalId);
    pending.delete(twitchLogin);

    const expiredEmbed = new EmbedBuilder()
      .setColor(0xFF0000)
      .setTitle('⏱️ Zeit abgelaufen')
      .setDescription(`Der Code ist abgelaufen.\n\nNutze \`/verify ${twitchLogin}\` für einen neuen Code.`);

    await interaction.editReply({ embeds: [expiredEmbed] }).catch(() => {});
  }, 60_000);

  pending.set(twitchLogin, {
    code, discordUserId, interaction, intervalId, timeoutId,
  });
}



// ── Follower Polling ──────────────────────────────────────────────────────────
async function pollFollowers() {
  try {
    const linkedUsers = db.db.prepare('SELECT * FROM links').all();
    for (const user of linkedUsers) {
      const following = await isFollowing(user.twitch_id);
      const wasFollowing = user.is_following === 1;
      if (following && !wasFollowing) {
        db.setFollowing(user.twitch_id, true);
        await giveRole(user.discord_id);
        console.log(`Polling: ${user.twitch_login} folgt jetzt - Rolle vergeben.`);
      } else if (!following && wasFollowing) {
        db.setFollowing(user.twitch_id, false);
        await removeRole(user.discord_id);
        console.log(`Polling: ${user.twitch_login} folgt nicht mehr - Rolle entfernt.`);
      }
    }
  } catch (err) {
    console.error('Polling Fehler:', err.message);
  }
}

async function subscribeToFollows() {
  console.log('Follower-Polling gestartet (alle 10 Sekunden).');
  setInterval(pollFollowers, 10_000);
  await pollFollowers();
}

// ── Webhook server ────────────────────────────────────────────────────────────
function verifyTwitchSignature(req, rawBody) {
  const msgId     = req.headers['twitch-eventsub-message-id'] ?? '';
  const timestamp = req.headers['twitch-eventsub-message-timestamp'] ?? '';
  const signature = req.headers['twitch-eventsub-message-signature'] ?? '';
  const expected  = 'sha256=' + crypto
    .createHmac('sha256', process.env.WEBHOOK_SECRET)
    .update(msgId + timestamp + rawBody).digest('hex');
  try { return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature)); }
  catch { return false; }
}

app.use('/webhook/twitch', express.raw({ type: 'application/json' }));
app.use(express.json());

app.post('/webhook/twitch', async (req, res) => {
  const rawBody = req.body.toString();
  let body;
  try { body = JSON.parse(rawBody); } catch { return res.sendStatus(400); }
  if (!verifyTwitchSignature(req, rawBody)) return res.sendStatus(403);

  const msgType = req.headers['twitch-eventsub-message-type'];
  if (msgType === 'webhook_callback_verification') {
    console.log('✅ Webhook verifiziert.');
    return res.status(200).send(body.challenge);
  }

  if (msgType === 'notification') {
    const type         = body.subscription?.type;
    const twitchUserId = body.event?.user_id;
    const discordUserId = db.getDiscordUserByTwitch(twitchUserId);
    if (discordUserId) {
      if (type === 'channel.follow') { db.setFollowing(twitchUserId, true);  await giveRole(discordUserId); }
      if (type === 'channel.unfollow') { db.setFollowing(twitchUserId, false); await removeRole(discordUserId); }
    }
  }
  res.sendStatus(200);
});

app.get('/', (_, res) => res.send('Twitch Follower Bot ✅'));

// ── Slash Commands ────────────────────────────────────────────────────────────
async function registerCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName('verify')
      .setDescription('Verknüpfe deinen Twitch-Account — tippe den Code in den Twitch-Chat')
      .addStringOption(o => o.setName('twitch-name').setDescription('Dein Twitch-Username').setRequired(true))
      .toJSON(),
    new SlashCommandBuilder()
      .setName('unlink')
      .setDescription('Entferne die Verknüpfung deines Twitch-Accounts')
      .toJSON(),
    new SlashCommandBuilder()
      .setName('check-follow')
      .setDescription('Prüft ob du dem Kanal folgst und aktualisiert deine Rolle')
      .toJSON(),
    new SlashCommandBuilder()
      .setName('set-follower-role')
      .setDescription('Setzt die Rolle die Twitch-Follower bekommen')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
      .addRoleOption(o => o.setName('rolle').setDescription('Die Follower-Rolle').setRequired(true))
      .toJSON(),
  ];

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  await rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID1, process.env.GUILD_ID), { body: commands });
  console.log('✅ Commands registriert.');
}

// ── Interactions ──────────────────────────────────────────────────────────────
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  try {
    if (interaction.commandName === 'set-follower-role') {
      const role = interaction.options.getRole('rolle');
      db.setFollowerRole(role.id);
      return interaction.reply({ content: `✅ Follower-Rolle: <@&${role.id}>`, flags: 64 });
    }

    if (interaction.commandName === 'verify') {
      await interaction.deferReply({ flags: 64 });
      await startVerification(interaction, interaction.options.getString('twitch-name').trim().toLowerCase());
    }

    if (interaction.commandName === 'unlink') {
      const link = db.getLinkByDiscord(interaction.user.id);
      if (!link) return interaction.reply({ content: '❌ Kein Twitch-Account verknüpft.', flags: 64 });
      db.unlinkTwitchAccount(interaction.user.id);
      await removeRole(interaction.user.id);
      return interaction.reply({ content: `✅ **${link.twitch_login}** entknüpft und Rolle entfernt.`, flags: 64 });
    }

    if (interaction.commandName === 'check-follow') {
      await interaction.deferReply({ flags: 64 });
      const link = db.getLinkByDiscord(interaction.user.id);
      if (!link) return interaction.editReply({ content: '❌ Kein Twitch-Account verknüpft. Nutze `/verify`.' });
      const following = await isFollowing(link.twitch_id);
      db.setFollowing(link.twitch_id, following);
      if (following) { await giveRole(interaction.user.id); return interaction.editReply({ content: `✅ Du folgst als **${link.twitch_login}** — Rolle gegeben!` }); }
      else { await removeRole(interaction.user.id); return interaction.editReply({ content: `ℹ️ Du folgst als **${link.twitch_login}** nicht — Rolle entfernt.` }); }
    }
  } catch (err) {
    console.error('Interaction Fehler:', err.message);
    const msg = { content: '❌ Fehler.', flags: 64 };
    if (interaction.deferred || interaction.replied) await interaction.editReply(msg).catch(() => {});
    else await interaction.reply(msg).catch(() => {});
  }
});

// ── Ready ─────────────────────────────────────────────────────────────────────
client.once(Events.ClientReady, async () => {
  console.log(`✅ Eingeloggt als ${client.user.tag}`);
  await registerCommands();
  const PORT = process.env.PORT ?? 3000;
  app.listen(PORT, () => console.log(`🌐 Webhook-Server auf Port ${PORT}`));
  connectTwitchIRC();
  await subscribeToFollows();
});

process.on('unhandledRejection', err => console.error('unhandledRejection:', err?.message ?? err));
process.on('uncaughtException',  err => console.error('uncaughtException:',  err?.message ?? err));

client.login(process.env.DISCORD_TOKEN);
