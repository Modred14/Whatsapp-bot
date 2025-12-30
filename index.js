const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const fs = require("fs");
const path = require("path");
const generateMessage = require("./paraphrase").default;

const CONFIG_FILE = path.join(__dirname, "config.json");

const MAX_PER_COMMAND = 15;
const DAILY_LIMIT = 30;
const DEFAULT_COUNTRY_CODE = "234";
const CONCURRENT_LIMIT = 3;

// -------------------- STATE --------------------
let state = {
  USER_NAME: null,
  messageSentToday: 0,
  lastSentDate: null,
  awaitingName: false,
};

const failedQueue = [];

// -------------------- UTILS --------------------
const delay = (ms) => new Promise((res) => setTimeout(res, ms));

const randomBetween = (min, max) =>
  Math.floor(Math.random() * (max - min + 1)) + min;

const today = () =>
  new Date().toLocaleDateString("en-CA", { timeZone: "Africa/Lagos" });

// -------------------- CONFIG VALIDATION --------------------
function validateConfig(data) {
  return (
    typeof data === "object" &&
    (data.USER_NAME === null || typeof data.USER_NAME === "string") &&
    typeof data.messageSentToday === "number" &&
    (data.lastSentDate === null || typeof data.lastSentDate === "string") &&
    typeof data.awaitingName === "boolean"
  );
}
function saveFailedQueue() {
  fs.promises
    .writeFile(
      path.join(__dirname, "failedQueue.json"),
      JSON.stringify(failedQueue, null, 2)
    )
    .catch((err) => console.error("FailedQueue save failed:", err.message));
}

function loadFailedQueue() {
  const file = path.join(__dirname, "failedQueue.json");
  if (!fs.existsSync(file)) return;
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    if (Array.isArray(data)) failedQueue.push(...data);
  } catch (err) {
    console.error("FailedQueue load failed:", err.message);
  }
}

loadFailedQueue();

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

function resetDailyLimitIfNeeded() {
  if (state.lastSentDate !== today()) {
    state.messageSentToday = 0;
    state.lastSentDate = today();
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

  // Remove all non-digit characters except leading '+'
  let cleaned = n.startsWith("+")
    ? "+" + n.slice(1).replace(/\D/g, "")
    : n.replace(/\D/g, "");

  if (cleaned.startsWith("+")) {
    // Already in international format
    if (cleaned.length < 8 || cleaned.length > 16) return null; // + plus 7-15 digits
    return cleaned;
  }

  // Handle local numbers starting with 0
  if (cleaned.startsWith("0") && cleaned.length >= 7) {
    cleaned = defaultCountry + cleaned.slice(1);
  }
  // Prepend country code if missing
  else if (!cleaned.startsWith(defaultCountry) && cleaned.length >= 7) {
    cleaned = defaultCountry + cleaned;
  }

  if (cleaned.length < 7 || cleaned.length > 15) return null;

  return "+" + cleaned;
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

async function sendToNumber(number) {
  const chatId = `${number}@c.us`;
  try {
    const exists = await client.isRegisteredUser(chatId);
    if (!exists) return false;

    await client.sendPresenceAvailable();
    await delay(randomBetween(1000, 3000));
    await client.sendTyping(chatId);
    await delay(randomBetween(1000, 2000));

    await sendWithRetry(chatId, generateMessage(state.USER_NAME));

    state.messageSentToday++;
    saveConfig();
    return true;
  } catch (err) {
    console.error(
      `[${new Date().toISOString()}] Failed for ${number}: ${err.message}`
    );
    failedQueue.push({ number, message: generateMessage(state.USER_NAME) });
    return false;
  }
}

async function sendMessages(numbers) {
  let sent = 0;
  let failed = 0;

  const queue = [...numbers];

  const workers = Array(CONCURRENT_LIMIT)
    .fill()
    .map(async () => {
      while (queue.length) {
        const number = queue.shift();
        const success = await sendToNumber(number);
        if (success) sent++;
        else failed++;
        await delay(randomBetween(5000, 15000));
      }
    });

  await Promise.all(workers);
  saveFailedQueue();
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

client.on("qr", (qr) => qrcode.generate(qr, { small: true }));
client.on("ready", () => {
  console.log("✅ Bot is ready");
  resetDailyLimitIfNeeded();

  if (state.awaitingName) {
    console.log("[INFO] Awaiting user name. Please reply with your name.");
  }
});

process.on("uncaughtException", (err) => {
  console.error("❌ Uncaught exception:", err);
  saveConfig(); // make sure state is saved
  saveFailedQueue();
});

process.on("SIGINT", () => {
  console.log("❌ Bot shutting down...");
  saveConfig();
  saveFailedQueue();
  process.exit();
});

client.on("auth_failure", (msg) => console.error("❌ Auth failure:", msg));

client.on("disconnected", (reason) => {
  console.error("❌ Disconnected:", reason);
  saveConfig(); // <--- save state before exit
  saveFailedQueue();
  setTimeout(() => process.exit(1), 500); // slight delay to ensure write completes
});

// -------------------- MESSAGE HANDLER --------------------
client.on("message", async (msg) => {
  try {
    // self-chat only
    if (msg.from !== msg.to) return;
    if (!msg.body?.trim()) return;

    resetDailyLimitIfNeeded();

    const text = msg.body.trim();
    const cmd = text.split(" ")[0].toLowerCase();

    // ---------------- NAME FLOW ----------------
    if (state.awaitingName) {
      if (!/^[a-zA-Z \-']{2,30}$/.test(text)) {
        await msg.reply("Invalid name. Letters only.");
        return;
      }

      state.USER_NAME = text;
      state.awaitingName = false;
      saveConfig();
      await msg.reply(`Nice to meet you, ${state.USER_NAME}.`);
      return;
    }

    // ---------------- COMMANDS ----------------
    switch (cmd) {
      case "start":
        await msg.reply("👋 Hello World");

        if (state.USER_NAME) {
          await msg.reply(
            `Already set as *${state.USER_NAME}*\nReply *change* to update.`
          );
          return;
        }

        state.awaitingName = true;
        saveConfig();
        await msg.reply("What’s your name?");
        break;

      case "change":
        state.USER_NAME = null;
        state.awaitingName = true;
        saveConfig();
        await msg.reply("What’s your new name?");
        break;

      case "message": {
        if (!state.USER_NAME) {
          await msg.reply("Reply *start* first.");
          return;
        }

        const rawNumbers = text
          .slice(cmd.length)
          .split(/[, ]+/)
          .map((n) => n.trim())
          .filter(Boolean);

        const numbers = [
          ...new Set(
            rawNumbers
              .map((n) => normalizeNumber(n))
              .filter((n) => /^\d{11,15}$/.test(n))
          ),
        ];

        if (!numbers.length) {
          await msg.reply("No valid numbers detected.");
          return;
        }

        if (numbers.length > MAX_PER_COMMAND) {
          await msg.reply(`Max ${MAX_PER_COMMAND} numbers per command.`);
          return;
        }

        if (state.messageSentToday + numbers.length > DAILY_LIMIT) {
          await msg.reply(
            `Daily limit reached. Remaining: ${
              DAILY_LIMIT - state.messageSentToday
            }`
          );
          return;
        }

        await msg.reply(`Sending to ${numbers.length} contacts...`);

        let sent = 0;
        let failed = 0;

        const result = await sendMessages(numbers);
        sent = result.sent;
        failed = result.failed;
        await msg.reply(
          `Done.\nSent: ${sent}\nFailed: ${failed}\nToday: ${state.messageSentToday}/${DAILY_LIMIT}`
        );
        break;
      }
      case "retry": {
        if (!failedQueue.length) {
          await msg.reply("No failed messages to retry.");
          return;
        }

        await msg.reply(`Retrying ${failedQueue.length} failed messages...`);
        const retryQueue = [...failedQueue];
        failedQueue.length = 0;

        let sent = 0;
        let failed = 0;
        for (const f of retryQueue) {
          const success = await sendToNumber(f.number);
          if (success) sent++;
          else failed++;
          await delay(randomBetween(5000, 15000));
        }

        await msg.reply(
          `Retry done.\nSent: ${sent}\nFailed: ${failed}\nToday: ${state.messageSentToday}/${DAILY_LIMIT}`
        );
        saveFailedQueue();
        break;
      }

      case "menu":
        await msg.reply(
          "🤖 *MODRED BOT* 🤖\n" +
            "━━━━━━━━━━━━━━━━━━\n\n" +
            "📌 *Available Commands*\n\n" +
            "🚀 *start*\n" +
            "Initialize the bot\n\n" +
            "✏️ *change*\n" +
            "Update your name\n\n" +
            "💬 *message <numbers>*\n" +
            "Send messages to one or more numbers\n\n" +
            "🔁 *retry*\n" +
            "Resend failed messages\n\n" +
            "📋 *menu*\n" +
            "Show this menu again\n\n" +
            "━━━━━━━━━━━━━━━━━━\n" +
            "⚡ Fast • Simple • Reliable"
        );
        break;

      default:
        await msg.reply("Unknown command. Type *menu*.");
    }
  } catch (err) {
    console.error("Fatal handler error:", err);
    await msg.reply("An internal error occurred.");
  }
});

client.initialize();
