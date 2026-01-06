import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.AI_KEY,
});
const gpt = async (user, text) => {
  try {
    const response = openai.responses.create({
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
    console.log(result.output_text);
    return response;
  } catch (err) {
    console.error("AI error:", err);
    return "I'm having trouble thinking right now 😅";
  }
};
export default gpt;
