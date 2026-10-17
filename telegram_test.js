import "dotenv/config";
import axios from "axios";
import dns from "node:dns";

// Prefer IPv4 because IPv6 connections are timing out
dns.setDefaultResultOrder("ipv4first");

const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = "-5496796088";

async function main() {
  if (!token) {
    throw new Error("Missing TELEGRAM_BOT_TOKEN in .env");
  }

  try {
    console.log("Sending Telegram message...");

    const response = await axios.post(
      `https://api.telegram.org/bot${token}/sendMessage`,
      {
        chat_id: chatId,
        text: "Telegram Axios connectivity test",
      },
      {
        timeout: 20000,
        family: 4,
        headers: {
          "Content-Type": "application/json",
        },
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
