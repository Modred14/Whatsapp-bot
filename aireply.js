import OpenAI from "openai";

const openai = new OpenAI({
  apiKey:
    "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",
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
