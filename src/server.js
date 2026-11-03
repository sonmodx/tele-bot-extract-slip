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

app.get("/", (_req, res) => {
  res.status(200).send("Telegram payment webhook is running");
});

app.post("/telegram/webhook", async (req, res) => {
  let chatId; // Accessible in both try and catch
  try {
    const update = req.body;
    const message = update?.message ?? update?.channel_post;
    chatId = message?.chat?.id;
    console.log("Request body:", req.body);
    console.log("Received message from chat ID:", chatId);

    if (!message || chatId == null) {
      return res.sendStatus(200);
    }

    if (message.text === "/start") {
      await sendMessage(
        chatId,
        "Send me a payment slip image to extract its amount.",
      );
      return;
    }

    const photos = message.photo;

    if (!photos?.length) {
      res.sendStatus(200);
      await sendMessage(chatId, "Please send a payment slip as an image.");
      return;
    }

    res.sendStatus(200); // Acknowledge Telegram before doing slow work.
    await sendMessage(chatId, "Processing your payment slip...");

    const photo = photos[photos.length - 1];
    const image = await downloadTelegramPhoto(photo.file_id);
    const payment = await extractPayment(image);
    const transaction = await appendPayment(payment, chatId);

    await sendMessage(
      chatId,
      `Recorded successfully!\n\nTimestamp: ${transaction.transactionDate} ${transaction.transactionTime}\nTotal payment: ฿${payment.amount.toFixed(2)}`,
    );

    return;
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
