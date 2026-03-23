const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  Events,
  PermissionFlagsBits,
} = require('discord.js');
const express  = require('express');
const crypto   = require('crypto');
const Database = require('./database');
require('dotenv').config();

const required = [
  'DISCORD_TOKEN','CLIENT_ID','GUILD_ID',
  'TWITCH_CLIENT_ID','TWITCH_CLIENT_SECRET',
  'TWITCH_BROADCASTER_ID','WEBHOOK_SECRET','PUBLIC_URL',
];
for (const key of required) {
  if (!process.env[key]) { console.error(`❌ Fehlende Variable: ${key}`); process.exit(1); }
}

const db = new Database();

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
});

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
  console.log('✅ Twitch Token erneuert.');
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

async function getTwitchUserId(login) {
  const data = await twitchGet(`/users?login=${encodeURIComponent(login)}`);
  return data.data?.[0]?.id ?? null;
}

async function isFollowing(twitchUserId) {
  const data = await twitchGet(
    `/channels/followers?broadcaster_id=${process.env.TWITCH_BROADCASTER_ID}&user_id=${twitchUserId}`
  );
  return (data.total ?? 0) > 0;
}

// ── EventSub ──────────────────────────────────────────────────────────────────
async function subscribeToFollows() {
  const token       = await getTwitchToken();
  const callbackUrl = `${process.env.PUBLIC_URL}/webhook/twitch`;

  // Clear old subscriptions
  const existing = await twitchGet('/eventsub/subscriptions');
  for (const sub of (existing.data ?? [])) {
    await fetch(`https://api.twitch.tv/helix/eventsub/subscriptions?id=${sub.id}`, {
      method: 'DELETE',
      headers: {
        'Client-ID': process.env.TWITCH_CLIENT_ID,
        'Authorization': `Bearer ${token}`,
      },
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
        type,
        version: '2',
        condition: {
          broadcaster_user_id: process.env.TWITCH_BROADCASTER_ID,
          moderator_user_id:   process.env.TWITCH_BROADCASTER_ID,
        },
        transport: {
          method: 'webhook',
          callback: callbackUrl,
          secret: process.env.WEBHOOK_SECRET,
        },
      }),
    });
    const data = await res.json();
    if (data.data?.[0]?.status === 'webhook_callback_verification_pending') {
      console.log(`✅ EventSub abonniert: ${type}`);
    } else {
      console.error(`❌ EventSub Fehler (${type}):`, JSON.stringify(data));
    }
  }
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

// ── Webhook server ────────────────────────────────────────────────────────────
const app = express();

function verifyTwitchSignature(req, rawBody) {
  const msgId       = req.headers['twitch-eventsub-message-id'] ?? '';
  const timestamp   = req.headers['twitch-eventsub-message-timestamp'] ?? '';
  const signature   = req.headers['twitch-eventsub-message-signature'] ?? '';
  const expected    = 'sha256=' + crypto
    .createHmac('sha256', process.env.WEBHOOK_SECRET)
    .update(msgId + timestamp + rawBody)
    .digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch { return false; }
}

app.use('/webhook/twitch', express.raw({ type: 'application/json' }));
app.use(express.json());

app.post('/webhook/twitch', async (req, res) => {
  const rawBody = req.body.toString();
  let body;
  try { body = JSON.parse(rawBody); } catch { return res.sendStatus(400); }

  if (!verifyTwitchSignature(req, rawBody)) {
    console.warn('⚠️ Ungültige Twitch Signatur');
    return res.sendStatus(403);
  }

  const msgType = req.headers['twitch-eventsub-message-type'];

  if (msgType === 'webhook_callback_verification') {
    console.log('✅ Twitch Webhook verifiziert.');
    return res.status(200).send(body.challenge);
  }

  if (msgType === 'notification') {
    const type        = body.subscription?.type;
    const twitchUserId = body.event?.user_id;
    const twitchLogin  = body.event?.user_login;
    console.log(`📨 Event: ${type} | ${twitchLogin} (${twitchUserId})`);

    const discordUserId = db.getDiscordUserByTwitch(twitchUserId);

    if (type === 'channel.follow' && discordUserId) {
      db.setFollowing(twitchUserId, true);
      await giveRole(discordUserId);
    }
    if (type === 'channel.unfollow' && discordUserId) {
      db.setFollowing(twitchUserId, false);
      await removeRole(discordUserId);
    }
  }

  res.sendStatus(200);
});

app.get('/', (_, res) => res.send('Twitch Follower Bot ✅'));

// ── Slash Commands ────────────────────────────────────────────────────────────
async function registerCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName('twitch-link')
      .setDescription('Verknüpfe deinen Twitch-Account um die Follower-Rolle zu bekommen')
      .addStringOption(o => o.setName('twitch-name').setDescription('Dein Twitch-Username').setRequired(true))
      .toJSON(),
    new SlashCommandBuilder()
      .setName('twitch-unlink')
      .setDescription('Entferne die Verknüpfung deines Twitch-Accounts')
      .toJSON(),
    new SlashCommandBuilder()
      .setName('twitch-check')
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
  await rest.put(
    Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
    { body: commands }
  );
  console.log('✅ Slash-Commands registriert.');
}

// ── Interactions ──────────────────────────────────────────────────────────────
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  try {

    if (interaction.commandName === 'set-follower-role') {
      const role = interaction.options.getRole('rolle');
      db.setFollowerRole(role.id);
      return interaction.reply({ content: `✅ Follower-Rolle gesetzt: <@&${role.id}>`, flags: 64 });
    }

    if (interaction.commandName === 'twitch-link') {
      await interaction.deferReply({ flags: 64 });
      const twitchName = interaction.options.getString('twitch-name').trim().toLowerCase();

      const twitchId = await getTwitchUserId(twitchName);
      if (!twitchId) {
        return interaction.editReply({ content: `❌ Twitch-User **${twitchName}** nicht gefunden.` });
      }

      const existingDiscord = db.getDiscordUserByTwitch(twitchId);
      if (existingDiscord && existingDiscord !== interaction.user.id) {
        return interaction.editReply({ content: `❌ Dieser Twitch-Account ist bereits mit einem anderen Discord-Account verknüpft.` });
      }

      db.linkTwitchAccount(interaction.user.id, twitchId, twitchName);

      const following = await isFollowing(twitchId);
      db.setFollowing(twitchId, following);

      if (following) {
        await giveRole(interaction.user.id);
        return interaction.editReply({
          content: `✅ Verknüpft mit **${twitchName}**!\n🎉 Du folgst dem Kanal — Follower-Rolle erhalten!`,
        });
      } else {
        return interaction.editReply({
          content: `✅ Verknüpft mit **${twitchName}**!\nℹ️ Du folgst dem Kanal noch nicht — folge auf Twitch um die Rolle zu bekommen.`,
        });
      }
    }

    if (interaction.commandName === 'twitch-unlink') {
      const link = db.getLinkByDiscord(interaction.user.id);
      if (!link) return interaction.reply({ content: '❌ Kein Twitch-Account verknüpft.', flags: 64 });
      db.unlinkTwitchAccount(interaction.user.id);
      await removeRole(interaction.user.id);
      return interaction.reply({
        content: `✅ **${link.twitch_login}** wurde entknüpft und die Follower-Rolle entfernt.`,
        flags: 64,
      });
    }

    if (interaction.commandName === 'twitch-check') {
      await interaction.deferReply({ flags: 64 });
      const link = db.getLinkByDiscord(interaction.user.id);
      if (!link) return interaction.editReply({ content: '❌ Kein Twitch-Account verknüpft. Nutze `/twitch-link`.' });

      const following = await isFollowing(link.twitch_id);
      db.setFollowing(link.twitch_id, following);

      if (following) {
        await giveRole(interaction.user.id);
        return interaction.editReply({ content: `✅ Du folgst als **${link.twitch_login}** — Rolle gegeben!` });
      } else {
        await removeRole(interaction.user.id);
        return interaction.editReply({ content: `ℹ️ Du folgst als **${link.twitch_login}** aktuell nicht — Rolle entfernt.` });
      }
    }

  } catch (err) {
    console.error('Interaction Fehler:', err.message);
    const msg = { content: '❌ Fehler aufgetreten.', flags: 64 };
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
  await subscribeToFollows();
});

process.on('unhandledRejection', err => console.error('unhandledRejection:', err?.message ?? err));
process.on('uncaughtException',  err => console.error('uncaughtException:',  err?.message ?? err));

client.login(process.env.DISCORD_TOKEN);
