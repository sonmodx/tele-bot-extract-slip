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
  OPENROUTER_MODEL = "openrouter/free",
  GOOGLE_SHEET_ID,
  GOOGLE_SHEET_TAB = "Payments",
  PORT = 3000,
} = process.env;

const required = {
  TELEGRAM_BOT_TOKEN,

  OPENROUTER_API_KEY,
  GOOGLE_SHEET_ID,
};

// const chatBot8 = -1004340537942;
const chatBot8 = -1004340537942;
const chatHost8 = -1003727360841;
// const chatBot9 = -1004327923730;
const chatBot9 = -1004327923730;
const chatHost9 = -1004392595938;

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

  const buffer = Buffer.from(response.data);

  console.log("Downloaded image size:", buffer.length, "bytes");
  console.log(
    "Downloaded image content-type:",
    response.headers["content-type"],
  );

  if (buffer.length === 0) {
    throw new Error("Downloaded image is empty");
  }

  if (buffer.length > 10 * 1024 * 1024) {
    throw new Error("Image exceeds the 10 MB application limit");
  }

  // Detect the actual format from the binary signature.
  let mimeType;

  if (
    buffer.length >= 3 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  ) {
    mimeType = "image/jpeg";
  } else if (
    buffer.length >= 8 &&
    buffer
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    mimeType = "image/png";
  } else if (
    buffer.length >= 12 &&
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP"
  ) {
    mimeType = "image/webp";
  } else {
    console.error(
      "Unknown file signature:",
      buffer.subarray(0, 16).toString("hex"),
    );

    throw new Error(
      "Unsupported image format. Please send a JPEG, PNG, or WebP image.",
    );
  }

  console.log("Detected image format:", mimeType);

  return {
    base64: buffer.toString("base64"),
    mimeType,
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
          "Extract payment information from a Thai bank transfer slip.",
          "Return valid JSON only with amount, currency, transactionDate, transactionTime, and readable.",
          "amount must be a number or null.",
          "currency must be THB when identifiable, otherwise null.",
          "transactionDate must use YYYY-MM-DD format or null.",
          "transactionTime must use HH:mm:ss in 24-hour format or null.",
          "Extract the actual transaction date and time printed on the slip, not the current date or time.",
          "Convert Buddhist Era years to Gregorian years when necessary. For example, 2569 becomes 2026.",
          "Do not guess missing or unclear values. Return null for unclear date or time.",
          "readable must be true only when the slip is readable enough to identify the payment amount confidently.",
          "A slip image does not prove a genuine transfer.",
        ].join(" "),
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "Extract the payment amount, transaction date, and transaction time from this slip.",
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

  if (!text) {
    throw new Error("AI returned an empty result");
  }
  console.log("Received AI response:", text);

  const result = JSON.parse(text);
  console.log("Extracted result:", result);

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

  // Validate the date format and calendar date.
  const validDate = (date) => {
    if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return false;
    }

    const parsed = new Date(`${date}T00:00:00Z`);

    return (
      !Number.isNaN(parsed.getTime()) &&
      parsed.toISOString().slice(0, 10) === date
    );
  };

  // Validate 24-hour time, allowing seconds to be omitted.
  const validTime = (time) =>
    typeof time === "string" &&
    /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(time);

  const transactionDate = validDate(result.transactionDate)
    ? result.transactionDate
    : null;

  let transactionTime = validTime(result.transactionTime)
    ? result.transactionTime
    : null;

  if (transactionTime && transactionTime.length === 5) {
    transactionTime += ":00";
  }

  return {
    amount: Math.round((amount + Number.EPSILON) * 100) / 100,
    currency: "THB",
    transactionDate,
    transactionTime,
  };
}

async function appendPayment(payment, chatId) {
  let startColumn;
  let dateTimeColumn;

  if (String(chatId) === String(chatBot8)) {
    startColumn = "B";
    dateTimeColumn = "C";
  } else if (String(chatId) === String(chatHost8)) {
    startColumn = "D";
    dateTimeColumn = "E";
  } else if (String(chatId) === String(chatBot9)) {
    startColumn = "J";
    dateTimeColumn = "K";
  } else if (String(chatId) === String(chatHost9)) {
    startColumn = "L";
    dateTimeColumn = "M";
  } else {
    throw new Error(`Unauthorized chat ID: ${chatId}`);
  }

  // Read existing transaction date/time values from row 6 onward.
  const readResult = await sheets.spreadsheets.values.get({
    spreadsheetId: GOOGLE_SHEET_ID,
    range: `${GOOGLE_SHEET_TAB}!${dateTimeColumn}6:${dateTimeColumn}`,
  });

  const rows = readResult.data.values ?? [];

  // Find the last non-empty date/time cell.
  let lastFilledIndex = -1;

  rows.forEach((row, index) => {
    if (row[0] != null && String(row[0]).trim() !== "") {
      lastFilledIndex = index;
    }
  });

  // Start at row 6, or the row after the last record.
  const nextRow = 6 + lastFilledIndex + 1;
  const endColumn = dateTimeColumn;

  const transactionDateTime =
    `${payment.transactionDate ?? ""} ${payment.transactionTime ?? ""}`.trim();

  // Write to the exact row and columns.
  await sheets.spreadsheets.values.update({
    spreadsheetId: GOOGLE_SHEET_ID,
    range: `${GOOGLE_SHEET_TAB}!${startColumn}${nextRow}:${endColumn}${nextRow}`,
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [[payment.amount, transactionDateTime]],
    },
  });

  console.log(
    `Payment saved: chatId=${chatId}, range=${startColumn}${nextRow}:${endColumn}${nextRow}`,
  );

  return {
    transactionDate: payment.transactionDate ?? null,
    transactionTime: payment.transactionTime ?? null,
    row: nextRow,
  };
}

app.get("/", (_req, res) => {
  res.status(200).send("Telegram payment webhook is running");
});

app.post("/telegram/webhook", async (req, res) => {
  let chatId; // Accessible in both try and catch
  try {
    const update = req.body;
    let message = update?.message;
    chatId = message?.chat?.id;
    console.log("Received message from chat ID:", chatId);
    console.log("Request body:", req.body);

    if (!message || chatId == null) {
      message = update?.channel_post;
      chatId = message?.chat?.id;
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
    const payment = await extractPayment(image);
    const transaction = await appendPayment(payment, chatId);

    await sendMessage(
      chatId,
      `Recorded successfully!\n\nTimestamp: ${transaction.transactionDate} ${transaction.transactionTime}\nTotal payment: ฿${payment.amount.toFixed(2)}`,
    );

    return res.sendStatus(200);
  } catch (error) {
    console.error("Payment processing failed:", error);

    try {
      await sendMessage(
        chatId,
        "I couldn't process this slip. Please check it and try again.",
      );
    } catch (sendError) {
      console.error("Could not send Telegram reply:", sendError.message);
    }

    if (!res.headersSent) {
      return res.sendStatus(200); //Prevent Telegram from retrying the webhook on error
    }
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
