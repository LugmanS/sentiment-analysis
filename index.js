import OpenAI from "openai";
import dotenv from "dotenv";
import cheerio from "cheerio";
import fs from "fs";
import { google } from "googleapis";

dotenv.config();

const jwt = new google.auth.JWT(
  process.env.SERVICE_ACCOUNT_EMAIL,
  "",
  (process.env.SERVICE_ACCOUNT_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
  ["https://www.googleapis.com/auth/gmail.readonly"],
  "techbot@intoglo.com"
);

const gmail = google.gmail({ version: "v1", auth: jwt });
const openai = new OpenAI(process.env.OPENAI_API_KEY);

let q = `after:2024/06/01`;

let allThreads = [];
let nextPageToken = null;

do {
  const threadList = await gmail.users.threads.list({
    userId: "me",
    ...(q && {
      q: q,
    }),
    pageToken: nextPageToken,
  });

  if (threadList.data.threads) {
    allThreads = allThreads.concat(threadList.data.threads);
  }

  nextPageToken = threadList.data.nextPageToken;
} while (nextPageToken);

const responses = [];

console.log(`Total threads: ${allThreads.length}`);

for (const thread of allThreads) {
  const threadData = await gmail.users.threads.get({
    userId: "me",
    id: thread.id,
  });

  const subject =
    threadData.data.messages[0]?.payload?.headers?.find(
      (header) => header.name === "Subject"
    )?.value ?? "";

  const messages = [];

  threadData.data.messages.forEach((message) => {
    const emailRegex = /[\w.-]+@[a-zA-Z-]+\.[a-zA-Z]+/;

    let plainTextBody = "";
    let htmlBody = "";

    if (message.payload.parts) {
      const multipartBody = message.payload.parts.find(
        (part) => part.mimeType === "multipart/alternative"
      );

      if (multipartBody && multipartBody.parts) {
        const rawPlainTextBody = multipartBody.parts.find(
          (part) => part.mimeType === "text/plain"
        )?.body?.data;

        const rawHtmlBody = multipartBody.parts.find(
          (part) => part.mimeType === "text/html"
        )?.body?.data;

        if (rawPlainTextBody) {
          plainTextBody = Buffer.from(rawPlainTextBody, "base64").toString();
        }

        if (rawHtmlBody) {
          const htmlContent = Buffer.from(rawHtmlBody, "base64").toString();
          htmlBody = cheerio.load(htmlContent)("body").text();
        }
      } else {
        const rawPlainTextBody = message.payload.parts.find(
          (part) => part.mimeType === "text/plain"
        )?.body?.data;

        const rawHtmlBody = message.payload.parts.find(
          (part) => part.mimeType === "text/html"
        )?.body?.data;

        if (rawPlainTextBody) {
          plainTextBody = Buffer.from(rawPlainTextBody, "base64").toString();
        }

        if (rawHtmlBody) {
          const htmlContent = Buffer.from(rawHtmlBody, "base64").toString();
          htmlBody = cheerio.load(htmlContent)("body").text();
        }
      }
    }

    const from = message.payload?.headers?.find(
      (header) => header.name === "From"
    )?.value;

    const to = message.payload?.headers?.find(
      (header) => header.name === "To"
    )?.value;

    let fromEmail = "";
    let toEmail = "";

    if (from) {
      fromEmail = from.match(emailRegex)?.[0] ?? "";
    }

    if (to) {
      toEmail = to.match(emailRegex)?.[0] ?? "";
    }

    messages.push(`from: ${fromEmail}
        to: ${toEmail}
        message: ${htmlBody}`);
  });

  const text = messages.join("/n");

  const response = await openai.chat.completions.create({
    model: "gpt-3.5-turbo",
    messages: [
      {
        role: "system",
        content: `You are an email analysis agent for a cross border logistics company Intoglo. For the given thread contents which includes the subject line and the messages you should analyse the purpose of the thread, sentiment, is there any discrepencies like document missing, delays, delayed response from team and much more. Make sure your response is grounded to reality and only use the contents in the message. Respond in the below metioned json format.
        {
          "sentiment": "",
          "purpose": "System generated updates | Delay information | Customer Conversation",
          "analysedPurposeDescription": "",
          "customerSatisfactionRating": "Rate between 1 to 5 if its a customer relayed eamil",
        }
        `,
      },
      {
        role: "user",
        content: `email subject: ${subject}
        message: ${text}
        `,
      },
    ],
    response_format: {
      type: "json_object",
    },
  });

  responses.push({
    subject: subject,
    llmResponse: response.choices[0].message.content,
    threadLink: `https://mail.google.com/mail/u/0/#search/${thread.id}`,
  });

  fs.writeFileSync("./output.json", JSON.stringify(responses, null, 2));
}
