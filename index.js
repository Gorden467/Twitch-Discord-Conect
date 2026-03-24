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
    ircSocket.write(`PASS ${oauthToken}\r\n`);
    ircSocket.write(`NICK ${process.env.TWITCH_BOT_USERNAME}\r\n`);
    ircSocket.write(`JOIN #${process.env.TWITCH_VERIFY_CHANNEL}\r\n`);
  });

  let buffer = '';
  ircSocket.on('data', (data) => {
    buffer += data.toString();
    const lines = buffer.split('\r\n');
    buffer = lines.pop(); // keep incomplete line

    for (const line of lines) {
      // Respond to PING
      if (line.startsWith('PING')) {
        ircSocket.write('PONG :tmi.twitch.tv\r\n');
        continue;
      }

      // Parse PRIVMSG — format: :username!username@username.tmi.twitch.tv PRIVMSG #channel :message
      const match = line.match(/^:(\w+)!\w+@\w+\.tmi\.twitch\.tv PRIVMSG #\w+ :(.+)$/);
      if (!match) continue;

      const twitchLogin = match[1].toLowerCase();
      const message     = match[2].trim();

      // Check if message contains a pending verification code
      for (const [pendingLogin, data] of pending.entries()) {
        if (twitchLogin === pendingLogin && message === data.code) {
          if (usedCodes.has(data.code)) break; // already used — ignore
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
  const { discordUserId, interaction, twitchUser, intervalId, timeoutId, code } = data;

  // Invalidate code immediately so it can't be reused
  usedCodes.add(code);
  clearInterval(intervalId);
  clearTimeout(timeoutId);
  pending.delete(twitchLogin);

  const following = await isFollowing(twitchUser.id);
  db.linkTwitchAccount(discordUserId, twitchUser.id, twitchUser.login);
  db.setFollowing(twitchUser.id, following);

  if (following) await giveRole(discordUserId);

  const successEmbed = new EmbedBuilder()
    .setColor(0x00FF7F)
    .setTitle('✅ Verifizierung erfolgreich!')
    .setDescription(
      following
        ? `🎉 Du folgst dem Kanal — du hast die **Follower-Rolle** erhalten!`
        : `✅ Twitch-Account **${twitchUser.login}** verifiziert!\n\nℹ️ Du folgst dem Kanal noch nicht. Folge auf Twitch um die Rolle zu bekommen.`
    )
    .setFooter({ text: `Verifiziert als ${twitchUser.login}` });

  await interaction.editReply({ embeds: [successEmbed] }).catch(() => {});
  console.log(`✅ ${twitchLogin} verifiziert für Discord-User ${discordUserId}`);
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

  const twitchUser = await getTwitchUser(twitchLogin);
  if (!twitchUser) {
    return interaction.editReply({ content: `❌ Twitch-User **${twitchLogin}** nicht gefunden.` });
  }

  // Check if this Twitch account is already linked to a different Discord user
  const existingLink = db.getDiscordUserByTwitch(twitchUser.id);
  if (existingLink && existingLink !== discordUserId) {
    return interaction.editReply({ content: `❌ Dieser Twitch-Account ist bereits mit einem anderen Discord-Account verknüpft.` });
  }

  // Check if this Discord user already has a verified account
  const existingDiscordLink = db.getLinkByDiscord(discordUserId);
  if (existingDiscordLink && existingDiscordLink.twitch_id !== twitchUser.id) {
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
    .setThumbnail(`https://static-cdn.jtvnw.net/jtv_user_pictures/${twitchUser.login}-profile_image-70x70.png`)
    .setFooter({ text: `Twitch: ${twitchUser.login}` });

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
    code, discordUserId, interaction, twitchUser, intervalId, timeoutId,
  });
}

// ── EventSub ──────────────────────────────────────────────────────────────────
async function subscribeToFollows() {
  const token       = await getTwitchToken();
  const callbackUrl = `${process.env.PUBLIC_URL}/webhook/twitch`;

  const existing = await twitchGet('/eventsub/subscriptions');
  for (const sub of (existing.data ?? [])) {
    await fetch(`https://api.twitch.tv/helix/eventsub/subscriptions?id=${sub.id}`, {
      method: 'DELETE',
      headers: { 'Client-ID': process.env.TWITCH_CLIENT_ID, 'Authorization': `Bearer ${token}` },
    });
  }

  for (const type of ['channel.follow', 'channel.unfollow']) {
    const res  = await fetch('https://api.twitch.tv/helix/eventsub/subscriptions', {
      method: 'POST',
      headers: {
        'Client-ID': process.env.TWITCH_CLIENT_ID,
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        type, version: '2',
        condition: {
          broadcaster_user_id: process.env.TWITCH_BROADCASTER_ID,
          moderator_user_id:   process.env.TWITCH_BROADCASTER_ID,
        },
        transport: { method: 'webhook', callback: callbackUrl, secret: process.env.WEBHOOK_SECRET },
      }),
    });
    const data = await res.json();
    console.log(data.data?.[0]?.status === 'webhook_callback_verification_pending'
      ? `✅ EventSub: ${type}`
      : `❌ EventSub Fehler (${type}): ${JSON.stringify(data)}`
    );
  }
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
