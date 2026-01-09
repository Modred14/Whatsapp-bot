const { Client, LocalAuth, sendContact } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const fs = require("fs");
const path = require("path");
const generateMessage = require("./paraphrase").default;
const QRCode = require("qrcode");
const express = require("express");
const app = express();
const gpt = require("./aireply").default;

const CONFIG_FILE = path.join(__dirname, "config.json");

const MAX_PER_COMMAND = 15;
const DAILY_LIMIT = 30;
const DEFAULT_COUNTRY_CODE = "234";
const CONCURRENT_LIMIT = 3;
let latestQR = null;
let onTime;
let version = "v1.0.0";
const OWNER_NUMBER = "23279566275@c.us";
let customMessage = "";
const allMode = {
  private: {
    currentMode: "private",
    responseMode: "📝 Bot ignores all commands not sent by the developer.",
  },
  public: {
    currentMode: "public",
    responseMode: "📝 Bot responds to all commands.",
  },
};

let mode = allMode.private;
// -------------------- STATE --------------------
let state = {
  users: {},
};
function isOwner(msg) {
  const sender = msg.author || msg.from;
  console.log("from:", msg.from, "author:", msg.author);

  return sender === OWNER_NUMBER || sender === "66271613866160@lid";
}

let isGroup = "";
let failedMessages = [];
let sentMessages = [];

function getUser(chatId) {
  if (!state.users[chatId]) {
    state.users[chatId] = {
      USER_NAME: null,
      awaitingName: false,
      messageSentToday: 0,
      lastSentDate: today(),
      failedMessages: [],
      awaitingCustomConfirm: false,
      awaitingCustomMessage: false,
      sentMessages: [],
    };
    saveConfig();
  }
  return state.users[chatId];
}

const COMMANDS = [
  {
    com: ".ping",
    explain:
      "📶 Checks if the bot is online and responding. \nUse this command to see if the bot is active.",
  },
  {
    com: ".start",
    explain:
      "👋 Initializes the bot and sets the user name if not already set. \nUse this command to set your user name.",
  },
  {
    com: ".change",
    argul: ".change name",
    explain:
      "✏️ Updates or changes the user name in the bot system. \nUse this command to change your user name.",
  },
  {
    com: ".menu",
    explain:
      "📜 Displays all available commands. \nUse this command to check all available commands.",
  },
  {
    com: ".developer",
    explain:
      "👤 Gives information about the bot developer. \nUse this command to contact the developer.",
  },
  {
    com: ".explain",
    argul: "expain <command>",
    explain:
      "💡 Provides explanations for each command. \nCan specify a command like *.explain <command>*.",
  },
  {
    com: ".joke",
    explain:
      "😂 Provides a humorous joke to make you laugh. \nUse this command to hear a funny joke.",
  },
  {
    com: ".rizz",
    explain:
      "💘 Generates smooth, funny, or charming lines you can use to impress someone.",
  },
  {
    com: ".message",
    explain:
      "📩 Sends a message via the bot number using the user’s name.  \nOnly the bot developer can use this command.",
    argul: ".message <nums>",
  },
  {
    com: ".retry",
    explain:
      "🔄 Retries sending messages that failed previously. \nOnly the bot developer can use this command.",
  },
  {
    com: ".mode",
    explain:
      "📝 Shows the current status of the bot.  \nOnly the bot developer can use this command.",
  },

  {
    com: ".tag",
    explain:
      "📣 Mentions all members in a group chat.\n Use this command to tag everyone in the group so they get notified",
  },
  // {
  //   com: "",
  //   explain: "",
  // },
];
// -------------------- UTILS --------------------
const delay = (ms) => new Promise((res) => setTimeout(res, ms));

function startTyping(chat, interval = 2000) {
  let active = true;

  (async () => {
    while (active) {
      try {
        await chat.sendStateTyping();
        await delay(interval);
      } catch (err) {
        // If WhatsApp throws, stop typing to avoid infinite loop
        active = false;
      }
    }
  })();
  return async function stopTyping() {
    active = false;
    await chat.clearState();
  };
}

async function withTyping(chat, workFn, minMs = 1000) {
  const stopTyping = startTyping(chat);
  const startTime = Date.now();

  try {
    const result = await workFn();

    const elapsed = Date.now() - startTime;
    if (elapsed < minMs) {
      await delay(minMs - elapsed);
    }

    return result;
  } finally {
    await stopTyping();
  }
}

async function tagEveryone(msg, text) {
  const chat = await msg.getChat();

  await withTyping(
    chat,
    async () => {
      if (!chat.isGroup) {
        await msg.reply(text);
      } else {
        const mentions = chat.participants
          .filter((p) => p.id.user !== client.info?.me?.user)
          .map((p) => p.id._serialized);
        await chat.sendMessage(text || "", {
          mentions,
          quotedMessageId: msg.id._serialized,
        });
      }
    },
    1000
  ); // 👈 minimum typing time = 1 second
}

const randomBetween = (min, max) =>
  Math.floor(Math.random() * (max - min + 1)) + min;

const today = () =>
  new Date().toLocaleDateString("en-CA", { timeZone: "Africa/Lagos" });

// -------------------- CONFIG VALIDATION --------------------
function validateConfig(data) {
  if (!data || typeof data !== "object") return false;
  if (!data.users || typeof data.users !== "object") return false;

  for (const user of Object.values(data.users)) {
    if (
      typeof user.messageSentToday !== "number" ||
      typeof user.awaitingName !== "boolean" ||
      typeof user.lastSentDate !== "string"
    ) {
      return false;
    }
  }
  return true;
}

function persistState() {
  state.failedMessages = failedMessages;
  saveConfig();
}

function saveFailedQueue(number, message) {
  failedMessages.push({ number, message });
  saveConfig();
}

function loadFailedQueue(user) {
  if (Array.isArray(state.failedMessages)) {
    failedMessages.push(...state.failedMessages);
  }
}

loadFailedQueue();

async function tagEveryoneOnReply(msg) {
  const chat = await msg.getChat();

  // Ensure it's a group
  if (!chat.isGroup) {
    await msg.reply("❌ This command only works in groups.");
    return;
  }

  // IDs
  const senderId = msg.author || msg.from;
  const botId = client.info.wid._serialized;

  // Find sender participant
  const senderParticipant = chat.participants.find(
    (p) => p.id?._serialized === senderId
  );

  if (!senderParticipant) {
    await msg.reply(
      "⚠️ Could not find your participant info. " +
        "Make sure you are in the group and try again."
    );
    return;
  }

  // Check sender is admin
  if (!senderParticipant.isAdmin && !senderParticipant.isSuperAdmin) {
    await msg.reply("🚫 Only group admins can use this command.");
    return;
  }

  // Find bot participant
  const botParticipant = chat.participants.find(
    (p) => p.id?._serialized === botId
  );

  if (
    !botParticipant ||
    (!botParticipant.isAdmin && !botParticipant.isSuperAdmin)
  ) {
    await msg.reply("⚠️ You need to make me an admin to use this command.");
    return;
  }

  const quotedMsg = await msg.getQuotedMessage();

  const mentions = chat.participants
    .filter((p) => p.id.user !== client.info?.me?.user)
    .map((p) => p.id._serialized);

  await chat.sendMessage("", {
    mentions,
    quotedMessageId: quotedMsg.id._serialized,
  });
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) return;

  try {
    const raw = fs.readFileSync(CONFIG_FILE, "utf8");
    const data = JSON.parse(raw);

    if (!validateConfig(data)) {
      throw new Error("Invalid config schema");
    }

    state = { ...state, ...data };
  } catch (err) {
    console.error("Config corrupted. Resetting:", err.message);
    fs.renameSync(CONFIG_FILE, `${CONFIG_FILE}.bak`);
  }
}

// debounced async save
let saveTimeout = null;
function saveConfig() {
  clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    fs.promises
      .writeFile(CONFIG_FILE, JSON.stringify(state, null, 2))
      .catch((err) => console.error("Config save failed:", err.message));
  }, 400);
}

function resetDailyLimitIfNeeded(user) {
  if (!user) return;

  if (user.lastSentDate !== today()) {
    user.messageSentToday = 0;
    user.lastSentDate = today();
    saveConfig();
  }
}

loadConfig();
resetDailyLimitIfNeeded();

// -------------------- NUMBER NORMALIZATION --------------------
function normalizeNumber(n, defaultCountry = DEFAULT_COUNTRY_CODE) {
  if (!n) return null;

  // Convert number to string if needed
  n = String(n).trim();
  let cleaned = "";
  console.log(n);
  // If starts with '+', remove '+', spaces, or '-' and use as-is
  if (n.startsWith("+")) {
    cleaned = n.replace(/\D/g, "");
    // remove non-digits for local numbers
  } else {
    cleaned = n.replace(/\D/g, "").replace(/^0/, "");
    cleaned = defaultCountry + cleaned;
  }

  // Ensure reasonable length
  if (cleaned.length < 7 || cleaned.length > 16) return null;

  return cleaned;
}

// -------------------- SEND WITH RETRY --------------------
async function sendWithRetry(chatId, message, retries = 3) {
  let attempt = 0;
  while (attempt < retries) {
    try {
      await client.sendMessage(chatId, message);
      return true;
    } catch (err) {
      attempt++;
      if (attempt >= retries) throw err;
      // exponential backoff + jitter
      const wait = Math.floor(
        2000 * Math.pow(2, attempt) + Math.random() * 1000
      );
      await delay(wait);
    }
  }
}

async function sendToNumber(number, user) {
  if (!user || typeof user !== "object") {
    console.error("[FATAL] sendToNumber called without user:", number);
    return false;
  }
  const chatId = `${number}@c.us`;
  try {
    const normalized = normalizeNumber(number);
    if (!normalized) {
      console.warn(`[SKIP] Invalid number format: ${number}`);
      return false;
    }
    let exists = false;
    try {
      exists = await client.isRegisteredUser(chatId);
    } catch (err) {
      console.warn(
        `[SKIP] Cannot check registration for ${chatId}:`,
        err.message
      );
      return false;
    }
    console.log(chatId, "registered?", exists);
    if (!exists) {
      console.warn(`[SKIP] Number not registered on WhatsApp: ${chatId}`);
      return false;
    }
    let message = customMessage || generateMessage(user.USER_NAME);

    if (!message) message = "Hello!"; // fallback if undefined
    message = String(message); // ensure string
    console.log(`[SEND] To: ${chatId}, Message:`, message);

    await client.sendPresenceAvailable();
    await delay(randomBetween(1000, 3000));
    await sendWithRetry(chatId, message);

    user.messageSentToday++;
    saveConfig();
    console.log(`[SUCCESS] Message sent to ${chatId}`);
    return true;
  } catch (err) {
    console.error(
      `[${new Date().toISOString()}] Failed for ${number}: ${err.message}`
    );
    let failedMessage = generateMessage(user.USER_NAME);
    saveFailedQueue(number, failedMessage);

    return false;
  }
}

async function sendMessages(numbers, user) {
  if (!user) throw new Error("sendMessages called without user");
  let sent = 0;
  let failed = 0;

  const queue = [...numbers];

  const workers = Array(CONCURRENT_LIMIT)
    .fill()
    .map(async () => {
      while (queue.length) {
        const number = queue.shift();
        const success = await sendToNumber(number, user);
        if (success) sent++;
        else failed++;
        await delay(randomBetween(5000, 15000));
      }
    });

  await Promise.all(workers);
  return { sent, failed };
}

// -------------------- WHATSAPP CLIENT --------------------
const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    headless: process.env.HEADLESS !== "false",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  },
});

client.on("loading_screen", (percent, message) =>
  console.log(`Loading ${percent}%: ${message}`)
);
client.on("qr", async (qr) => {
  latestQR = qr; // store raw QR string
  qrcode.generate(qr, { small: true }); // keep terminal QR

  console.log("📡 QR updated and available on web");
});
client.on("ready", () => {
  onTime = Date.now();
  console.log("✅ Bot is ready");
  resetDailyLimitIfNeeded(user);

  if (state.awaitingName) {
    console.log("[INFO] Awaiting user name. Please reply with your name.");
  }
});

process.on("uncaughtException", (err) => {
  console.error("❌ Uncaught exception:", err);
  saveConfig(); // make sure state is saved
  persistState();
});

process.on("SIGINT", () => {
  console.log("❌ Bot shutting down...");
  saveConfig();
  persistState();

  process.exit();
});

client.on("auth_failure", (msg) => console.error("❌ Auth failure:", msg));

client.on("disconnected", (reason) => {
  console.error("❌ Disconnected:", reason);
  saveConfig(); // <--- save state before exit
  persistState();

  setTimeout(() => process.exit(1), 500); // slight delay to ensure write completes
});
app.get("/", async (req, res) => {
  if (!latestQR) {
    return res.send("<h2>QR not generated yet. Please hold.</h2>");
  }

  try {
    const qrImage = await QRCode.toDataURL(latestQR);
    res.send(`
      <html>
        <body style="display:flex;align-items:center;justify-content:center;height:100vh">
          <div>
            <h2>Scan WhatsApp QR to use the bot</h2>
            <img src="${qrImage}" />
          </div>
        </body>
      </html>
    `);
    console.log("Qr generated");
  } catch (err) {
    res.status(500).send("Failed to generate QR");
  }
});

app.listen(3000, () => {
  console.log("🌐 QR server running on http://localhost:3000");
});
// -------------------- MESSAGE HANDLER --------------------
client.on("message", async (msg) => {
  console.log("📩 Message received:", msg.from, msg.body);

  try {
    // self-chat only
    // if (!msg.fromMe) return;

    const chatId = msg.from;
    const user = getUser(chatId);

    resetDailyLimitIfNeeded(user);
    if (!msg.body?.trim()) return;

    const text = msg.body.trim();
    let cmd = text.split(" ")[0].toLowerCase();
    const isGroup = msg.from.endsWith("@g.us");
    const isCommand = COMMANDS.some((c) => c.com === cmd);
    if (isGroup) {
      if (!isOwner(msg) && mode.currentMode === "private" && isCommand) {
        await tagEveryone(
          msg,
          "Oops, the bot is in private mode. Contact my developer to make it public."
        );
        const numberE164 = "+23279566275";
        const waid = "23279566275"; // digits only (no +)

        const vcard =
          "BEGIN:VCARD\n" +
          "VERSION:3.0\n" +
          "N:Modred;Modred;;;\n" +
          "FN:Modred\n" +
          `TEL;TYPE=CELL;TYPE=VOICE;waid=${waid}:${numberE164}\n` +
          `NOTE:Email: favourdomirin@gmail.com\n` +
          "END:VCARD";

        await client.sendMessage(msg.from, vcard, { parseVCards: true });
        return;
      }
    } else {
      if (!isOwner(msg) && mode.currentMode === "private") {
        await tagEveryone(
          msg,
          "Oops, the bot is in private mode. Contact my developer to make it public."
        );
        const numberE164 = "+23279566275";
        const waid = "23279566275"; // digits only (no +)

        const vcard =
          "BEGIN:VCARD\n" +
          "VERSION:3.0\n" +
          "N:Modred;Modred;;;\n" +
          "FN:Modred\n" +
          `TEL;TYPE=CELL;TYPE=VOICE;waid=${waid}:${numberE164}\n` +
          `NOTE:Email: favourdomirin@gmail.com\n` +
          "END:VCARD";

        await client.sendMessage(msg.from, vcard, { parseVCards: true });
        return;
      }
    }

    // ---------------- NAME FLOW ----------------
    if (user.awaitingName) {
      if (!/^[a-zA-Z \-']{2,30}$/.test(text)) {
        await tagEveryone(msg, "Invalid name. Kindly input letters only.");
        return;
      }

      user.USER_NAME = text;
      user.awaitingName = false;
      saveConfig();

      await tagEveryone(
        msg,
        `Ok then, I will call you *${user.USER_NAME}* from now on.`
      );
      return;
    }
    if (user.awaitingCustomConfirm) {
      const answer = text.toLowerCase();

      if (answer === "yes") {
        user.awaitingCustomConfirm = false;
        user.awaitingCustomMessage = true;
        saveConfig();

        await tagEveryone(msg, "✍️ Send the custom message now.");
        return;
      }

      if (answer === "no") {
        user.awaitingCustomConfirm = false;
        saveConfig();

        await tagEveryone(msg, "🚀 Sending default message...");
        const result = await sendMessages(user.pendingNumbers, user);

        user.pendingNumbers = [];
        saveConfig();

        await tagEveryone(
          msg,
          `✅ Done.\nSent: ${result.sent}\nFailed: ${result.failed}`
        );
        return;
      }

      await tagEveryone(msg, "❌ Reply only with *yes* or *no*.");
      return;
    }
    if (user.awaitingCustomMessage) {
      customMessage = text;

      user.awaitingCustomMessage = false;
      saveConfig();

      await tagEveryone(msg, "🚀 Sending your custom message...");
      const result = await sendMessages(user.pendingNumbers, user);

      user.pendingNumbers = [];
      saveConfig();

      await tagEveryone(
        msg,
        `✅ Done.\nSent: ${result.sent}\nFailed: ${result.failed}`
      );
      customMessage = "";
      return;
    }

    const startTime = onTime;
    const getUptime = () => {
      const s = Math.floor((Date.now() - startTime) / 1000);
      const h = Math.floor(s / 3600);
      const m = Math.floor((s % 3600) / 60);
      const sec = s % 60;
      return `${h}h ${m}m ${sec}s`;
    };
    const getSpeed = async () => {
      const start = process.hrtime.bigint();
      await msg.getChat();
      const end = process.hrtime.bigint();
      return `${(Number(end - start) / 1_000_000).toFixed(2)} ms`;
    };
    // ---------------- COMMANDS ----------------

    switch (cmd) {
      case COMMANDS[0].com:
        {
          const speed = await getSpeed();
          await tagEveryone(
            msg,
            "╔═{🤖  *ӍØĐⱤɆĐ ɃØŦ*  🤖}═╗\n" +
              `║ ✫⏱️ *Uptime:* ${getUptime()} \n` +
              `║ ✫🚀 *Speed:* ${speed} \n` +
              "║ ✫🖥️ *Platform:* linux         \n" +
              `║ ✫🌟 *Version:* ${version}        \n` +
              `║ ✫🛠️ *Developer:* Modred \n` +
              "╚══════════════╝"
          );
        }
        break;
      case COMMANDS[1].com:
        await tagEveryone(msg, "👋 Hello World ...");

        if (user.USER_NAME) {
          await tagEveryone(
            msg,
            `Hello *${user.USER_NAME}*\nHow can I help you today?`
          );
          return;
        }

        user.awaitingName = true;
        saveConfig();
        await tagEveryone(
          msg,
          "🤖 Welcome to ӍØĐⱤɆĐ ɃØŦ!\n\nBefore we get started, what should I call you?"
        );

        break;

      case COMMANDS[2].com:
        let argu = text.slice(cmd.length).trim();
        if (argu === "name") {
          user.USER_NAME = null;
          user.awaitingName = true;
          saveConfig();
          await tagEveryone(msg, "What’s your new name?");
          break;
        }

        await tagEveryone(msg, "💡 Usage: *.change name*");

        break;
      case COMMANDS[3].com:
        await tagEveryone(
          msg,
          "╔═{🤖  *ӍØĐⱤɆĐ ɃØŦ*  🤖}═╗\n" +
            `║ ✫⏱️ *Uptime:* ${getUptime()} \n` +
            `║ ✫⚙️ *Commands:* ${COMMANDS.length} \n` +
            `║ ✫🌟 *Version:* ${version}        \n` +
            `║ ✫🛠️ *Developer:* Modred \n` +
            `║ ✫🌐 *Website:* https://favouromirin.netlify.app \n` +
            "╚══════════════╝\n\n\n" +
            " *Available Commands:* \n" +
            "╔══════════════╗\n" +
            "║ 📌 *General Commands:*       \n" +
            `║   ✫📶 ${COMMANDS[0].com}                 \n` +
            `║   ✫🚀 ${COMMANDS[1].com}                \n` +
            `║   ✫✏️ ${COMMANDS[2].argul}          \n` +
            `║   ✫📋 ${COMMANDS[3].com}                 \n` +
            `║   ✫👤 ${COMMANDS[4].com}                \n` +
            `║   ✫💡 ${COMMANDS[5].argul}   \n` +
            `║   ✫😂 ${COMMANDS[6].com}                 \n` +
            `║   ✫🥰 ${COMMANDS[7].com}               \n` +
            `║   ✫📣 ${COMMANDS[11].com}               \n` +
            "╚══════════════╝\n\n" +
            "╔══════════════╗\n" +
            `║ 💬 *Restricted Commands:*    \n` +
            `║   ✫💬 ${COMMANDS[8].argul}        \n` +
            `║   ✫🔁 ${COMMANDS[9].com}               \n` +
            `║   ✫⚙️ ${COMMANDS[10].com}             \n` +
            "╚══════════════╝\n\n" +
            "⚡ Fast • Simple • Reliable"
        );
        break;
      case COMMANDS[4].com:
        try {
          // Send info text first
          await tagEveryone(
            msg,
            "👤 *About the Bot Developer*\n\n" +
              "*Modred* is a Full Stack Web Developer skilled in the MERN stack.\n" +
              "🌐 Portfolio: https://favouromirin.netlify.app\n\n" +
              "📞 Contact below:"
          );

          const numberE164 = "+23279566275";
          const waid = "23279566275"; // digits only (no +)

          const vcard =
            "BEGIN:VCARD\n" +
            "VERSION:3.0\n" +
            "N:Modred;Modred;;;\n" +
            "FN:Modred\n" +
            `TEL;TYPE=CELL;TYPE=VOICE;waid=${waid}:${numberE164}\n` +
            `NOTE:Email: favourdomirin@gmail.com\n` +
            "END:VCARD";

          await client.sendMessage(msg.from, vcard, { parseVCards: true });
        } catch (err) {
          console.error("Failed to send developer info:", err);
          await msg.reply("⚠️ Could not send contact. Try again later.");
        }
        break;
      case COMMANDS[5].com: {
        let arg = text.slice(cmd.length).trim(); // get argument after .explain
        if (!arg) {
          await tagEveryone(
            msg,
            "💡 Usage: *.explain <command>*\nExample: *.explain ping*"
          );
          break;
        }

        // ensure it starts with a dot
        if (!arg.startsWith(".")) arg = "." + arg;

        const isExplain = COMMANDS.find(
          (c) => c.com.trim() === arg.toLowerCase()
        );
        if (isExplain) {
          await tagEveryone(msg, isExplain.explain);
          break;
        }

        await tagEveryone(
          msg,
          "❌ Unknown command. Type *.menu* to see all commands."
        );
        break;
      }

      case COMMANDS[6].com:
        {
          const jokes = [
            {
              joke: "What do you call fake spaghetti?",
              answer: "An impasta 🍝😜",
            },
            {
              joke: "What do you call an alligator in a vest?",
              answer: " An investigator 🐊🕵️‍♂️🤣",
            },
            {
              joke: "How do cows stay up to date?",
              answer: "They read the moos-paper 🐄📰😂",
            },
            {
              joke: "What’s brown and sticky?",
              answer: "A stick 🌳🤣",
            },
            {
              joke: "Why did the banana go to the doctor?",
              answer: "It wasn’t peeling well 🍌😷😂",
            },
            {
              joke: "Why did the coffee file a police report?",
              answer: "It got mugged☕😂",
            },
            {
              joke: "Why did the math book look sad?",
              answer: "Too many problems📚🤣",
            },
            {
              joke: "What’s orange and sounds like a parrot?",
              answer: "A carrot🥕😂",
            },
            {
              joke: "Why did the computer catch a cold?",
              answer: "It left its Windows open 💻❄️😂",
            },
            {
              joke: "Why don’t skeletons fight?",
              answer: "They don’t have the guts 💀🤣",
            },
            {
              joke: "Why did the coffee file a police report?",
              answer: "It got mugged ☕🚨😂",
            },

            {
              joke: "Why did the calendar feel scared?",
              answer: "Its days were numbered 📆😨😂",
            },
            {
              joke: "Why did the gamer bring a ladder?",
              answer: "To reach the next level 🎮🪜😂",
            },
            {
              joke: "Why did the alarm clock get punched?",
              answer: "It woke up the wrong person ⏰😡😂",
            },
            {
              joke: "No laughter detected. Please update your humor 😭😂",
              answer: "❌ Error 404: Humor not found 💀😂",
            },
            {
              joke: "Why did hunger attack at night?",
              answer: "Because food tastes better after 12am 🍕😈😂",
            },
            {
              joke: "Why did the calendar laugh?",
              answer: "Because I said 'next year will be better' 📆🤣",
            },
            {
              joke: "Why did the bed look happy?",
              answer: "It finally saw me coming 🛏️😍🤣",
            },
            {
              joke: "Why did the skeleton go to the party alone?",
              answer: "He had no body to go with 💀🎉🤣",
            },
            {
              joke: "Why don’t ants get sick?",
              answer: "Because they have tiny anty-bodies 🐜💪😂",
            },
            {
              joke: "Data bundle in Nigeria is like Avatar",
              answer: "It disappears when you need it the most 📶😭",
            },
            {
              joke: "What do you call a guy who’s really loud?",
              answer: "Mike 🎤😂",
            },
          ];
          const sendJoke = jokes[Math.floor(Math.random() * jokes.length)];
          const answer = sendJoke.answer || "";
          const jokeMessage = answer
            ? `${sendJoke.joke}\n\n${answer}`
            : `${sendJoke.joke}`;
          await tagEveryone(msg, jokeMessage);
        }
        break;
      case COMMANDS[7].com:
        const rizzs = [
          "🌹 Roses are red, 🌸 violets are blue 💙\nI thought God stopped creating angels until I met you 🫶😇",
          "",
        ];
        const sendRizz = rizzs[Math.floor(Math.random() * rizzs.length)];
        await tagEveryone(msg, sendRizz);
        break;

      case COMMANDS[8].com: {
        if (!isOwner(msg)) {
          await tagEveryone(
            msg,
            "❌Oops! Only the developer of this bot can use this command."
          );
          return;
        }

        const rawNumbers = text
          .slice(cmd.length)
          .trim()
          .split(/[\s,]+/)
          .filter(Boolean);
        const normalizedResults = rawNumbers.map((n) => normalizeNumber(n));
        const numbers = [...new Set(normalizedResults.filter(Boolean))];
        if (!numbers.length) {
          await tagEveryone(msg, "⚠️ No valid numbers provided.");
          return;
        }

        if (numbers.length > MAX_PER_COMMAND) {
          await tagEveryone(
            msg,
            `Unfortunately, you have a limit of ${MAX_PER_COMMAND} numbers per command.`
          );
          return;
        }

        if (user.messageSentToday + numbers.length > DAILY_LIMIT) {
          await tagEveryone(
            msg,
            `Oops, you have reached your daily limit for today. Please try again tomorrow.`
          );
          return;
        }

        await tagEveryone(msg, `Sending to ${numbers.length} contacts...`);

        user.pendingNumbers = numbers;
        user.awaitingCustomConfirm = true;
        saveConfig();

        await tagEveryone(
          msg,
          `📨 Preparing to send default message. Do you want to send a *custom message*?\nReply *yes* or *no*."`
        );

        break;
      }
      case COMMANDS[9].com: {
        if (!isOwner(msg)) {
          await tagEveryone(
            msg,
            "❌Oops! Only the developer of this bot can use this command."
          );
          return;
        }
        if (!failedMessages.length) {
          await tagEveryone(msg, "No failed messages to retry.");
          return;
        }

        await tagEveryone(
          msg,
          `Retrying ${failedMessages.length} failed messages...`
        );
        const retryQueue = [...failedMessages];
        failedMessages.length = 0;

        let sent = 0;
        let failed = 0;
        for (const f of retryQueue) {
          const success = await sendToNumber(f.number, user);
          if (success) sent++;
          else failed++;
          await delay(randomBetween(5000, 15000));
        }

        await tagEveryone(
          msg,
          `✅Retry complete.\nSent: ${sent}\nFailed: ${failed}\nTotal messages sent today: ${user.messageSentToday}/${DAILY_LIMIT}`
        );

        break;
      }

      case COMMANDS[10].com:
        const [_, arg] = msg.body.trim().split(/\s+/);
        if (!isOwner(msg)) {
          await tagEveryone(
            msg,
            "❌Oops! Only the developer of this bot can use this command."
          );
          return;
        }

        if (arg === "private" || arg === "public") {
          mode = allMode[arg];
          await tagEveryone(
            msg,
            `🤖 *Bot Mode Status*\n\n✅ Current mode: *${mode.currentMode.toUpperCase()}*\n${
              mode.responseMode
            }`
          );
          return;
        }

        await tagEveryone(
          msg,
          `🤖 *Bot Mode Status*\n\n✅ Current mode: *${mode.currentMode.toUpperCase()}*\n${
            mode.responseMode
          }`
        );

        break;
      case COMMANDS[11].com:
        {
          await tagEveryoneOnReply(msg, "");
        }
        break;

      default:
        if (isGroup) return;
        if (user.USER_NAME == null) {
          await tagEveryone(
            msg,
            "Oops! The bot is not active yet. Kindly reply with *.start* to activate it."
          );
        }
        if (cmd.startsWith(".")) {
          await tagEveryone(
            msg,
            "❌ Unknown command. Type *.menu* to see all commands."
          );
        } else {
          const userMessage = msg.body;

          const aiReply = await withTyping(
            chat,
            () => gpt(user.USER_NAME, userMessage),
            1000
          );
          // SAFETY NET — YOU DIDN’T HAVE THIS
          if (typeof aiReply !== "string" || !aiReply.trim()) {
            await tagEveryone(msg, "I'm having trouble thinking right now 😅");
            return;
          }

          await tagEveryone(msg, aiReply);
        }
    }
  } catch (err) {
    console.error("Fatal handler error:", err);
    await tagEveryone(msg, "An internal error occurred.");
  }
});

client.initialize();
