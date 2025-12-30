const pick = (arr) => {
  return arr[Math.floor(Math.random() * arr.length)];
};

const generateMessage = (userName) => {
  const greeting = ["Hi", "Hello", "Good day", "Hey"];
  const introduction = [
    `I am ${userName}`,
    `my name is ${userName}`,
    `this is ${userName}`,
    `I'm ${userName}`,
    `my name's ${userName}`,
  ];
  const context = [
    "I got your number recently.",
    "You gave me your number",
    "You gave me your contact",
    "You shared your number with me.",
    "I came across your number recently.",
    "I received your number recently.",
    "I got your contact not long ago.",
  ];
  const smallTalk = [
    "Hope you're doing well!",
    "How's your day going?",
    "How are you doing?",
  ];

  const randomTalk = Math.random() < 0.3 ? pick(smallTalk) : "";

  return `${pick(greeting)}, ${pick(introduction)} \n${pick(
    context
  )} \n${randomTalk}`;
};

module.exports.default = generateMessage;
