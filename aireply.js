const OpenAI = require("openai");
require("dotenv").config();

const openai = new OpenAI({
  apiKey: process.env.AI_KEY,
});
const gpt = async (user, text) => {
  try {
    const response = await openai.responses.create({
      model: "gpt-4o-mini",
      messages: [
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
    console.log(response.output_text);
    return response.output_text;
  } catch (err) {
    console.error("AI error:", err);
    return "I'm having trouble thinking right now 😅";
  }
};
export default gpt;
