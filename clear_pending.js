import "dotenv/config";
import axios from "axios";
import dns from "node:dns";

// Prefer IPv4 because IPv6 connections are timing out
dns.setDefaultResultOrder("ipv4first");

const token = process.env.TELEGRAM_BOT_TOKEN;

async function main() {
  if (!token) {
    throw new Error("Missing TELEGRAM_BOT_TOKEN in .env");
  }

  try {
    console.log("Sending Telegram message...");

    const response = await axios.post(
      `https://api.telegram.org/bot${token}/setWebhook`,
      {
        url: "https://tele-bot-extract-slip.onrender.com/telegram/webhook",
        drop_pending_updates: true,
      },
      {
        timeout: 20000,
        family: 4,
      },
    );

    console.log("HTTP status:", response.status);
    console.log("Telegram response:", response.data);
  } catch (error) {
    if (error.response) {
      console.error("HTTP status:", error.response.status);
      console.error("Telegram error:", error.response.data);
    } else {
      console.error("Error code:", error.code);
      console.error("Error message:", error.message);
    }
  }
}

main();
