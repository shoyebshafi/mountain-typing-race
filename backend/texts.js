// Random text generator.
//
// Storage:
//   PASSAGES (below)  -> long general passages; the "general" topic reads consecutive sentences from them
//   topics.js         -> biology, chemistry, physics and Bengal history sentences
//
// Every race / test builds a fresh text of about 20, 30, 40 or 60 words (chosen at random)
// from one topic, so players get a different text almost every time.
// To grow the storage, add more sentences to topics.js or more passages below.
// All the topic sentences: the first list plus the extra lists, merged (and de-duplicated)
const BASE = require('./topics').TOPICS;
const EXTRA = { bn: require('./topics_extra_bn'), en: require('./topics_extra_en') };
const TOPICS = { bn: {}, en: {} };
for (const lang of ['bn', 'en']) {
  for (const name of new Set([...Object.keys(BASE[lang]), ...Object.keys(EXTRA[lang])])) {
    TOPICS[lang][name] = [...new Set([...(BASE[lang][name] || []), ...(EXTRA[lang][name] || [])])];
  }
}

const PASSAGES = {
  bn: [
    "বাংলাদেশ নদীমাতৃক দেশ। এখানে অসংখ্য নদী-নালা, খাল-বিল আর হাওর জালের মতো ছড়িয়ে আছে। ষড়ঋতুর এই দেশে প্রতিটি ঋতু নিজের মতো করে সাজে। গ্রীষ্মে আম-কাঁঠালের মিষ্টি গন্ধে বাতাস ভরে ওঠে, বর্ষায় আকাশ ভেঙে নামে অঝোর ধারা। শরতে কাশফুলের সাদা ঢেউ দোলে নদীর পাড়ে, আর হেমন্তে সোনালি ধানের মাঠে কৃষকের মুখে হাসি ফোটে। শীতের সকালে খেজুরের রসের গন্ধ আর কুয়াশাঘেরা ভোর গ্রামের মানুষকে কাছে টেনে আনে। বসন্তে পলাশ আর শিমুলের লাল রঙে প্রকৃতি যেন নতুন করে জেগে ওঠে।",
    "বই মানুষের সবচেয়ে বিশ্বস্ত বন্ধু। একটি ভালো বই আমাদের নতুন কিছু শেখায়, ভাবতে শেখায় এবং স্বপ্ন দেখতে শেখায়। যে মানুষ নিয়মিত বই পড়ে, তার চিন্তা হয় স্বচ্ছ আর মন হয় উদার। ছোটবেলা থেকেই বই পড়ার অভ্যাস গড়ে তুললে জীবনের পথে চলা অনেক সহজ হয়ে যায়। মোবাইল আর ইন্টারনেটের এই যুগেও বইয়ের মূল্য একটুও কমেনি। বরং কোলাহলের মাঝে একটি বই আমাদের শান্ত হয়ে বসার সুযোগ করে দেয়। তাই প্রতিদিন অন্তত কিছুক্ষণ বই পড়ার অভ্যাস করা উচিত।",
    "পাহাড়ে ওঠা শুধু শারীরিক শক্তির পরীক্ষা নয়, এটি ধৈর্য আর মনের জোরেরও পরীক্ষা। প্রতিটি পদক্ষেপ সাবধানে ফেলতে হয়, কারণ একটু অসতর্ক হলেই বিপদ ঘটতে পারে। পথ যত খাড়াই হয়, শ্বাস তত ভারী হয়ে আসে। তবু যারা থামে না, ধীরে ধীরে এগিয়ে যায়, তারাই একসময় চূড়ায় পৌঁছায়। সেখানে দাঁড়িয়ে যখন মেঘের ওপর দিয়ে সূর্য ওঠা দেখা যায়, তখন সব ক্লান্তি এক নিমেষে মুছে যায়। জীবনের লক্ষ্যও ঠিক তেমন, ধৈর্য ধরে এগোলে সাফল্য আসেই।",
    "সময় কারও জন্য অপেক্ষা করে না। যে মুহূর্ত চলে যায়, তা আর কখনো ফিরে আসে না। তাই সময়ের সঠিক ব্যবহারই মানুষকে বড় করে তোলে। সকালে ঘুম থেকে ওঠা, নিয়ম করে পড়াশোনা করা, কাজের তালিকা তৈরি করে সেই অনুযায়ী এগোনো, এই ছোট ছোট অভ্যাসগুলোই বড় সাফল্যের ভিত্তি গড়ে দেয়। যারা আজকের কাজ কালকের জন্য ফেলে রাখে, তারা শেষ পর্যন্ত পিছিয়ে পড়ে। আর যারা প্রতিটি দিনকে মূল্যবান মনে করে, তাদের সামনে সম্ভাবনার দরজা খুলে যায়।",
    "একুশে ফেব্রুয়ারি আমাদের ভাষা আন্দোলনের স্মৃতিবিজড়িত দিন। ১৯৫২ সালের এই দিনে মাতৃভাষা বাংলার মর্যাদা রক্ষার জন্য সালাম, বরকত, রফিক, জব্বারসহ অনেকে জীবন দিয়েছিলেন। তাঁদের আত্মত্যাগের বিনিময়েই আমরা নিজের ভাষায় কথা বলার অধিকার পেয়েছি। আজ সারা বিশ্ব এই দিনটিকে আন্তর্জাতিক মাতৃভাষা দিবস হিসেবে পালন করে। বাংলা ভাষা আমাদের পরিচয়, আমাদের গর্ব। এই ভাষার শুদ্ধ ব্যবহার ও চর্চা করা আমাদের সবার দায়িত্ব।",
    "সুস্থ থাকা জীবনের সবচেয়ে বড় সম্পদ। নিয়মিত ব্যায়াম, পুষ্টিকর খাবার আর পর্যাপ্ত ঘুম আমাদের শরীরকে সবল রাখে। প্রতিদিন সকালে অল্প কিছুক্ষণ হাঁটলে শরীর যেমন চাঙ্গা হয়, মনও তেমনি প্রফুল্ল থাকে। বেশি তেল-মসলাযুক্ত খাবার এবং অতিরিক্ত মিষ্টি এড়িয়ে চলা ভালো। পাশাপাশি প্রচুর পানি পান করা এবং সবুজ শাকসবজি ও ফল খাওয়ার অভ্যাস করতে হবে। শরীর সুস্থ থাকলে পড়াশোনা, কাজ এবং আনন্দ, সবকিছুই ভালোভাবে উপভোগ করা যায়।",
    "প্রযুক্তি আমাদের জীবনকে অনেক সহজ করে দিয়েছে। আজ ঘরে বসেই আমরা দূর দেশের মানুষের সাথে কথা বলতে পারি, অনলাইনে পড়াশোনা করতে পারি এবং প্রয়োজনীয় তথ্য মুহূর্তের মধ্যে খুঁজে পেতে পারি। তবে প্রযুক্তির সঠিক ব্যবহার জানা জরুরি। অতিরিক্ত সময় ফোনে কাটালে চোখ ও মনের ক্ষতি হয়। তাই প্রযুক্তিকে আমাদের কাজে লাগাতে হবে, প্রযুক্তির দাস হলে চলবে না। দ্রুত এবং নির্ভুল টাইপ করতে পারা এই যুগে একটি অত্যন্ত দরকারি দক্ষতা।",
    "গ্রামের সকালটা ছিল বড় মধুর। পাখির কিচিরমিচির ডাকে ঘুম ভাঙতেই রহিম দেখল, উঠানজুড়ে সোনালি রোদ ছড়িয়ে পড়েছে। মা রান্নাঘরে পিঠা বানাচ্ছেন, তার গন্ধে সারা বাড়ি ম ম করছে। বাবা গরু নিয়ে মাঠের দিকে রওনা হয়েছেন। রহিম বইখাতা নিয়ে স্কুলের পথ ধরল। পথে বন্ধুদের সাথে দেখা হলো, সবাই মিলে হাসতে হাসতে এগিয়ে চলল। সেই দিনগুলোর কথা মনে পড়লে আজও মন ভরে ওঠে।"
  ],
  en: [
    "The path up the mountain begins quietly, with nothing more than a single step and a steady breath. At first the trail feels easy, winding through tall pines and soft patches of grass. But as the air grows thinner, every step asks for more patience. The climbers who reach the summit are rarely the fastest at the start. They are the ones who keep a calm rhythm, trust their legs, and never stop moving forward. When the clouds finally open and the whole valley appears far below, every tired muscle suddenly feels worth it.",
    "Typing well is a skill that grows with practice, much like learning to play a musical instrument. Beginners often look at the keyboard and press each key with great effort. With time, the fingers learn their places and the mind simply flows from the words on the screen to the words on the page. The secret is not to rush. Focus on accuracy first, keep your wrists relaxed, and let your speed rise naturally. A few minutes of careful practice every day will take you much further than one long, tiring session each week.",
    "Reading is one of the simplest ways to travel without leaving home. A good book can carry you across oceans, back through history, or far into the future, all in a single afternoon. It teaches you how other people think and feel, and it quietly builds your own vocabulary and imagination. Even twenty minutes a day adds up to dozens of books each year. Put your phone aside, find a comfortable chair, and let a story take you somewhere new. You may be surprised by how calm and curious it makes you feel.",
    "Success rarely arrives in one big moment. It is built from small habits repeated day after day, often when nobody is watching. Waking up on time, finishing the work you promised yourself, and learning something new each week may seem ordinary. Yet over months and years, these simple choices change the direction of a life. When progress feels slow, remember that a river carves a canyon not by force, but by persistence. Keep showing up, keep improving a little, and one day you will look back and realize how far you have come.",
    "Rain began to fall softly on the old town just after sunset. The streets filled with the sound of water running along the gutters, and the lamps glowed warmly through the mist. People hurried home with umbrellas tilted against the wind, while a few children laughed and jumped over the puddles. Inside a small cafe, a kettle whistled and the smell of fresh bread drifted through the door. By midnight the storm had passed, leaving the roofs shining and the air cool and clean under a sky full of stars.",
    "Great teams are not built from people who agree on everything. They are built from people who listen to each other, share the work fairly, and celebrate each other's wins. When one member is struggling, the others step in to help without being asked. Communication matters more than talent, and trust matters more than rules. A group that learns to work together can solve problems that no single person could handle alone. The next time you face a difficult task, remember that the tallest peaks are usually climbed by a team roped together.",
    "Technology changes the way we live faster than ever before. A phone in your pocket now holds a library, a map, a camera, and a window to friends across the world. These tools are powerful, but they work best when we stay in control of them. Take breaks from the screen, protect your privacy, and use your time online to learn and create, not only to scroll. Fast and accurate typing is one of the most useful digital skills you can build, because it turns your ideas into words with almost no effort.",
    "Curiosity is the engine of learning. Children ask why about everything, and somewhere along the way many adults forget how to do it. Try to rediscover that habit. Ask how a bridge stays standing, why the sky turns orange at sunset, or what makes a language sound the way it does. Every question you chase teaches you something unexpected and opens a few more doors. You do not need to be an expert to begin. You only need to be willing to wonder, to look closer, and to keep exploring."
  ]
};

const TOPIC_NAMES = ['general', 'biology', 'chemistry', 'physics', 'history', 'geography', 'technology'];
const WORD_COUNTS = [20, 30, 40, 60];

const rand = (n) => Math.floor(Math.random() * n);
const countWords = (s) => s.trim().split(/\s+/).filter(Boolean).length;

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = rand(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Split a passage into sentences (Bangla ends with the danda, English with . ! ?)
function splitSentences(text, lang) {
  const parts = lang === 'bn' ? text.match(/[^\u0964]+\u0964/g) : text.match(/[^.!?]+[.!?]+/g);
  return (parts || [text]).map((s) => s.trim()).filter(Boolean);
}

const PASSAGE_SENTENCES = {
  bn: PASSAGES.bn.map((p) => splitSentences(p, 'bn')),
  en: PASSAGES.en.map((p) => splitSentences(p, 'en'))
};

// Build a fresh text.
//   lang:      'bn' | 'en'
//   topic:     'mix' (random topic) | 'general' | any topic name
//   wordCount: a number (10-400), or anything else for a random 20 / 30 / 40 / 60
//   avoid:     a Set of sentences used recently. They are skipped, so the same text does not come back
//              again and again. (If a topic is nearly used up, the oldest ones may come back.)
// Returns { text, parts } where parts are the sentences used.
function buildTextParts(lang = 'en', topic = 'mix', wordCount, avoid) {
  lang = lang === 'bn' ? 'bn' : 'en';
  const skip = avoid instanceof Set ? avoid : new Set();
  const n = parseInt(wordCount, 10);
  const target = n >= 10 && n <= 400 ? n : WORD_COUNTS[rand(WORD_COUNTS.length)];
  const chosen = TOPIC_NAMES.includes(topic) ? topic : TOPIC_NAMES[rand(TOPIC_NAMES.length)];

  const parts = [];
  const used = new Set();
  let words = 0;
  const enough = () => words >= target * 0.9;
  const add = (sentence) => {
    parts.push(sentence);
    used.add(sentence);
    words += countWords(sentence);
  };

  // consecutive sentences from a random passage (keeps the text readable), starting somewhere fresh
  const fillGeneral = () => {
    let guard = 0;
    while (!enough() && guard++ < 120) {
      const sentences = PASSAGE_SENTENCES[lang][rand(PASSAGE_SENTENCES[lang].length)];
      let i = rand(sentences.length);
      if (guard <= 60 && (skip.has(sentences[i]) || used.has(sentences[i]))) continue;
      for (; i < sentences.length && !enough(); i++) {
        if (used.has(sentences[i])) break;
        const w = countWords(sentences[i]);
        if (words > 0 && words + w > target * 1.25) break;
        add(sentences[i]);
      }
    }
  };

  // random standalone sentences, never the same sentence twice in one text
  const fillFrom = (pool) => {
    for (const sentence of pool) {
      if (enough()) break;
      if (used.has(sentence)) continue;
      const w = countWords(sentence);
      if (words > 0 && words + w > target * 1.25) continue;
      add(sentence);
    }
  };
  const fresh = (pool) => shuffle(pool.filter((x) => !skip.has(x)));
  const stale = (pool) => shuffle(pool.filter((x) => skip.has(x)));

  const own = chosen === 'general' ? [] : TOPICS[lang][chosen];
  const others = TOPIC_NAMES.filter((t) => t !== 'general' && t !== chosen).flatMap((t) => TOPICS[lang][t]);

  if (chosen === 'general') fillGeneral();
  else fillFrom(fresh(own));
  if (!enough()) fillFrom(fresh(others));   // long texts (timed tests) can use the other topics too
  if (!enough()) fillGeneral();
  if (!enough()) fillFrom(stale(own));      // everything fresh is used up: the oldest sentences may return
  if (!enough()) fillFrom(stale(others));

  return { text: parts.join(' '), parts };
}

function buildText(lang, topic, wordCount, avoid) {
  return buildTextParts(lang, topic, wordCount, avoid).text;
}

// 'bn' if the text contains any Bengali-script character, else 'en'
function detectLanguage(text) {
  return /[\u0980-\u09FF]/.test(text) ? 'bn' : 'en';
}

module.exports = { PASSAGES, TOPICS, buildText, buildTextParts, detectLanguage, TOPIC_NAMES };
