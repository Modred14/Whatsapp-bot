const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const fs = require("fs");
const path = require("path");
const generateMessage = require("./paraphrase").default;
const QRCode = require("qrcode");
const express = require("express");
const app = express();

const CONFIG_FILE = path.join(__dirname, "config.json");

const MAX_PER_COMMAND = 15;
const DAILY_LIMIT = 30;
const DEFAULT_COUNTRY_CODE = "234";
const CONCURRENT_LIMIT = 3;
let latestQR = null;
let onTime;

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

async function sendToNumber(number) {
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
    let message = generateMessage(state.USER_NAME);

    if (!message) message = "Hello!"; // fallback if undefined
    message = String(message); // ensure string
    console.log(`[SEND] To: ${chatId}, Message:`, message);

    await client.sendPresenceAvailable();
    await delay(randomBetween(1000, 3000));
    await sendWithRetry(chatId, message);

    state.messageSentToday++;
    saveConfig();
    console.log(`[SUCCESS] Message sent to ${chatId}`);
    return true;
  } catch (err) {
    console.error(
      `[${new Date().toISOString()}] Failed for ${number}: ${err.message}`
    );
    let failedMessage = generateMessage(state.USER_NAME);
    if (!failedMessage) failedMessage = "Hello!";
    failedQueue.push({ number, message: String(failedMessage) });

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

client.on("qr", async (qr) => {
  latestQR = qr; // store raw QR string
  qrcode.generate(qr, { small: true }); // keep terminal QR

  console.log("📡 QR updated and available on web");
});
client.on("ready", () => {
  console.log("✅ Bot is ready");
  resetDailyLimitIfNeeded();
  onTime = Date.now();

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

    if (!msg.body?.trim()) return;

    resetDailyLimitIfNeeded();

    const text = msg.body.trim();
    let cmd = text.split(" ")[0].toLowerCase();
    if (!cmd.startsWith(".")) {
      cmd = "." + cmd;
    }

    // ---------------- NAME FLOW ----------------
    if (state.awaitingName) {
      if (!/^[a-zA-Z \-']{2,30}$/.test(text)) {
        await msg.reply("Invalid name. Kindly input letters only.");
        return;
      }

      state.USER_NAME = text;
      state.awaitingName = false;
      saveConfig();
      await msg.reply(
        `Ok then, I will call you *${state.USER_NAME}* from now on.`
      );
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

    // ---------------- COMMANDS ----------------
    switch (cmd) {
      case ".start":
        await msg.reply("👋 Hello World ...");

        if (state.USER_NAME) {
          await msg.reply(
            `Hello *${state.USER_NAME}*\nHow can I help you today?`
          );
          return;
        }

        state.awaitingName = true;
        saveConfig();
        await msg.reply("What’s your name?");
        break;

      case ".change":
        state.USER_NAME = null;
        state.awaitingName = true;
        saveConfig();
        await msg.reply("What’s your new name?");
        break;

      case ".message": {
        if (!state.USER_NAME) {
          await msg.reply(
            "Oops! The bot is not active yet. Kindly reply with *.start* to activate it."
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
        const invalidNumbers = rawNumbers.filter(
          (_, i) => !normalizedResults[i]
        );

        if (invalidNumbers.length) {
          await msg.reply(
            `⚠️ Some numbers are invalid and won't be sent:\n${invalidNumbers.join(
              ", "
            )}`
          );
        }

        if (numbers.length > MAX_PER_COMMAND) {
          await msg.reply(
            `Unfortunately, you have a limit of ${MAX_PER_COMMAND} numbers per command.`
          );
          return;
        }

        if (state.messageSentToday + numbers.length > DAILY_LIMIT) {
          await msg.reply(
            `Oops, you have reached your daily limit for today. Please try again tomorrow.`
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
          `✅Done.\nSent: ${sent}\nFailed: ${failed}\nTotal messages sent today: ${state.messageSentToday}/${DAILY_LIMIT}`
        );
        break;
      }
      case ".retry": {
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
          `✅Retry complete.\nSent: ${sent}\nFailed: ${failed}\nTotal messages sent today: ${state.messageSentToday}/${DAILY_LIMIT}`
        );
        saveFailedQueue();
        break;
      }
      case ".explain":
        {
          let command = text.slice(cmd.length).trim();
          if (!command.startsWith(".")) {
            return (command = "." + command);
          }

          switch (command) {
            case ".start": {
              await msg.reply(
                "👋 Initializes the bot and sets the user name if not already set."
              );
              break;
            }
            case ".change name": {
              await msg.reply(
                "✏️ Updates or changes the user name in the bot system."
              );
              break;
            }
            case ".menu": {
              await msg.reply("📜 Displays all available commands.");
              break;
            }
            case ".owner": {
              await msg.reply("👤 Information about the bot owner.");
              break;
            }
            case ".explain": {
              await msg.reply(
                "💡 Provides explanations for each command. Can specify a command like *.explain <command>*."
              );
              break;
            }
            case ".joke": {
              await msg.reply("😂 Provides a humorous joke to make you laugh.");
              break;
            }
            case ".message": {
              await msg.reply(
                "📩 Sends a message via the bot number using the user’s name. Can specify recipients or quantity using *.message <number>*."
              );
              break;
            }
            case ".retry": {
              await msg.reply(
                "🔄 Retries sending messages that failed previously."
              );
              break;
            }
            default: {
              await msg.reply(
                "❌ Unknown command. Type *.menu* to see all commands."
              );
            }
          }
        }
        break;
      case ".owner":
        await msg.reply(
          "👤 About the Bot Owner\n\n" +
            "*Modred* is a Full Stack Web Developer, skilled in the MERN stack. His portfolio is available at https://favouromirin.netlify.app.\n\n" +
            "For inquiries or support, he can be reached via WhatsApp at +23279566275 or email at favourdomirin@gmail.com."
        );
        break;
      case ".jokes":
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
              answer: "It got mugged",
            },
            {
              joke: "Why did the math book look sad?",
              answer: "Too many problems",
            },
            {
              joke: "What’s orange and sounds like a parrot?",
              answer: "A carrot",
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
          await msg.reply(`${sendJoke.joke}`);
          await delay(500);
          if (sendJoke.answer) {
            await msg.reply(`${sendJoke.answer}`);
          }
        }
        break;
      case ".rizz":
        const rizzs = [
          "",
          "",

        ];
      case ".menu":
        await msg.reply(
          "╔═{🤖  *ӍØĐⱤɆĐ ɃØŦ*  🤖}═╗\n" +
            `║ \n` +
            `║ ✫⏱️ *Uptime:* ${getUptime()} \n` +
            "║ ✫⚙️ *Commands:* 9           \n" +
            "║ ✫🌟 *Version:* 1.0.0        \n" +
            "║ ✫🛠️ *Owner:* Modred         \n" +
            "╚══════════════╝\n\n\n" +
            " *Available Commands:* \n" +
            "╔══════════════╗\n" +
            "║ 📌 *General Commands:*       \n" +
            "║   ✫🚀 .start                \n" +
            "║   ✫✏️ .change name          \n" +
            "║   ✫📋 .menu                 \n" +
            "║   ✫👤 .owner                \n" +
            "║   ✫💡 .explain <command>    \n" +
            "║   ✫😂 .joke\n" +
            "║   ✫🥰 .rizz\n" +
            "╚══════════════╝\n\n" +
            "╔══════════════╗\n" +
            "║ 💬 *Message Commands:*       \n" +
            "║   ✫💬 .message <nums>       \n" +
            "║   ✫🔁 .retry                \n" +
            "╚══════════════╝\n\n" +
            "⚡ Fast • Simple • Reliable"
        );
        break;

      default:
        await msg.reply(
          "❌ Unknown command. Reply with *.menu* to see all available commands."
        );
    }
  } catch (err) {
    console.error("Fatal handler error:", err);
    await msg.reply("An internal error occurred.");
  }
});

client.initialize();
