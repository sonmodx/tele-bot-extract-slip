import express from "express";
import "dotenv/config";
import { google } from "googleapis";
import OpenAI from "openai";
import axios from "axios";

const app = express();
app.use(express.json({ limit: "1mb" }));

const {
  TELEGRAM_BOT_TOKEN,

  OPENROUTER_API_KEY,
  OPENROUTER_MODEL = "google/gemma-4-26b-a4b-it:free",
  GOOGLE_SHEET_ID,
  GOOGLE_SHEET_TAB = "Payments",
  PORT = 3000,
} = process.env;

const required = {
  TELEGRAM_BOT_TOKEN,

  OPENROUTER_API_KEY,
  GOOGLE_SHEET_ID,
};

for (const [key, value] of Object.entries(required)) {
  if (!value) throw new Error(`Missing environment variable: ${key}`);
}

const openrouter = new OpenAI({
  apiKey: OPENROUTER_API_KEY,
  baseURL: "https://openrouter.ai/api/v1",
  defaultHeaders: {
    "X-Title": "Telegram Payment Slip Bot",
  },
});

const auth = new google.auth.GoogleAuth({
  keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

const sheets = google.sheets({ version: "v4", auth });

const telegramApi = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

async function telegram(method, body) {
  try {
    const response = await axios.post(`${telegramApi}/${method}`, body, {
      timeout: 20000,
      family: 4,
      headers: {
        "Content-Type": "application/json",
      },
    });

    const result = response.data;

    if (!result.ok) {
      throw new Error(`Telegram ${method} failed: ${JSON.stringify(result)}`);
    }

    return result.result;
  } catch (error) {
    if (error.response) {
      throw new Error(
        `Telegram ${method} failed: ${JSON.stringify(error.response.data)}`,
      );
    }

    throw error;
  }
}

async function sendMessage(chatId, text) {
  return telegram("sendMessage", {
    chat_id: chatId,
    text,
  });
}

async function downloadTelegramPhoto(fileId) {
  const file = await telegram("getFile", {
    file_id: fileId,
  });

  if (!file.file_path) {
    throw new Error("Telegram did not return a file path");
  }

  const url = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${file.file_path}`;

  const response = await axios.get(url, {
    timeout: 20000,
    family: 4,
    responseType: "arraybuffer",
    maxContentLength: 10 * 1024 * 1024,
    maxBodyLength: 10 * 1024 * 1024,
    validateStatus: (status) => status === 200,
  });

  console.log("Downloaded image size:", response.data.length, "bytes");
  console.log(
    "Downloaded image content-type:",
    response.headers["content-type"],
  );

  const contentType = String(response.headers["content-type"] || "")
    .split(";")[0]
    .toLowerCase();

  const mimeTypes = {
    "image/jpeg": "jpeg",
    "image/png": "png",
    "image/webp": "webp",
  };

  if (!mimeTypes[contentType]) {
    throw new Error("Use a JPEG, PNG, or WebP payment slip");
  }

  const buffer = Buffer.from(response.data);

  if (buffer.length === 0) {
    throw new Error("Downloaded image is empty");
  }

  return {
    base64: buffer.toString("base64"),
    mimeType: contentType,
  };
}

async function extractPayment(image) {
  const response = await openrouter.chat.completions.create({
    model: OPENROUTER_MODEL,
    temperature: 0,
    messages: [
      {
        role: "system",
        content: [
          "Extract the total transferred amount from a Thai bank slip.",
          "Return JSON only with amount, currency, and readable.",
          "Do not guess unclear amounts.",
          "amount must be a number or null.",
          "currency must be THB when identifiable, otherwise null.",
          "readable must be a boolean.",
          "A slip image does not prove a genuine transfer.",
        ].join(" "),
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "Extract the total payment from this image.",
          },
          {
            type: "image_url",
            image_url: {
              url: `data:${image.mimeType};base64,${image.base64}`,
            },
          },
        ],
      },
    ],
    response_format: { type: "json_object" },
  });

  const text = response.choices[0]?.message?.content;

  if (!text) throw new Error("AI returned an empty result");

  const result = JSON.parse(text);
  const amount = result.amount;

  if (
    result.readable !== true ||
    typeof amount !== "number" ||
    !Number.isFinite(amount) ||
    amount <= 0 ||
    amount > 100_000_000 ||
    result.currency !== "THB"
  ) {
    throw new Error("Could not confidently extract a valid THB amount");
  }

  return Math.round((amount + Number.EPSILON) * 100) / 100;
}

async function appendPayment(amount) {
  const timestamp = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(new Date());

  await sheets.spreadsheets.values.append({
    spreadsheetId: GOOGLE_SHEET_ID,
    range: `'${GOOGLE_SHEET_TAB.replace(/'/g, "''")}'!A:B`,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: {
      values: [[timestamp, amount]],
    },
  });

  return timestamp;
}

app.get("/", (_req, res) => {
  res.status(200).send("Telegram payment webhook is running");
});

app.post("/telegram/webhook", async (req, res) => {
  try {
    const update = req.body;
    const message = update?.message;
    const chatId = message?.chat?.id;

    if (!message || chatId == null) {
      return res.sendStatus(200);
    }

    if (message.text === "/start") {
      await sendMessage(
        chatId,
        "Send me a payment slip image to extract its amount.",
      );
      return res.sendStatus(200);
    }

    const photos = message.photo;

    if (!photos?.length) {
      await sendMessage(chatId, "Please send a payment slip as an image.");
      return res.sendStatus(200);
    }

    await sendMessage(chatId, "Processing your payment slip...");

    const photo = photos[photos.length - 1];
    const image = await downloadTelegramPhoto(photo.file_id);
    const amount = await extractPayment(image);
    const timestamp = await appendPayment(amount);

    await sendMessage(
      chatId,
      `Recorded successfully!\n\nTimestamp: ${timestamp}\nTotal payment: ฿${amount.toFixed(2)}`,
    );

    return res.sendStatus(200);
  } catch (error) {
    console.error("Webhook processing failed:", error.message);

    // Do not send a second response if headers have already been sent.
    if (!res.headersSent) {
      return res.sendStatus(500);
    }
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
