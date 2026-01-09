import "dotenv/config";
import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.AI_KEY,
});

const gpt = async (user, text) => {
  try {
    const response = await openai.responses.create({
      model: "gpt-4o-mini",
      input: [
        {
          role: "system",
          content: `You are a WhatsApp assistant bot chatting with ${user}`,
        },
        {
          role: "user",
          content: text,
        },
      ],
    });

    const output = response.output_text;
    console.log(output);
    return output;
  } catch (err) {
    console.error("AI error:", err);
    return "I'm having trouble thinking right now 😅";
  }
};

export default gpt;
